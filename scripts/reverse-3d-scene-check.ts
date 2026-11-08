import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { POST } from "../src/app/api/run/[app]/route";
import { getApp } from "../src/lib/config";
import {
  buildSceneMesh,
  orbitFromDrag,
  pickBestSubjectIndex,
  projectPoint,
  readSubject,
  SCENE_CLAY,
  SCENE_DEFAULT_PITCH,
  SCENE_DEFAULT_YAW,
  sceneMvp,
} from "../src/lib/scene-mesh";
import { durationOverCap, readContainerDurationSeconds } from "../src/lib/video-duration";
import { acceptedClipDuration, REVERSE_3D_MAX_SECONDS } from "../src/lib/video-client";
import { buildJobBody } from "../src/lib/workflow";

function paint(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

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

  const flat = paint(60, 34, () => [240, 240, 240]);
  const subject = paint(48, 27, (x, y) => (x > 14 && x < 34 && y > 6 && y < 20 ? [220, 40, 40] : [230, 230, 235]));
  const crowd = paint(60, 36, (x, y) => {
    const col = Math.floor(x / 20);
    const row = Math.floor(y / 18);
    const localX = x % 20;
    const localY = y % 18;
    const on = localX > 4 && localX < 15 && localY > 3 && localY < 14;
    return on ? [40 + col * 40, 30 + row * 50, 200] : [232, 232, 232];
  });
  const product = paint(48, 27, (x, y) => (x > 1 && x < 46 && y > 1 && y < 25 ? [20, 20, 20] : [240, 240, 240]));
  const pair = paint(60, 40, (x, y) => {
    if (x >= 8 && x <= 27 && y >= 4 && y <= 35) return [240, 240, 240];
    if (x >= 42 && x <= 52 && y >= 10 && y <= 22) return [220, 40, 40];
    return [70, 70, 74];
  });
  const subjectRead = readSubject(subject, 48, 27);
  const crowdRead = readSubject(crowd, 60, 36);
  const productRead = readSubject(product, 48, 27);
  const pairRead = readSubject(pair, 60, 40);
  const emptyRead = readSubject(flat, 60, 34);
  assert.ok(subjectRead.clear, JSON.stringify(subjectRead));
  assert.equal(subjectRead.rivals, 1);
  assert.ok(subjectRead.score > crowdRead.score, JSON.stringify({ subject: subjectRead.score, crowd: crowdRead.score }));
  assert.ok(crowdRead.rivals >= 4, `crowd rivals ${crowdRead.rivals}`);
  assert.ok(subjectRead.score > productRead.score, JSON.stringify({ subject: subjectRead.score, product: productRead.score }));
  assert.equal(emptyRead.score, 0);
  assert.equal(pickBestSubjectIndex([subjectRead.score, crowdRead.score, subjectRead.score]), 0);
  assert.equal(pickBestSubjectIndex([1, 4, 4, 2]), 1);

  const steps = [64, 256, 768, 2048, 4096].map((target) => buildSceneMesh(subject, 48, 27, target));
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index].boxesLong >= steps[index - 1].boxesLong);
    assert.ok(steps[index].polygonCount >= steps[index - 1].polygonCount);
  }
  const low = steps[0];
  const high = steps[steps.length - 1];
  assert.ok(high.boxesLong > low.boxesLong, `boxes ${low.boxesLong} → ${high.boxesLong}`);
  assert.ok(high.polygonCount > low.polygonCount);
  assert.ok(high.boxesLong <= Math.ceil(19 * 0.32), `finest boxes ${high.boxesLong} are denser than 30% of the subject`);
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

  const pairMesh = buildSceneMesh(pair, 60, 40, 768);
  let pairMinX = Infinity;
  let pairMaxX = -Infinity;
  let pairMinY = Infinity;
  let pairMaxY = -Infinity;
  const pairSeen = new Uint8Array(pairMesh.positions.length / 3);
  for (const index of pairMesh.indices) pairSeen[index] = 1;
  for (let index = 0; index < pairSeen.length; index += 1) {
    if (!pairSeen[index]) continue;
    const x = pairMesh.positions[index * 3] ?? 0;
    const y = pairMesh.positions[index * 3 + 1] ?? 0;
    pairMinX = Math.min(pairMinX, x);
    pairMaxX = Math.max(pairMaxX, x);
    pairMinY = Math.min(pairMinY, y);
    pairMaxY = Math.max(pairMaxY, y);
  }
  const pairAspect = (pairMaxX - pairMinX) / Math.max(0.001, pairMaxY - pairMinY);
  assert.ok(pairAspect < 0.95, `kept both shapes, aspect ${pairAspect}`);
  assert.ok(pairRead.rivals >= 2);

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
