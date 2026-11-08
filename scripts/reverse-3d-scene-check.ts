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
import { mapJob } from "../src/lib/comfy";
import { blockFigureMesh, decodeGlb, encodeGlb, reduceMesh } from "../src/lib/mesh-reduce";
import { decidePublicRequest, isPublicApp } from "../src/lib/public-surface";
import { signAssetId, verifyAssetSignature } from "../src/lib/signing";
import {
  buildBoxMesh,
  layoutFrameScene,
  orbitFromDrag,
  partBoxesMesh,
  projectPoint,
  SCENE_CLAY,
  SCENE_DEFAULT_PITCH,
  SCENE_DEFAULT_YAW,
  sceneMvp,
} from "../src/lib/scene-mesh";
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
  MOCK_SCENE_REPLY,
  parseSubjectChoice,
  parseSubjectScene,
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
  assert.match(String(pick["20"]?.inputs["model.prompt"]), /"parts": \[\{"name": "head", "a": \[y, x\], "b": \[y, x\]/);
  assert.match(String(pick["20"]?.inputs["model.prompt"]), /"props": \[\{"name": "table", "a": \[y, x\], "b": \[y, x\]/);
  assert.match(String(pick["20"]?.inputs["model.prompt"]), /from 1 to 12/);
  assert.equal(pick["20"]?.inputs["model.thinking_level"], "LOW");
  assert.equal(pick["20"]?.inputs["model.max_output_tokens"], 8192);
  // No image-to-3D step: the pick job is the whole 3D toy.
  assert.equal(JSON.stringify(pick).includes("Tencent"), false);

  const scene = parseSubjectScene(
    [
      "```json",
      "{",
      '  "frame": 3,',
      '  "subject": "a dancer",',
      '  "parts": [',
      '    {"name": "torso", "a": [300, 500], "b": [520, 505], "w": 0.6, "d": 0.5, "z": 0},',
      '    {"name": "head", "a": [290, 500], "b": [180, 502], "z": 1.4},',
      '    {"name": "dot", "a": [400, 400], "b": [401, 401], "w": 0.5},',
      '    {"name": "no end", "a": [400, 400]},',
      '    {"name": "  ", "a": [520, 480], "b": [700, -40], "w": 9, "d": -2, "z": -3}',
      "  ],",
      '  "props": [',
      '    {"name": "chair", "box_2d": [800, 700, 560, 520], "d": 0.9, "z": -1},',
      '    {"name": "speck", "box_2d": [500, 500, 502, 600]},',
      '    {"name": "board", "a": [300, 300], "b": [520, 560], "w": 0.25, "d": 0.15, "z": 1},',
      '    {"name": "flat board", "a": [300, 300], "b": [301, 301]}',
      "  ]",
      "}",
      "```",
    ].join("\r\n"),
    6,
  );
  assert.equal(scene.frame, 2);
  assert.equal(scene.subject, "a dancer");
  assert.deepEqual(scene.parts.map((part) => part.name), ["torso", "head", "part"]);
  assert.deepEqual(scene.parts[1], { name: "head", a: [290, 500], b: [180, 502], w: 0.4, d: 0.8, z: 1 }, "defaults and a rounded side");
  assert.deepEqual(scene.parts[2], { name: "part", a: [520, 480], b: [700, 0], w: 3, d: 0.8, z: -1 }, "points and ratios are clamped");
  assert.deepEqual(scene.props, [
    { name: "chair", box: [560, 520, 800, 700], d: 0.9, z: -1 },
    { name: "board", a: [300, 300], b: [520, 560], w: 0.25, d: 0.15, z: 1 },
  ]);
  const cutShort = parseSubjectScene(
    '{"frame": 1, "subject": "a dog", "parts": [{"name": "body", "a": [500, 300], "b": [500, 600], "w": 0.5}, {"name": "head", "a": [480, 620], "b": [4',
    4,
  );
  assert.deepEqual(cutShort.parts.map((part) => part.name), ["body"], "a reply cut short keeps the parts it finished");
  assert.equal(cutShort.subject, "a dog");
  const cutInProps = parseSubjectScene(
    '{"frame": 1, "subject": "a skater", "parts": [{"name": "torso", "a": [200, 500], "b": [480, 500], "w": 0.5}], "props": [{"name": "board", "a": [290, 300], "b": [520, 560], "w": 0.25, "d": 0.15, "z": 1}, {"name": "bag", "a": [6',
    4,
  );
  assert.deepEqual(cutInProps.parts.map((part) => part.name), ["torso"]);
  assert.deepEqual(cutInProps.props.map((prop) => prop.name), ["board"], "an object after the props key is a prop, not a part");
  assert.throws(() => parseSubjectScene('{"frame": 1, "subject": "a cat", "parts": []}', 4), /did not mark any parts/);
  assert.throws(
    () => parseSubjectScene('{"frame": 1, "subject": "a cat", "parts": [], "props": [{"name": "wall", "box_2d": [0, 0, 900, 900]}]}', 4),
    /did not mark any parts/,
  );
  const crowd = JSON.stringify({
    frame: 1,
    subject: "a crowd",
    parts: Array.from({ length: 30 }, (_, index) => ({ name: `p${index}`, a: [100 + index * 20, 400], b: [110 + index * 20, 420] })),
    props: Array.from({ length: 6 }, (_, index) => ({ name: `box${index}`, box_2d: [700, index * 100, 800, index * 100 + 80] })),
  });
  assert.equal(parseSubjectScene(crowd, 4).parts.length, 16);
  assert.equal(parseSubjectScene(crowd, 4).props.length, 3);

  const mockScene = parseSubjectScene(MOCK_SCENE_REPLY, 12);
  const wide = 16 / 9;
  const laid = layoutFrameScene(mockScene, wide);
  assert.equal(laid.boxes.length, mockScene.parts.length + mockScene.props.length);
  assert.ok(laid.boxes.some((box) => box.kind === "prop" && box.name === "table"));
  const extent = (box: (typeof laid.boxes)[number]) => {
    const cos = Math.abs(Math.cos(box.rotation ?? 0));
    const sin = Math.abs(Math.sin(box.rotation ?? 0));
    return { halfX: (cos * box.size[0] + sin * box.size[1]) / 2, halfY: (sin * box.size[0] + cos * box.size[1]) / 2 };
  };
  const partBoxes = laid.boxes.filter((box) => box.kind === "part");
  const lowest = Math.min(...partBoxes.map((box) => box.center[1] - extent(box).halfY));
  const highest = Math.max(...partBoxes.map((box) => box.center[1] + extent(box).halfY));
  assert.ok(Math.abs(lowest - laid.floorY) < 1e-6, "the subject stands on the floor");
  assert.ok(Math.abs(highest - lowest - 1.55) < 1e-6, "the subject is 1.55 tall");
  assert.ok(Math.abs(lowest + highest) < 1e-6, "the subject is centred on the orbit target");
  assert.equal(laid.cropped, false);
  const head = laid.boxes.find((box) => box.name === "head");
  const forearm = laid.boxes.find((box) => box.name === "left forearm");
  assert.ok(head && forearm);
  assert.ok(Math.abs(head.rotation ?? 0) < 0.05, "an upright head is not turned");
  assert.ok(forearm.center[2] > 0, "a part marked closer sits in front of the body");
  const table = laid.boxes.find((box) => box.name === "table");
  assert.ok(table && table.center[2] < 0, "a prop marked farther sits behind the subject");
  const level = layoutFrameScene({ parts: [{ name: "arm", a: [500, 200], b: [500, 600], w: 0.3, d: 1, z: 0 }], props: [] }, wide);
  assert.ok(Math.abs(Math.abs(level.boxes[0]!.rotation ?? 0) - Math.PI / 2) < 1e-6, "a level limb lies on its side");

  // Seen from the starting camera, a point on the subject lines up with the same point on the frame behind it.
  assert.ok(laid.plate && laid.camera);
  const { plate, camera } = laid;
  assert.ok(plate.center[2] < Math.min(...laid.boxes.map((box) => box.center[2] - box.size[2] / 2)), "the frame hangs behind every block");
  const look = (point: [number, number, number]) => {
    const depth = camera.distance - (point[2] - camera.target[2]);
    return [(point[0] - camera.target[0]) / depth, (point[1] - camera.target[1]) / depth];
  };
  const onPlate = (y: number, x: number): [number, number, number] => [
    plate.center[0] + (x / 1000 - 0.5) * plate.size[0],
    plate.center[1] + (0.5 - y / 1000) * plate.size[1],
    plate.center[2],
  ];
  const torsoPart = mockScene.parts.find((part) => part.name === "torso")!;
  const torso = laid.boxes.find((box) => box.name === "torso")!;
  const middle: [number, number] = [(torsoPart.a[0] + torsoPart.b[0]) / 2, (torsoPart.a[1] + torsoPart.b[1]) / 2];
  const [seenX, seenY] = look([torso.center[0], torso.center[1], 0]);
  const [plateX, plateY] = look(onPlate(middle[0], middle[1]));
  assert.ok(Math.abs(seenX! - plateX!) < 1e-9 && Math.abs(seenY! - plateY!) < 1e-9, "the torso lines up with the frame");
  const forearmPart = mockScene.parts.find((part) => part.name === "left forearm")!;
  const forearmMiddle: [number, number] = [(forearmPart.a[0] + forearmPart.b[0]) / 2, (forearmPart.a[1] + forearmPart.b[1]) / 2];
  const [nearX, nearY] = look(forearm.center);
  const [nearPlateX, nearPlateY] = look(onPlate(forearmMiddle[0], forearmMiddle[1]));
  assert.ok(Math.abs(nearX! - nearPlateX!) < 1e-9 && Math.abs(nearY! - nearPlateY!) < 1e-9, "a part in front still lines up with the frame");
  const torsoFlat = layoutFrameScene({ parts: [{ ...torsoPart, z: 0 }], props: [] }, wide).boxes[0]!;
  const nearTorso = layoutFrameScene({ parts: [{ ...torsoPart, z: 1 }], props: [] }, wide).boxes[0]!;
  assert.ok(nearTorso.size[1] < torsoFlat.size[1], "a part moved toward the camera shrinks to keep its outline on the frame");
  assert.ok(Math.abs(plate.size[0] / plate.size[1] - wide) < 1e-9, "the frame keeps its shape");

  const sitting = layoutFrameScene(
    {
      parts: [
        { name: "torso", a: [400, 500], b: [700, 500], w: 0.5, d: 0.6, z: 0 },
        { name: "legs", a: [700, 500], b: [1000, 520], w: 0.4, d: 1, z: 0 },
      ],
      props: [
        { name: "the room", box: [0, 0, 1000, 1000], d: 1, z: -1 },
        { name: "pole", box: [0, 300, 1000, 330], d: 1, z: 0 },
        { name: "bag", box: [800, 600, 950, 700], d: 0.6, z: 1 },
        { name: "wall", a: [500, 0], b: [500, 1000], w: 0.6, d: 0.2, z: -1 },
        { name: "board", a: [450, 380], b: [700, 560], w: 0.25, d: 0.15, z: 1 },
      ],
    },
    wide,
  );
  assert.equal(sitting.cropped, true, "a subject cut off at the bottom of the frame has no floor");
  assert.deepEqual(
    sitting.boxes.filter((box) => box.kind === "prop").map((box) => box.name),
    ["bag", "board"],
    "the background, a tall pole and a wall across the frame are dropped",
  );
  const board = sitting.boxes.find((box) => box.name === "board")!;
  assert.ok(Math.abs(board.rotation ?? 0) > 0.3, "a board held at a slant stays slanted");
  assert.ok(board.center[2] > 0, "a board held in front sits in front");

  // Props standing on the floor get their depth from where their bottom meets it, whatever side the model gave.
  const room = layoutFrameScene(
    {
      parts: mockScene.parts,
      props: [
        { name: "near stool", a: [960, 300], b: [760, 300], w: 0.5, d: 1, z: -1 },
        { name: "far table", a: [840, 700], b: [700, 700], w: 0.8, d: 1, z: 1 },
        { name: "guitar", a: [300, 620], b: [520, 420], w: 0.35, d: 0.3, z: 1 },
      ],
    },
    wide,
  );
  const leaning = layoutFrameScene({ parts: mockScene.parts, props: [{ name: "chair", a: [900, 640], b: [700, 655], w: 0.5, d: 1, z: 0 }] }, wide);
  assert.equal(leaning.boxes.find((box) => box.name === "chair")?.rotation, 0, "a chair marked a few degrees off plumb stands straight");
  const bottomOf = (box: (typeof room.boxes)[number]) => box.center[1] - extent(box).halfY;
  const nearStool = room.boxes.find((box) => box.name === "near stool")!;
  const farTable = room.boxes.find((box) => box.name === "far table")!;
  const guitar = room.boxes.find((box) => box.name === "guitar")!;
  assert.ok(Math.abs(bottomOf(nearStool) - room.floorY) < 1e-9, "a stool lower in the frame stands on the floor");
  assert.ok(Math.abs(bottomOf(farTable) - room.floorY) < 1e-9, "a table higher in the frame stands on the floor");
  assert.ok(nearStool.center[2] + nearStool.size[2] / 2 > 0, "lower in the frame is closer to the camera");
  assert.ok(farTable.center[2] + farTable.size[2] / 2 < 0, "higher in the frame is farther away");
  assert.ok(guitar.center[2] > 0 && bottomOf(guitar) > room.floorY + 0.3, "a held guitar keeps its side and stays off the floor");
  const stoolFront: [number, number, number] = [nearStool.center[0], nearStool.center[1], nearStool.center[2] + nearStool.size[2] / 2];
  const [stoolX, stoolY] = look(stoolFront);
  const [stoolPlateX, stoolPlateY] = look(onPlate(860, 300));
  assert.ok(Math.abs(stoolX! - stoolPlateX!) < 1e-9 && Math.abs(stoolY! - stoolPlateY!) < 1e-9, "the stool's front face lines up with the frame");
  assert.throws(() => layoutFrameScene({ parts: [], props: [] }, wide), /did not mark any parts/);

  const boxMesh = partBoxesMesh(laid);
  assert.equal(boxMesh.positions.length, laid.boxes.length * 8 * 3);
  assert.equal(boxMesh.indices.length, laid.boxes.length * 36);
  const levelMesh = partBoxesMesh(level);
  const xs = Array.from({ length: 8 }, (_, index) => levelMesh.positions[index * 3]!);
  const levelBox = level.boxes[0]!;
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - levelBox.size[1]) < 1e-5, "the mesh turns the box with the limb");
  assert.equal(parseSubjectChoice("frame: 4\nsubject: the armored figure", 12).frame, 3);
  assert.equal(parseSubjectChoice("frame: 4\nsubject: the armored figure", 12).subject, "the armored figure");
  assert.equal(parseSubjectChoice("Sure.\nframe: 2\nsubject: red mug\nThanks", 4).subject, "red mug");
  assert.throws(() => parseSubjectChoice("a person in the middle", 12), /choose a frame/);
  assert.throws(() => parseSubjectChoice("frame: 13\nsubject: someone", 12), /not sampled/);
  assert.equal(selectMeshOutput([{ id: "png", name: "preview.png" }, { id: "mesh", name: "hunyuan.glb" }])?.id, "mesh");
  assert.equal(selectMeshOutput([{ id: "png", name: "preview.png" }]), null);
  assert.equal(selectMeshOutput([{ id: "mesh", name: "GLB" }]), null);
  assert.equal(
    selectMeshOutput([{ id: "mesh", name: "model", type: "file", contentType: "model/gltf-binary" }])?.id,
    "mesh",
  );
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
  assert.equal(meshGraph["22"]?.class_type, "TencentImageToModelNode");
  assert.equal(meshGraph["22"]?.inputs.generate_type, "Geometry");
  assert.deepEqual(meshGraph["22"]?.inputs.image, ["1", 0]);
  assert.equal(meshGraph["21"]?.class_type, "SaveGLB");
  assert.deepEqual(meshGraph["21"]?.inputs.mesh, ["22", 1]);
  assert.notDeepEqual(meshGraph["21"]?.inputs.mesh, ["22", 0]);
  assert.equal(getApp("reverse-3d")?.output.node, "21");

  const paidJob = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/hunyuan-paid-job.json"), "utf8"),
  ) as { id: string; status: string; outputs: []; error: null };
  const paidLogs = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/hunyuan-paid-logs.json"), "utf8"),
  ) as { text: string; complete: boolean };
  assert.deepEqual(paidJob.outputs, []);
  assert.equal(paidJob.error, null);
  const paidView = mapJob({ id: paidJob.id, status: paidJob.status, outputs: paidJob.outputs, error: paidJob.error });
  assert.equal(paidView.status, "succeeded");
  assert.equal(paidView.error, null);
  assert.deepEqual(paidView.outputs, []);
  assert.equal(selectMeshOutput(paidView.outputs), null);
  assert.equal(paidLogs.complete, true);
  assert.equal(/\.glb|https?:\/\//i.test(paidLogs.text), false);
  const committed = mapJob({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "succeeded",
    outputs: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        node_id: "21",
        name: "mesh_00001.glb",
        type: "file",
        content_type: "model/gltf-binary",
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        node_id: "21",
        name: "preview.png",
        type: "image",
        content_type: "image/png",
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        node_id: "21",
        name: "notes.bin",
        type: "file",
        content_type: "application/octet-stream",
      },
    ],
  });
  assert.equal(selectMeshOutput(committed.outputs)?.id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(selectMeshOutput(committed.outputs)?.type, "file");
  assert.equal(selectMeshOutput([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "preview.png", type: "image" }]), null);

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

  // The video job runs in parallel with the 3D subject, so it needs no scene image.
  const videoOnly = await postReverse(clip4, null);
  assert.equal(videoOnly.status, 200, JSON.stringify(videoOnly.payload.error ?? videoOnly.payload));

  // Any length is accepted: the workflow keeps the first 10 seconds itself.
  const longMp4 = await postReverse(clip12, null);
  assert.equal(longMp4.status, 200, JSON.stringify(longMp4.payload.error ?? longMp4.payload));
  const longWebm = await postReverse(webm12, null, "clip.webm", "video/webm");
  assert.equal(longWebm.status, 200, JSON.stringify(longWebm.payload.error ?? longWebm.payload));

  const ok = await postReverse(clip4, png);
  assert.equal(ok.status, 200, JSON.stringify(ok.payload.error ?? ok.payload));
  const workflow = ok.payload.request?.workflow;
  assert.ok(workflow);
  assert.equal(workflow["12"], undefined);
  assert.equal(workflow["11"]?.class_type, "Video Slice");
  assert.equal(workflow["11"]?.inputs.duration, 10);
  assert.deepEqual(workflow["15"]?.inputs.video, ["11", 0]);
  assert.equal(workflow["20"]?.inputs["model.reference_images.image_1"], undefined);
  assert.doesNotMatch(String(workflow["20"]?.inputs["model.prompt"]), /@Image1/);
  assert.deepEqual(workflow["20"]?.inputs["model.video_1"], ["16", 0]);

  const subjectForm = new FormData();
  subjectForm.set("step", "pick");
  subjectForm.set("times", "0.4,1.2");
  subjectForm.append("frame", new File([new Uint8Array(png)], "frame_1.jpg", { type: "image/jpeg" }));
  subjectForm.append("frame", new File([new Uint8Array(png)], "frame_2.jpg", { type: "image/jpeg" }));
  const subjectResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: subjectForm }));
  const subjectBody = (await subjectResponse.json()) as {
    subject?: string;
    time?: number;
    reply?: string;
    positions?: number[];
    mock?: boolean;
    pick?: Record<string, { class_type?: string }>;
    error?: { message?: string };
  };
  assert.equal(subjectResponse.status, 200, JSON.stringify(subjectBody.error));
  assert.equal(subjectBody.subject, "The main subject");
  assert.equal(subjectBody.time, 0.4);
  assert.equal(subjectBody.pick?.["20"]?.class_type, "GeminiNodeV3");
  assert.equal(typeof subjectBody.reply, "string", "the mock answers with a sample reply, read like a model's");
  const mockReply = parseSubjectScene(subjectBody.reply ?? "", 2);
  assert.ok(mockReply.parts.length >= 5);
  assert.ok(mockReply.parts.some((part) => part.name === "head"));
  assert.equal(subjectBody.positions, undefined, "the toy is the blocks, not a mesh");
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
  const videoOnlyJob = buildJobBody(
    app,
    { video: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filePath: "input.mp4" } },
    { seed: 1, hasImage: true },
    null,
  );
  assert.equal(videoOnlyJob.workflow["12"], undefined);

  console.log("reverse-3d-scene-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
