import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { POST } from "../src/app/api/run/[app]/route";
import { POST as postSubject } from "../src/app/api/reverse-3d/subject/route";
import { getApp } from "../src/lib/config";
import { blockFigureMesh, decodeGlb, encodeGlb, reduceMesh } from "../src/lib/mesh-reduce";
import { decidePublicRequest, isPublicApp } from "../src/lib/public-surface";
import { signAssetId, verifyAssetSignature } from "../src/lib/signing";
import { buildBoxMesh, orbitFromDrag, projectPoint, SCENE_CLAY, SCENE_DEFAULT_PITCH, SCENE_DEFAULT_YAW, sceneMvp } from "../src/lib/scene-mesh";
import { getDeployment } from "../src/lib/deployments";
import {
  BACKGROUND_REMOVAL_DEPLOYMENT_ID,
  backgroundModelForDeployment,
  backgroundModelName,
  buildCutoutWorkflow,
  buildHunyuanWorkflow,
  buildPickWorkflow,
  comboOptions,
  cutoutAssetToken,
  parseSubjectChoice,
  selectMeshOutput,
  selectTextOutput,
  MESH_KEEP_FRACTION,
} from "../src/lib/subject-pipeline";
import { durationOverCap, readContainerDurationSeconds } from "../src/lib/video-duration";
import { acceptedClipDuration, REVERSE_3D_MAX_SECONDS } from "../src/lib/video-client";
import { buildJobBody } from "../src/lib/workflow";

function box(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, "latin1");
  payload.copy(out, 8);
  return out;
}

function mp4(seconds: number): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(1000, 12);
  header.writeUInt32BE(Math.round(seconds * 1000), 16);
  const brand = Buffer.alloc(8);
  brand.write("isom", 0, "latin1");
  return Buffer.concat([box("ftyp", brand), box("moov", box("mvhd", header))]);
}

function sizeVint(value: number): Buffer {
  if (value < 127) return Buffer.from([0x80 | value]);
  return Buffer.from([0x40 | ((value >> 8) & 0x3f), value & 0xff]);
}

function element(id: Buffer, data: Buffer): Buffer {
  return Buffer.concat([id, sizeVint(data.length), data]);
}

function webmWithDuration(seconds: number): Buffer {
  const scale = Buffer.alloc(3);
  scale.writeUIntBE(1_000_000, 0, 3);
  const ticks = Buffer.alloc(8);
  ticks.writeDoubleBE(seconds * 1000);
  const info = element(
    Buffer.from([0x15, 0x49, 0xa9, 0x66]),
    Buffer.concat([element(Buffer.from([0x2a, 0xd7, 0xb1]), scale), element(Buffer.from([0x44, 0x89]), ticks)]),
  );
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]),
    element(Buffer.from([0x18, 0x53, 0x80, 0x67]), info),
  ]);
}

function cluster(timestamp: number, blockRel?: number): Buffer {
  const ts = Buffer.alloc(2);
  ts.writeUInt16BE(timestamp);
  const parts: Buffer[] = [Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0xff]), Buffer.from([0xe7, 0x82]), ts];
  if (blockRel !== undefined) {
    const rel = Buffer.alloc(2);
    rel.writeInt16BE(blockRel);
    parts.push(element(Buffer.from([0xa3]), Buffer.concat([Buffer.from([0x81]), rel, Buffer.from([0x00])])));
  }
  return Buffer.concat(parts);
}

function webmClusters(stamps: Array<{ timestamp: number; blockRel?: number }>): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ...stamps.map((stamp) => cluster(stamp.timestamp, stamp.blockRel)),
  ]);
}

function glbDocument(json: Record<string, unknown>, bin: Buffer): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function renderClip(seconds: number, ext: "mp4" | "webm"): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "reverse-scene-"));
  const file = path.join(dir, `clip.${ext}`);
  const codec =
    ext === "mp4"
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
      : ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8"];
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `color=c=red:s=160x90:r=24`, "-t", String(seconds), ...codec, file],
    { stdio: "ignore" },
  );
  return readFileSync(file);
}

async function postReverse(video: Buffer, scene: Buffer | null, name = "clip.mp4", type = "video/mp4") {
  const form = new FormData();
  form.append("video", new File([new Uint8Array(video)], name, { type }));
  if (scene) form.append("scene", new File([new Uint8Array(scene)], "scene.png", { type: "image/png" }));
  const response = await POST(new Request("http://localhost/api/run/reverse-3d", { method: "POST", body: form }), {
    params: Promise.resolve({ app: "reverse-3d" }),
  });
  const payload = (await response.json()) as {
    jobId?: string;
    error?: { message?: string };
    request?: { workflow?: Record<string, { class_type?: string; inputs: Record<string, unknown> }> };
  };
  return { status: response.status, payload };
}

async function main() {
  assert.equal(REVERSE_3D_MAX_SECONDS, 10);
  assert.deepEqual(acceptedClipDuration(18), { duration: 10, trimmed: true });
  assert.deepEqual(acceptedClipDuration(10), { duration: 10, trimmed: false });
  assert.equal(acceptedClipDuration(10.04).trimmed, false);
  assert.equal(acceptedClipDuration(10.06).duration, 10);
  assert.equal(acceptedClipDuration(10.06).trimmed, true);
  assert.throws(() => acceptedClipDuration(2.9), /at least 3/);

  const pick = buildPickWorkflow(12);
  assert.equal(pick["20"]?.class_type, "GeminiNodeV3");
  assert.equal(pick["21"]?.class_type, "SaveText");
  assert.equal(Object.keys(pick).filter((id) => pick[id]?.class_type === "LoadImage").length, 12);
  for (let index = 1; index <= 12; index += 1) {
    assert.deepEqual(pick["20"]?.inputs[`model.images.image_${index}`], [String(index), 0]);
  }
  assert.match(String(pick["20"]?.inputs["model.prompt"]), /main subject/);
  assert.equal(pick["20"]?.inputs["model.thinking_level"], "MINIMAL");
  assert.equal(pick["20"]?.inputs["model.max_output_tokens"], 1024);
  assert.equal(parseSubjectChoice("frame: 4\nsubject: the armored figure", 12).frame, 3);
  assert.equal(parseSubjectChoice("frame: 4\nsubject: the armored figure", 12).subject, "the armored figure");
  assert.equal(parseSubjectChoice("Sure.\nframe: 2\nsubject: red mug\nThanks", 4).subject, "red mug");
  assert.throws(() => parseSubjectChoice("a person in the middle", 12), /choose a frame/);
  assert.throws(() => parseSubjectChoice("frame: 13\nsubject: someone", 12), /not sampled/);
  assert.equal(selectMeshOutput([{ id: "png", name: "preview.png" }, { id: "mesh", name: "hunyuan.glb" }])?.id, "mesh");
  assert.equal(selectMeshOutput([{ id: "png", name: "preview.png" }]), null);
  assert.equal(selectMeshOutput([{ id: "mesh", name: "GLB" }])?.id, "mesh");
  assert.equal(selectTextOutput([{ id: "png", name: "frame.png" }, { id: "text", name: "subject_00001_.txt" }])?.id, "text");
  const cutoutId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cutoutToken = cutoutAssetToken(cutoutId);
  assert.equal(verifyAssetSignature(cutoutToken, signAssetId(cutoutToken)), true);
  assert.equal(isPublicApp("reverse-3d-cutout"), false);
  assert.equal(decidePublicRequest("GET", `/api/outputs/${cutoutToken}`).action, "deny");
  assert.equal(decidePublicRequest("GET", `/api/jobs/background-removal~${cutoutId}`).action, "deny");
  assert.equal(decidePublicRequest("GET", "/api/reverse-3d/subject").action, "allow");
  assert.equal(decidePublicRequest("POST", "/api/run/background-removal").action, "deny");

  assert.deepEqual(
    comboOptions(
      { LoadBackgroundRemovalModel: { input: { required: { bg_removal_name: [["birefnet.safetensors"], { tooltip: "x" }] } } } },
      "bg_removal_name",
    ),
    ["birefnet.safetensors"],
  );
  assert.deepEqual(comboOptions({ input: { required: { bg_removal_name: [[]] } } }, "bg_removal_name"), []);
  assert.throws(() => backgroundModelName([]), /no background-removal model/);
  assert.equal(backgroundModelName(["birefnet.safetensors"]), "birefnet.safetensors");
  assert.equal(backgroundModelName(["BiRefNet-general.safetensors"]), "BiRefNet-general.safetensors");
  assert.equal(getDeployment("background-removal")?.deploymentId, BACKGROUND_REMOVAL_DEPLOYMENT_ID);
  assert.equal(backgroundModelForDeployment(BACKGROUND_REMOVAL_DEPLOYMENT_ID, null), "birefnet.safetensors");
  assert.equal(backgroundModelForDeployment(BACKGROUND_REMOVAL_DEPLOYMENT_ID, ["BiRefNet-general.safetensors"]), "BiRefNet-general.safetensors");
  assert.throws(() => backgroundModelForDeployment(BACKGROUND_REMOVAL_DEPLOYMENT_ID, []), /no background-removal model/);
  assert.throws(() => backgroundModelForDeployment("dep-a166b403-62ba-4598-adeb-708471c20c8c", null), /Could not read/);

  const otherCutout = buildCutoutWorkflow(backgroundModelName(["BiRefNet-general.safetensors"]));
  assert.equal(otherCutout["2"]?.inputs.bg_removal_name, "BiRefNet-general.safetensors");
  assert.equal(JSON.stringify(otherCutout).includes("birefnet.safetensors"), false);

  const cutoutGraph = buildCutoutWorkflow(backgroundModelName(["birefnet.safetensors"]));
  assert.equal(cutoutGraph["2"]?.class_type, "LoadBackgroundRemovalModel");
  assert.equal(cutoutGraph["2"]?.inputs.bg_removal_name, "birefnet.safetensors");
  assert.equal(cutoutGraph["3"]?.class_type, "RemoveBackground");
  assert.deepEqual(cutoutGraph["3"]?.inputs.image, ["1", 0]);
  assert.equal(cutoutGraph["5"]?.class_type, "JoinImageWithAlpha");
  assert.equal(cutoutGraph["6"]?.class_type, "SaveImage");

  const meshGraph = buildHunyuanWorkflow();
  assert.equal(meshGraph["2"], undefined);
  assert.equal(JSON.stringify(meshGraph).includes("LoadBackgroundRemovalModel"), false);
  assert.equal(JSON.stringify(meshGraph).includes("birefnet"), false);
  assert.equal(meshGraph["21"]?.class_type, "TencentImageToModelNode");
  assert.equal(meshGraph["21"]?.inputs.generate_type, "Geometry");
  assert.deepEqual(meshGraph["21"]?.inputs.image, ["1", 0]);

  const source = blockFigureMesh();
  const reduced = reduceMesh(source);
  const ratio = reduced.reducedFaces / reduced.sourceFaces;
  assert.ok(Math.abs(ratio - MESH_KEEP_FRACTION) < 0.12, `kept ${ratio} of ${reduced.sourceFaces} faces`);
  assert.ok(reduced.reducedFaces < reduced.sourceFaces);
  const roundTrip = decodeGlb(encodeGlb(reduced));
  assert.equal(roundTrip.indices.length, reduced.indices.length);
  const padded = Buffer.concat([Buffer.alloc(12), Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)]);
  const offsetGlb = glbDocument(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: padded.length + 3 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: padded.length },
        { buffer: 0, byteOffset: padded.length, byteLength: 3 },
      ],
      accessors: [
        { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5121, count: 3, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    },
    Buffer.concat([padded, Buffer.from([0, 1, 2])]),
  );
  const offsetMesh = decodeGlb(offsetGlb);
  assert.equal(offsetMesh.positions[3], 1);
  assert.deepEqual(Array.from(offsetMesh.indices), [0, 1, 2]);
  const strideBin = Buffer.alloc(16 * 3 + 12);
  const strideFloats = [0, 0, 0, 2, 0, 0, 0, 3, 0];
  for (let index = 0; index < 3; index += 1) {
    strideBin.writeFloatLE(strideFloats[index * 3] ?? 0, index * 16);
    strideBin.writeFloatLE(strideFloats[index * 3 + 1] ?? 0, index * 16 + 4);
    strideBin.writeFloatLE(strideFloats[index * 3 + 2] ?? 0, index * 16 + 8);
  }
  strideBin.writeUInt32LE(0, 48);
  strideBin.writeUInt32LE(1, 52);
  strideBin.writeUInt32LE(2, 56);
  const strideMesh = decodeGlb(
    glbDocument(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: strideBin.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 48, byteStride: 16 },
          { buffer: 0, byteOffset: 48, byteLength: 12 },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
          { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      },
      strideBin,
    ),
  );
  assert.equal(strideMesh.positions[3], 2);
  assert.equal(strideMesh.positions[7], 3);
  const first = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const second = new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0]);
  const both = Buffer.concat([Buffer.from(first.buffer), Buffer.from(second.buffer), Buffer.from(new Uint16Array([0, 1, 2, 0, 1, 2]).buffer)]);
  const merged = decodeGlb(
    glbDocument(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: both.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 36 },
          { buffer: 0, byteOffset: 72, byteLength: 6 },
          { buffer: 0, byteOffset: 78, byteLength: 6 },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
          { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
          { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
          { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
        ],
        meshes: [
          {
            primitives: [
              { attributes: { POSITION: 0 }, indices: 2 },
              { attributes: { POSITION: 1 }, indices: 3 },
            ],
          },
        ],
      },
      both,
    ),
  );
  assert.equal(merged.positions.length / 3, 6);
  assert.deepEqual(Array.from(merged.indices), [0, 1, 2, 3, 4, 5]);
  assert.throws(() => decodeGlb(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), /image, not a 3D mesh/);

  const steps = [64, 256, 768, 2048, 4096].map((target) => buildBoxMesh(reduced.positions, reduced.indices, target));
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index].boxesLong >= steps[index - 1].boxesLong);
    assert.ok(steps[index].polygonCount >= steps[index - 1].polygonCount);
  }
  const low = steps[0];
  const high = steps[steps.length - 1];
  assert.ok(high.boxesLong > low.boxesLong, `boxes ${low.boxesLong} → ${high.boxesLong}`);
  assert.ok(high.polygonCount > low.polygonCount);
  assert.ok(high.boxesLong <= 24, `finest boxes ${high.boxesLong} are not chunky`);
  assert.ok(low.boxesLong <= Math.ceil(high.boxesLong * 0.55));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let frontNormal = 0;
  let backNormal = 0;
  const seen = new Uint8Array(low.positions.length / 3);
  for (const index of low.indices) seen[index] = 1;
  for (let index = 0; index < seen.length; index += 1) {
    if (!seen[index]) continue;
    const offset = index * 3;
    const x = low.positions[offset] ?? 0;
    const y = low.positions[offset + 1] ?? 0;
    const z = low.positions[offset + 2] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    const nx = Math.abs(low.normals[offset] ?? 0);
    const ny = Math.abs(low.normals[offset + 1] ?? 0);
    const nz = Math.abs(low.normals[offset + 2] ?? 0);
    assert.ok(Math.max(nx, ny, nz) > 0.99, `normal is not a box face ${nx} ${ny} ${nz}`);
    if (z > 0.05) frontNormal += low.normals[offset + 2] ?? 0;
    if (z < -0.05) backNormal += low.normals[offset + 2] ?? 0;
    assert.ok(Math.abs((low.colors[offset] ?? 0) - SCENE_CLAY[0]) < 0.001);
    assert.ok(Math.abs((low.colors[offset + 2] ?? 0) - SCENE_CLAY[2]) < 0.001);
  }
  const aspect = (maxX - minX) / Math.max(0.001, maxY - minY);
  assert.ok(aspect < 1.7, `subject aspect ${aspect} still looks like the whole frame`);
  assert.ok(maxZ - minZ > 0.2, `thickness ${maxZ - minZ}`);
  assert.ok(minZ < -0.05 && maxZ > 0.05, `volume z ${minZ}..${maxZ}`);
  assert.ok(frontNormal > 0 && backNormal < 0, `normals front ${frontNormal} back ${backNormal}`);
  assert.ok(Math.abs(low.floorY - minY) < 1e-4);

  let bulge = 0;
  let bulgeX = 0;
  let bulgeY = 0;
  let bulgeZ = 0;
  for (let index = 0; index < seen.length; index += 1) {
    if (!seen[index]) continue;
    const z = low.positions[index * 3 + 2] ?? 0;
    if (z > bulge) {
      bulge = z;
      bulgeX = low.positions[index * 3] ?? 0;
      bulgeY = low.positions[index * 3 + 1] ?? 0;
      bulgeZ = z;
    }
  }
  const resting = projectPoint(sceneMvp(SCENE_DEFAULT_YAW, SCENE_DEFAULT_PITCH, 16 / 9), bulgeX, bulgeY, bulgeZ, 960, 540);
  const dragged = orbitFromDrag(SCENE_DEFAULT_YAW, SCENE_DEFAULT_PITCH, 140, -30);
  const turned = projectPoint(sceneMvp(dragged.yaw, dragged.pitch, 16 / 9), bulgeX, bulgeY, bulgeZ, 960, 540);
  assert.notEqual(dragged.yaw, SCENE_DEFAULT_YAW);
  assert.ok(resting.visible && turned.visible, JSON.stringify({ resting, turned }));
  assert.ok(Math.abs(resting.x - turned.x) > 15, JSON.stringify({ resting, turned, dragged }));
  console.log(
    `boxes ${steps.map((mesh) => mesh.boxesLong).join(" → ")}; triangles ${steps.map((mesh) => mesh.polygonCount).join(" → ")}; orbit x ${resting.x.toFixed(1)} → ${turned.x.toFixed(1)} after a 140px drag`,
  );

  assert.equal(durationOverCap(10.2, 10), false);
  assert.equal(durationOverCap(10.5, 10), true);
  assert.ok((readContainerDurationSeconds(mp4(8)) ?? 0) < 10.25);
  assert.ok((readContainerDurationSeconds(mp4(18)) ?? 0) > 10.25);
  assert.ok((readContainerDurationSeconds(webmWithDuration(4)) ?? 0) < 10.25);
  assert.ok((readContainerDurationSeconds(webmWithDuration(12)) ?? 0) > 10.25);
  const clustered = readContainerDurationSeconds(webmClusters([{ timestamp: 0 }, { timestamp: 12000 }]));
  assert.ok(clustered !== null && clustered > 10.25, `cluster duration ${clustered}`);
  const blocked = readContainerDurationSeconds(webmClusters([{ timestamp: 0, blockRel: 4000 }]));
  assert.ok(blocked !== null && blocked < 10.25 && blocked > 3, `block duration ${blocked}`);
  const chrome = readContainerDurationSeconds(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/chrome-media-recorder-720x406.webm")),
  );
  assert.ok(chrome !== null && chrome < 3, `chrome media recorder fixture read as ${chrome}s`);

  const clip4 = renderClip(4, "mp4");
  const clip12 = renderClip(12, "mp4");
  const webm4 = renderClip(4, "webm");
  const webm12 = renderClip(12, "webm");
  assert.ok((readContainerDurationSeconds(clip4) ?? 99) <= 10.25);
  assert.ok((readContainerDurationSeconds(clip12) ?? 0) > 10.25);
  assert.ok((readContainerDurationSeconds(webm4) ?? 99) <= 10.25);
  assert.ok((readContainerDurationSeconds(webm12) ?? 0) > 10.25);

  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  process.env.COMFY_MOCK = "1";

  const missing = await postReverse(clip4, null);
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error?.message ?? "", /3D scene reference/);

  const tooLong = await postReverse(clip12, png);
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.payload.error?.message ?? "", /over 10 seconds/);

  const webmLong = await postReverse(webm12, png, "clip.webm", "video/webm");
  assert.equal(webmLong.status, 400);
  assert.match(webmLong.payload.error?.message ?? "", /over 10 seconds/);

  const bare = box("ftyp", Buffer.from("isom\0\0\0\0"));
  const unreadable = await postReverse(bare, png);
  assert.equal(unreadable.status, 400);
  assert.match(unreadable.payload.error?.message ?? "", /length/);

  const ok = await postReverse(clip4, png);
  assert.equal(ok.status, 200, JSON.stringify(ok.payload.error ?? ok.payload));
  const workflow = ok.payload.request?.workflow;
  assert.ok(workflow);
  assert.equal(workflow["12"]?.class_type, "LoadImage");
  assert.equal((workflow["12"]?.inputs.image as { info?: { file_path?: string } })?.info?.file_path, "scene.png");
  assert.deepEqual(workflow["20"]?.inputs["model.reference_images.image_1"], ["12", 0]);
  assert.match(String(workflow["20"]?.inputs["model.prompt"]), /@Image1/);
  assert.deepEqual(workflow["20"]?.inputs["model.video_1"], ["16", 0]);

  const subjectForm = new FormData();
  subjectForm.set("step", "pick");
  subjectForm.set("times", "0.4,1.2");
  subjectForm.append("frame", new File([new Uint8Array(png)], "frame_1.jpg", { type: "image/jpeg" }));
  subjectForm.append("frame", new File([new Uint8Array(png)], "frame_2.jpg", { type: "image/jpeg" }));
  const subjectResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: subjectForm }));
  const subjectBody = (await subjectResponse.json()) as {
    subject?: string;
    sourceFaces?: number;
    reducedFaces?: number;
    positions?: number[];
    mock?: boolean;
    pick?: Record<string, { class_type?: string }>;
    mesh?: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    cutout?: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    error?: { message?: string };
  };
  assert.equal(subjectResponse.status, 200, JSON.stringify(subjectBody.error));
  assert.equal(subjectBody.subject, "The main subject");
  assert.equal(subjectBody.pick?.["20"]?.class_type, "GeminiNodeV3");
  assert.equal(subjectBody.mesh?.["21"]?.class_type, "TencentImageToModelNode");
  assert.equal(subjectBody.mesh?.["2"], undefined);
  assert.equal(JSON.stringify(subjectBody.mesh).includes("birefnet"), false);
  assert.equal(subjectBody.cutout?.["2"]?.class_type, "LoadBackgroundRemovalModel");
  assert.equal(subjectBody.cutout?.["2"]?.inputs?.bg_removal_name, "birefnet.safetensors");
  assert.ok((subjectBody.reducedFaces ?? 0) < (subjectBody.sourceFaces ?? 0));
  assert.ok((subjectBody.positions?.length ?? 0) > 9);
  assert.equal(subjectBody.mock, true);

  const cutoutForm = new FormData();
  cutoutForm.set("step", "cutout");
  cutoutForm.append("frame", new File([new Uint8Array(png)], "frame_1.jpg", { type: "image/jpeg" }));
  const cutoutResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: cutoutForm }));
  const cutoutBody = (await cutoutResponse.json()) as { mock?: boolean; jobId?: string; positions?: number[]; error?: { message?: string } };
  assert.equal(cutoutResponse.status, 200, JSON.stringify(cutoutBody.error));
  assert.equal(cutoutBody.mock, true);
  assert.equal(cutoutBody.jobId, undefined);
  assert.equal(JSON.stringify(cutoutBody).includes("background-removal"), false);
  const routeSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/app/api/reverse-3d/subject/route.ts"), "utf8");
  assert.equal(routeSource.includes("waitForCutout"), false);
  assert.equal(routeSource.includes("40_000"), false);

  const app = getApp("reverse-3d");
  assert.ok(app);
  assert.throws(
    () =>
      buildJobBody(
        app,
        { video: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filePath: "input.mp4" } },
        { seed: 1, hasImage: true },
        null,
      ),
    /image/,
  );

  console.log("reverse-3d-scene-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
