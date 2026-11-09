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
  assembleScene,
  boxInCrop,
  buildHunyuanWorkflow,
  buildMarkWorkflow,
  buildPickWorkflow,
  closeUpCrop,
  comboOptions,
  cutoutAssetToken,
  MAX_SUBJECTS,
  MOCK_FIND_REPLY,
  MOCK_MARK_REPLY,
  parseSceneFind,
  parseSceneMarks,
  parseSubjectChoice,
  partOnFrame,
  selectImageOutput,
  selectMeshOutput,
  selectTextOutput,
  MESH_KEEP_FRACTION,
  type FrameBox,
  type FramePart,
  type SubjectKind,
} from "../src/lib/subject-pipeline";
import { REVERSE_3D_RENDERS_VIDEO } from "../src/lib/reverse-3d-switch";
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

const VISITOR_KEY = "comfyui-test-visitor-key-0123456789";

async function postReverse(
  video: Buffer,
  reference: Buffer | null,
  name = "clip.mp4",
  type = "video/mp4",
  access: { key?: string | null; cookie?: string } = { key: VISITOR_KEY },
) {
  const form = new FormData();
  if (access.key) form.set("comfyKey", access.key);
  form.append("video", new File([new Uint8Array(video)], name, { type }));
  if (reference) form.append("reference", new File([new Uint8Array(reference)], "reference.png", { type: "image/png" }));
  const headers = access.cookie ? { cookie: access.cookie } : undefined;
  const response = await POST(new Request("http://localhost/api/run/reverse-3d", { method: "POST", body: form, headers }), {
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
  assert.equal(pick["21"]?.inputs.filename_prefix, "reverse-3d/subjects");
  assert.equal(Object.keys(pick).filter((id) => pick[id]?.class_type === "LoadImage").length, 12);
  for (let index = 1; index <= 12; index += 1) {
    assert.deepEqual(pick["20"]?.inputs[`model.images.image_${index}`], [String(index), 0]);
  }
  const findPrompt = String(pick["20"]?.inputs["model.prompt"]);
  assert.match(findPrompt, /find every person, animal and vehicle/);
  assert.match(findPrompt, /"subjects": \[\{"name": "man in a red jacket", "kind": "person", "box": \[ymin, xmin, ymax, xmax\], "m": 1.7\}\]/);
  assert.match(findPrompt, /from 1 to 12/);
  assert.match(findPrompt, new RegExp(`at most ${MAX_SUBJECTS}`));
  assert.equal(pick["20"]?.inputs["model.thinking_level"], "LOW");
  assert.equal(pick["20"]?.inputs["model.max_output_tokens"], 4096);
  // No image-to-3D step: two Gemini jobs are the whole 3D toy.
  assert.equal(JSON.stringify(pick).includes("Tencent"), false);

  const markGraph = buildMarkWorkflow(["person", "vehicle"], [[100, 200, 900, 800], [150.4, 100, 850, 900]]);
  assert.equal(markGraph["1"]?.inputs.image, "frame.png");
  assert.equal(markGraph["2"]?.inputs.image, "subject_1.png");
  assert.equal(markGraph["3"]?.inputs.image, "subject_2.png");
  assert.deepEqual(markGraph["20"]?.inputs["model.images.image_1"], ["1", 0]);
  assert.deepEqual(markGraph["20"]?.inputs["model.images.image_3"], ["3", 0]);
  assert.equal(markGraph["20"]?.inputs["model.images.image_4"], undefined);
  assert.equal(markGraph["21"]?.inputs.filename_prefix, "reverse-3d/parts");
  assert.equal(markGraph["20"]?.inputs["model.max_output_tokens"], 16384);
  const markText = String(markGraph["20"]?.inputs["model.prompt"]);
  assert.match(markText, /Image 2 shows a person inside the box \[100, 200, 900, 800\]\. Image 3 shows a vehicle inside the box \[150, 100, 850, 900\]\./);
  assert.match(markText, /a wheel from the bottom of the tire to its top/);
  assert.match(markText, /"subjects": \[\{"image": 2, "parts": \[\{"name": "head", "a": \[y, x\], "b": \[y, x\]/);
  assert.throws(() => buildMarkWorkflow([], []), /1 to 8 close-ups/);
  assert.throws(() => buildMarkWorkflow(Array<SubjectKind>(9).fill("person"), []), /1 to 8 close-ups/);

  // First job: the frame and everyone in it.
  const found = parseSceneFind(
    [
      "```json",
      "{",
      '  "frame": 3,',
      '  "subjects": [',
      '    {"name": "dancer", "kind": "person", "box": [900, 600, 100, 400], "m": 1.6},',
      '    {"name": "dancer again", "kind": "person", "box": [110, 405, 895, 600]},',
      '    {"name": "speck", "kind": "person", "box": [500, 500, 520, 530]},',
      '    {"name": "", "kind": "robot", "box": [600, 700, 800, 900]},',
      '    {"name": "dog", "kind": "animal", "box_2d": [700, 100, 950, 300], "m": "big"},',
      '    {"name": "no box", "kind": "person"}',
      "  ]",
      "}",
      "```",
    ].join("\r\n"),
    6,
  );
  assert.equal(found.frame, 2);
  assert.equal(found.subject, "dancer");
  assert.deepEqual(found.subjects, [
    { name: "dancer", kind: "person", box: [100, 400, 900, 600], m: 1.6 },
    { name: "object", kind: "object", box: [600, 700, 800, 900], m: 0.8 },
    { name: "dog", kind: "animal", box: [700, 100, 950, 300], m: 0.6 },
  ], "corners are put in order, a repeat and a speck are dropped, an unknown kind is an object");
  assert.throws(() => parseSceneFind('{"subjects": []}', 4), /choose a frame/);
  assert.throws(() => parseSceneFind('{"frame": 7, "subjects": []}', 6), /not sampled/);
  assert.throws(() => parseSceneFind('{"frame": 1, "subjects": [{"name": "dot", "kind": "person", "box": [1, 1, 5, 5]}]}', 4), /did not find anyone/);
  const cutFind = parseSceneFind(
    '{"frame": 2, "subjects": [{"name": "rider", "kind": "person", "box": [100, 100, 900, 400], "m": 1.8}, {"name": "bike", "kind": "vehicle", "box": [500, 50',
    4,
  );
  assert.deepEqual(cutFind.subjects.map((subject) => subject.name), ["rider"], "a reply cut short keeps the subjects it finished");
  assert.equal(cutFind.frame, 1);
  const many = JSON.stringify({
    frame: 1,
    subjects: Array.from({ length: 12 }, (_, index) => ({ name: `p${index}`, kind: "person", box: [100, index * 80, 900, index * 80 + 70] })),
  });
  assert.equal(parseSceneFind(many, 4).subjects.length, MAX_SUBJECTS);

  // Each subject's close-up: its box with a margin, inside the frame, and back again.
  const wide = 16 / 9;
  const tall: FrameBox = [150, 300, 900, 450];
  const crop = closeUpCrop(tall, wide);
  assert.ok(crop[0] <= 150 && crop[1] <= 300 && crop[2] >= 900 && crop[3] >= 450, "the close-up holds the whole subject");
  assert.ok(crop[0] >= 0 && crop[1] >= 0 && crop[2] <= 1000 && crop[3] <= 1000, "and stays inside the frame");
  const cropAspect = ((crop[3] - crop[1]) * wide) / (crop[2] - crop[0]);
  assert.ok(cropAspect >= 0.6 - 1e-9, `a standing person gets room at the sides: ${cropAspect}`);
  const edge = closeUpCrop([0, 900, 600, 1000], wide);
  assert.ok(Math.abs(edge[3] - 1000) < 1e-9 && edge[1] < 900 - 100, "a subject at the edge slides the cut inside instead of shrinking it");
  const inner = boxInCrop(tall, crop);
  const back = partOnFrame({ name: "box", a: [inner[0], inner[1]], b: [inner[2], inner[3]], w: 1, d: 1, z: 0 }, crop);
  assert.ok(
    Math.abs(back.a[0] - 150) < 1e-9 && Math.abs(back.a[1] - 300) < 1e-9 && Math.abs(back.b[0] - 900) < 1e-9 && Math.abs(back.b[1] - 450) < 1e-9,
    "a box put in a close-up and back lands where it was",
  );

  // Second job: each close-up's parts.
  const marks = parseSceneMarks(
    '```json\n{"subjects": [{"image": 3, "parts": [{"name": "wheel", "a": [900, 300], "b": [500, 300], "w": 1, "d": 0.3, "z": 1}]}, {"image": 2, "parts": [{"name": "head", "a": [200, 500], "b": [100, 500], "z": 2}, {"name": "dot", "a": [400, 400], "b": [401, 401]}, {"name": "  ", "a": [520, 480], "b": [700, -40], "w": 9, "d": -2, "z": -3}]}]}\n```',
    3,
  );
  assert.deepEqual(marks, [
    [
      { name: "head", a: [200, 500], b: [100, 500], w: 0.4, d: 0.8, z: 1 },
      { name: "part", a: [520, 480], b: [700, 0], w: 3, d: 0.8, z: -1 },
    ],
    [{ name: "wheel", a: [900, 300], b: [500, 300], w: 1, d: 0.3, z: 1 }],
    null,
  ], "defaults, clamped points and ratios, a dot dropped, and a close-up left unmarked");
  const fromOne = parseSceneMarks('{"subjects": [{"image": 1, "parts": [{"name": "torso", "a": [300, 500], "b": [600, 500], "w": 0.6}]}]}', 2);
  assert.equal(fromOne[0]?.[0]?.name, "torso", "close-ups counted from 1 are moved back to image 2");
  const cutMarks = parseSceneMarks(
    '{"subjects": [{"image": 2, "parts": [{"name": "head", "a": [200, 500], "b": [100, 500], "w": 0.8}]}, {"image": 3, "parts": [{"name": "body", "a": [500, 100], "b": [500, 900], "w": 0.4}, {"name": "tail", "a": [5',
    2,
  );
  assert.deepEqual(cutMarks.map((mark) => mark?.map((part) => part.name)), [["head"], ["body"]], "a reply cut short keeps each close-up's finished parts");
  const crowdMarks = parseSceneMarks(
    JSON.stringify({ subjects: [{ image: 2, parts: Array.from({ length: 30 }, (_, index) => ({ name: `p${index}`, a: [100 + index * 20, 400], b: [110 + index * 20, 420] })) }] }),
    1,
  );
  assert.equal(crowdMarks[0]?.length, 16);

  // Both jobs together.
  const sceneFind = parseSceneFind(
    JSON.stringify({
      frame: 1,
      subjects: [
        { name: "runner", kind: "person", box: [150, 300, 900, 450], m: 1.8 },
        { name: "crate", kind: "object", box: [700, 600, 900, 800], m: 0.5 },
        { name: "stool", kind: "object", box: [650, 100, 950, 250], m: 0.6 },
        { name: "cat", kind: "animal", box: [800, 850, 950, 990], m: 0.3 },
      ],
    }),
    1,
  );
  const sceneCrops = sceneFind.subjects.map((subject) => closeUpCrop(subject.box, wide));
  const crateInner = boxInCrop(sceneFind.subjects[1]!.box, sceneCrops[1]!);
  const crateMiddle = (crateInner[0] + crateInner[2]) / 2;
  const assembled = assembleScene(
    sceneFind,
    [
      [{ name: "torso", a: [300, 500], b: [600, 500], w: 0.6, d: 0.6, z: 0 }],
      [{ name: "crate", a: [crateMiddle, crateInner[1]], b: [crateMiddle, crateInner[3]], w: 1, d: 1, z: 0 }],
      [{ name: "seat", a: [0, 0], b: [1000, 1000], w: 0.1, d: 1, z: 0 }],
      null,
    ],
    sceneCrops,
    wide,
  );
  assert.deepEqual(assembled.subjects.map((subject) => subject.parts.map((part) => part.name)), [["torso"], ["crate"], ["stool"], ["cat"]]);
  const crateOnFrame = assembled.subjects[1]!.parts[0]!;
  assert.ok(
    Math.abs(crateOnFrame.a[0] - 800) < 1e-6 && Math.abs(crateOnFrame.a[1] - 600) < 1e-6 && Math.abs(crateOnFrame.b[1] - 800) < 1e-6,
    "marks inside an object's box are kept, moved onto the frame",
  );
  const stoolOnFrame = assembled.subjects[2]!.parts[0]!;
  assert.deepEqual([stoolOnFrame.a, stoolOnFrame.b], [[950, 175], [650, 175]], "an object marked outside its box is one block over the box");
  const catOnFrame = assembled.subjects[3]!.parts[0]!;
  assert.deepEqual([catOnFrame.a, catOnFrame.b], [[875, 850], [875, 990]], "an unmarked subject lies along its longer side");

  // A car seen at an angle, marked as the model marked one: the body's line kept, its thickness halved.
  const carFind = parseSceneFind(JSON.stringify({ frame: 1, subjects: [{ name: "car", kind: "vehicle", box: [508, 233, 769, 771], m: 1.4 }] }), 1);
  const carCrop = closeUpCrop(carFind.subjects[0]!.box, wide);
  const carMarks: FramePart[] = [
    { name: "lower body", a: [596, 118], b: [431, 888], w: 0.35, d: 1, z: 0 },
    { name: "cabin", a: [381, 381], b: [338, 865], w: 0.3, d: 0.9, z: 0 },
    { name: "front wheel", a: [766, 375], b: [504, 375], w: 0.45, d: 0.3, z: 1 },
  ];
  const shaped = assembleScene(carFind, [carMarks], [carCrop], wide).subjects[0]!.parts;
  assert.deepEqual(shaped.map((part) => part.name), ["lower body", "cabin", "front wheel"]);
  const [shapedBody, shapedCabin, shapedWheel] = shaped as [FramePart, FramePart, FramePart];
  const markedBody = partOnFrame(carMarks[0]!, carCrop);
  assert.deepEqual([shapedBody.a, shapedBody.b], [markedBody.a, markedBody.b], "the car's body keeps its marked line and slant");
  const bodyLength = Math.hypot((shapedBody.b[1] - shapedBody.a[1]) * wide, shapedBody.b[0] - shapedBody.a[0]);
  const bodyThick = shapedBody.w * bodyLength;
  assert.ok(Math.abs(bodyThick - 0.5 * 261) < 1e-6, `a body marked too thick is half the car's height: ${bodyThick}`);
  assert.equal(shapedCabin.a[0], shapedCabin.b[0], "the cabin stands level");
  const cabinTall = shapedCabin.w * (shapedCabin.b[1] - shapedCabin.a[1]) * wide;
  assert.ok(Math.abs(shapedCabin.a[0] - cabinTall / 2 - 508) < 1e-6, "the cabin reaches the roof");
  const bodyTopAt = (x: number) =>
    shapedBody.a[0] + ((shapedBody.b[0] - shapedBody.a[0]) * (x - shapedBody.a[1])) / (shapedBody.b[1] - shapedBody.a[1]) - bodyThick / 2;
  assert.ok(Math.abs(shapedCabin.a[0] + cabinTall / 2 - bodyTopAt(shapedCabin.a[1])) < 1e-6, "the cabin stands on the body, with no gap");
  assert.deepEqual(shapedWheel, partOnFrame(carMarks[2]!, carCrop), "the wheels are kept as marked");
  const shapedLaid = layoutFrameScene({ subjects: [{ name: "car", kind: "vehicle", m: 1.4, parts: shaped }] }, wide);
  const slantedBody = shapedLaid.boxes.find((box) => box.name === "lower body")!;
  assert.ok(Math.abs(Math.abs(slantedBody.rotation ?? 0) - Math.PI / 2) > 0.05, "a car seen at an angle keeps its slant");
  const shapedPlate = shapedLaid.plate!;
  const bodyFront = (shapedLaid.camera!.distance - (slantedBody.center[2] + slantedBody.size[2] / 2)) / shapedLaid.camera!.distance;
  const bodyOnPlate = (bodyLength / 1000) * shapedPlate.size[1];
  assert.ok(Math.abs(slantedBody.size[1] / bodyFront - bodyOnPlate) < 1e-9, "the car body's front face is exactly as long as the car looks");
  const [nearWheel, farWheel] = ["front wheel", "far front wheel"].map((name) => shapedLaid.boxes.find((box) => box.name === name)!);
  assert.ok(nearWheel && farWheel, "the far wheel is added");
  assert.deepEqual([farWheel.center[1], farWheel.size], [nearWheel.center[1], nearWheel.size], "the far wheel is the same wheel across the car, on the same ground");
  assert.ok(farWheel.center[2] < nearWheel.center[2]);
  const carLook = (box: (typeof shapedLaid.boxes)[number]) =>
    (box.center[0] - shapedLaid.camera!.target[0]) / (shapedLaid.camera!.distance - box.center[2] - box.size[2] / 2);
  assert.ok(Math.abs(carLook(farWheel) - carLook(nearWheel)) < 1e-9, "from the camera, the far wheel hides straight behind the near one");

  // The blocks: every subject of the sample, lined up with the frame from the starting camera.
  const mockFind = parseSceneFind(MOCK_FIND_REPLY, 12);
  const mockCrops = mockFind.subjects.map((subject) => closeUpCrop(subject.box, wide));
  const mockMarks = parseSceneMarks(MOCK_MARK_REPLY, mockFind.subjects.length);
  assert.ok(mockMarks.every(Boolean), "the sample marks every subject");
  const mockScene = assembleScene(mockFind, mockMarks, mockCrops, wide);
  const mockParts = mockScene.subjects.flatMap((subject) => subject.parts);
  assert.ok(mockScene.subjects[2]!.parts.length > 1, "the sample table keeps its top and legs");
  const laid = layoutFrameScene(mockScene, wide);
  assert.equal(laid.boxes.length, mockParts.length);
  assert.deepEqual([...new Set(laid.boxes.map((box) => box.subject))], [0, 1, 2], "every subject is built");
  assert.ok(laid.boxes.some((box) => box.name === "person waving · head"), "with several subjects, a block says whose it is");
  assert.ok(laid.boxes.filter((box) => box.kind === "prop").length === mockScene.subjects[2]!.parts.length);
  assert.equal(laid.cropped, false);
  assert.ok(laid.plate && laid.camera);
  const { plate, camera } = laid;
  assert.equal(plate.center[2], camera.target[2], "the frame stands on the plane the camera turns around");
  assert.ok(laid.boxes.some((box) => box.center[2] < plate.center[2]), "so a subject farther back stands behind it");
  assert.ok(Math.abs(plate.size[0] / plate.size[1] - wide) < 1e-9, "the frame keeps its shape");
  const look = (point: readonly number[]) => {
    const depth = camera.distance - (point[2]! - camera.target[2]);
    return [(point[0]! - camera.target[0]) / depth, (point[1]! - camera.target[1]) / depth] as const;
  };
  const onPlate = (y: number, x: number): [number, number, number] => [
    plate.center[0] + (x / 1000 - 0.5) * plate.size[0],
    plate.center[1] + (0.5 - y / 1000) * plate.size[1],
    plate.center[2],
  ];
  // What the camera sees of a block is its front face.
  const frontOf = (box: (typeof laid.boxes)[number]) => [box.center[0], box.center[1], box.center[2] + box.size[2] / 2] as const;
  const linedUp = (box: (typeof laid.boxes)[number], part: FramePart) => {
    const [seenX, seenY] = look(frontOf(box));
    const [plateX, plateY] = look(onPlate((part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2));
    return Math.abs(seenX - plateX) < 1e-9 && Math.abs(seenY - plateY) < 1e-9;
  };
  laid.boxes.forEach((box, index) => assert.ok(linedUp(box, mockParts[index]!), `${box.name} lines up with the frame`));
  const subjectZ = (index: number) => {
    const own = laid.boxes.filter((box) => box.subject === index && !/forearm/.test(box.name ?? ""));
    return own.reduce((sum, box) => sum + box.center[2], 0) / own.length;
  };
  assert.ok(subjectZ(1) < subjectZ(0), "the person who looks smaller for their height stands farther back");
  const extent = (box: (typeof laid.boxes)[number]) => {
    const cos = Math.abs(Math.cos(box.rotation ?? 0));
    const sin = Math.abs(Math.sin(box.rotation ?? 0));
    return { halfX: (cos * box.size[0] + sin * box.size[1]) / 2, halfY: (sin * box.size[0] + cos * box.size[1]) / 2 };
  };
  const lowestOf = (boxes: typeof laid.boxes) => Math.min(...boxes.map((box) => box.center[1] - extent(box).halfY));
  assert.ok(Math.abs(lowestOf(laid.boxes.filter((box) => box.subject === 0)) - laid.floorY) < 1e-6, "the middle subject stands on the floor");
  const waving = laid.boxes.find((box) => box.name === "person waving · head")!;
  assert.ok(Math.abs(waving.rotation ?? 0) < 0.05, "an upright head is not turned");
  const raised = laid.boxes.find((box) => box.name === "person waving · right forearm")!;
  const raisedArm = laid.boxes.find((box) => box.name === "person waving · right upper arm")!;
  assert.ok(raised.center[2] > raisedArm.center[2], "a part marked closer sits in front of the body");

  // Two people of the same height: the one that looks smaller is farther away, and still covers itself on the frame.
  const standing = (top: number, bottom: number, x: number): FramePart[] => {
    const at = (share: number) => top + (bottom - top) * share;
    return [
      { name: "head", a: [at(0.13), x], b: [at(0), x], w: 0.8, d: 1, z: 0 },
      { name: "torso", a: [at(0.15), x], b: [at(0.45), x], w: 0.6, d: 0.6, z: 0 },
      { name: "thigh", a: [at(0.5), x], b: [at(0.745), x], w: 0.4, d: 1, z: 0 },
      { name: "shin", a: [at(0.745), x], b: [at(1), x], w: 0.3, d: 1, z: 0 },
    ];
  };
  const pairParts = [standing(100, 900, 300), standing(400, 700, 700)];
  const pair = layoutFrameScene(
    {
      subjects: [
        { name: "near", kind: "person", m: 1.7, parts: pairParts[0]! },
        { name: "far", kind: "person", m: 1.7, parts: pairParts[1]! },
      ],
    },
    wide,
  );
  const nearHead = pair.boxes.find((box) => box.name === "near · head")!;
  const farHead = pair.boxes.find((box) => box.name === "far · head")!;
  assert.ok(Math.abs(nearHead.center[2]) < 1e-9 && farHead.center[2] < -1, `the far one stands back: ${farHead.center[2]}`);
  const frontAlong = (box: (typeof pair.boxes)[number]) => (pair.camera!.distance - frontOf(box)[2]) / pair.camera!.distance;
  assert.ok(
    Math.abs(farHead.size[1] / nearHead.size[1] - ((0.3 / 0.8) * frontAlong(farHead)) / frontAlong(nearHead)) < 1e-9,
    "pushed back, the far one is scaled up to keep its outline",
  );
  assert.ok(pair.plate && pair.plate.center[2] > farHead.center[2], "the far one stands behind the frame's plane");
  const pairLook = (point: readonly number[]) => {
    const depth = pair.camera!.distance - (point[2]! - pair.camera!.target[2]);
    return [(point[0]! - pair.camera!.target[0]) / depth, (point[1]! - pair.camera!.target[1]) / depth] as const;
  };
  const farPart = pairParts[1]![0]!;
  const farOnPlate: [number, number, number] = [
    pair.plate.center[0] + ((farPart.a[1] + farPart.b[1]) / 2000 - 0.5) * pair.plate.size[0],
    pair.plate.center[1] + (0.5 - (farPart.a[0] + farPart.b[0]) / 2000) * pair.plate.size[1],
    pair.plate.center[2],
  ];
  assert.ok(Math.abs(pairLook(frontOf(farHead))[0] - pairLook(farOnPlate)[0]) < 1e-9, "the far head lines up with the frame");
  assert.ok(Math.abs(pairLook(frontOf(farHead))[1] - pairLook(farOnPlate)[1]) < 1e-9);

  // A car: its body drawn level, round wheels, and the two wheels hidden behind it.
  const car = layoutFrameScene(
    {
      subjects: [
        {
          name: "car",
          kind: "vehicle",
          m: 1.45,
          parts: [
            { name: "lower body", a: [640, 100], b: [600, 900], w: 0.3, d: 1.6, z: 0 },
            { name: "cabin", a: [480, 300], b: [470, 750], w: 0.3, d: 1.4, z: 0 },
            { name: "front wheel", a: [800, 220], b: [620, 220], w: 0.6, d: 1, z: 1 },
            { name: "back wheel", a: [790, 780], b: [610, 780], w: 0.2, d: 1, z: 1 },
          ],
        },
      ],
    },
    wide,
  );
  const wheels = car.boxes.filter((box) => box.wheel);
  assert.deepEqual(
    wheels.map((box) => box.name),
    ["front wheel", "back wheel", "far front wheel", "far back wheel"],
    "a car seen from one side gets the two wheels hidden behind it",
  );
  assert.equal(wheels[0]!.wheel, "z");
  assert.ok(Math.abs(wheels[0]!.size[0] / wheels[0]!.size[1] - 0.6) < 1e-9, "a wheel seen at an angle is an oval as wide as it looks");
  assert.equal(wheels[1]!.wheel, "x", "a wheel seen edge on shows its tread");
  assert.ok(wheels[2]!.center[2] < wheels[0]!.center[2], "a hidden wheel is on the far side");
  const carBody = car.boxes.find((box) => box.name === "lower body")!;
  assert.ok(Math.abs(Math.abs(carBody.rotation ?? 0) - Math.PI / 2) < 1e-9, "a car body a few degrees off level is drawn level");
  const bike = layoutFrameScene(
    {
      subjects: [
        {
          name: "bike",
          kind: "vehicle",
          parts: [
            { name: "frame", a: [500, 300], b: [700, 600], w: 0.4, d: 0.2, z: 0 },
            { name: "front wheel", a: [900, 250], b: [600, 250], w: 1, d: 0.15, z: 1 },
            { name: "back wheel", a: [900, 650], b: [600, 650], w: 1, d: 0.15, z: -1 },
          ],
        },
      ],
    },
    wide,
  );
  assert.equal(bike.boxes.filter((box) => box.wheel).length, 2, "a bike keeps its two wheels");

  // A person's slant is kept, something as big as the frame is the background, and one block alone is exact.
  const torsoPart: FramePart = { name: "torso", a: [300, 500], b: [600, 500], w: 0.5, d: 0.6, z: 0 };
  const arm = layoutFrameScene(
    { subjects: [{ name: "a", kind: "person", parts: [torsoPart, { name: "arm", a: [320, 520], b: [345, 700], w: 0.3, d: 1, z: 0 }] }] },
    wide,
  );
  const armBox = arm.boxes.find((box) => box.name === "arm")!;
  assert.ok(Math.abs(Math.abs(armBox.rotation ?? 0) - Math.PI / 2) > 0.05, "a person's arm keeps its slant");
  const room = layoutFrameScene(
    {
      subjects: [
        { name: "a", kind: "person", parts: [torsoPart] },
        { name: "wall", kind: "object", parts: [{ name: "wall", a: [500, 0], b: [500, 1000], w: 0.9, d: 0.2, z: 0 }] },
      ],
    },
    wide,
  );
  assert.deepEqual(room.boxes.map((box) => box.name), ["torso"], "something as big as the frame is the background");
  const lone = layoutFrameScene(
    { subjects: [{ name: "crate", kind: "object", parts: [{ name: "crate", a: [700, 400], b: [700, 600], w: 0.5, d: 1, z: 0 }] }] },
    wide,
  );
  const loneBox = lone.boxes[0]!;
  assert.ok(Math.abs(loneBox.size[1] / loneBox.size[0] - 2) < 1e-9, "one block alone is drawn exactly over what it covers");
  assert.ok(Math.abs(Math.abs(loneBox.rotation ?? 0) - Math.PI / 2) < 1e-9, "a level crate lies on its side");
  assert.throws(() => layoutFrameScene({ subjects: [] }, wide), /did not mark any parts/);

  const boxMesh = partBoxesMesh(laid);
  assert.equal(boxMesh.positions.length, laid.boxes.length * 8 * 3);
  assert.equal(boxMesh.indices.length, laid.boxes.length * 36);
  const loneMesh = partBoxesMesh(lone);
  const xs = Array.from({ length: 8 }, (_, index) => loneMesh.positions[index * 3]!);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - loneBox.size[1]) < 1e-5, "the mesh turns the box with the part");
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
  if (!REVERSE_3D_RENDERS_VIDEO) {
    // While the video is switched off, a real run is refused before anything is uploaded. Mock runs stay open.
    delete process.env.COMFY_MOCK;
    const off = await postReverse(clip4, null);
    assert.equal(off.status, 503, JSON.stringify(off.payload));
    assert.match(off.payload.error?.message ?? "", /switched off/);
  }
  process.env.COMFY_MOCK = "1";

  // Without the grey still, Kling gets no reference image and a prompt that does not name one.
  const videoOnly = await postReverse(clip4, null);
  assert.equal(videoOnly.status, 200, JSON.stringify(videoOnly.payload.error ?? videoOnly.payload));
  const bare = videoOnly.payload.request?.workflow;
  assert.ok(bare);
  assert.equal(bare["30"], undefined);
  assert.equal(bare["20"]?.inputs["model.reference_images.image_1"], undefined);
  assert.doesNotMatch(String(bare["20"]?.inputs["model.prompt"]), /@Image1/);
  assert.match(String(bare["20"]?.inputs["model.prompt"]), /never turned into a person/);

  // Any length is accepted: the workflow keeps the first 10 seconds itself.
  const longMp4 = await postReverse(clip12, null);
  assert.equal(longMp4.status, 200, JSON.stringify(longMp4.payload.error ?? longMp4.payload));
  const longWebm = await postReverse(webm12, null, "clip.webm", "video/webm");
  assert.equal(longWebm.status, 200, JSON.stringify(longWebm.payload.error ?? longWebm.payload));

  // With the still, it is node 30 and Kling copies its look from @Image1.
  const ok = await postReverse(clip4, png);
  assert.equal(ok.status, 200, JSON.stringify(ok.payload.error ?? ok.payload));
  const workflow = ok.payload.request?.workflow;
  assert.ok(workflow);
  assert.equal(workflow["12"], undefined);
  assert.equal(workflow["11"]?.class_type, "Video Slice");
  assert.equal(workflow["11"]?.inputs.duration, 10);
  assert.deepEqual(workflow["15"]?.inputs.video, ["11", 0]);
  assert.equal(workflow["30"]?.class_type, "LoadImage");
  assert.equal((workflow["30"]?.inputs.image as { info?: { file_path?: string } })?.info?.file_path, "reference.png");
  assert.deepEqual(workflow["20"]?.inputs["model.reference_images.image_1"], ["30", 0]);
  assert.match(String(workflow["20"]?.inputs["model.prompt"]), /looks exactly like @Image1/);
  assert.equal(workflow["20"]?.inputs.model, "kling-4.0-flash");

  // The still itself: one Nano Banana job on the first frame.
  const stillForm = new FormData();
  stillForm.set("comfyKey", VISITOR_KEY);
  stillForm.set("step", "still");
  stillForm.append("frame", new File([new Uint8Array(png)], "frame.jpg", { type: "image/jpeg" }));
  const stillResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: stillForm }));
  const stillBody = (await stillResponse.json()) as {
    mock?: boolean;
    step?: string;
    still?: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    error?: { message?: string };
  };
  assert.equal(stillResponse.status, 200, JSON.stringify(stillBody.error));
  assert.equal(stillBody.step, "still");
  assert.equal(stillBody.mock, true);
  assert.equal(stillBody.still?.["2"]?.class_type, "GeminiNanoBanana2V2");
  assert.equal(stillBody.still?.["2"]?.inputs?.model, "Nano Banana 2 Lite");
  assert.deepEqual(stillBody.still?.["2"]?.inputs?.["model.images.image_1"], ["1", 0]);
  assert.match(String(stillBody.still?.["2"]?.inputs?.prompt), /never turn an object into a person/);
  assert.equal(stillBody.still?.["3"]?.class_type, "SaveImage");
  const twoFrames = new FormData();
  twoFrames.set("comfyKey", VISITOR_KEY);
  twoFrames.set("step", "still");
  twoFrames.append("frame", new File([new Uint8Array(png)], "a.jpg", { type: "image/jpeg" }));
  twoFrames.append("frame", new File([new Uint8Array(png)], "b.jpg", { type: "image/jpeg" }));
  const twoResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: twoFrames }));
  assert.equal(twoResponse.status, 400);
  assert.equal(selectImageOutput([{ id: "a", name: "reverse-3d/still_00001_.png" }])?.id, "a");
  assert.equal(selectImageOutput([{ id: "a", name: "reply.txt" }]), null);

  // Access: no key and no session is refused before anything is uploaded.
  const anonymous = await postReverse(clip4, png, "clip.mp4", "video/mp4", {});
  assert.equal(anonymous.status, 401, JSON.stringify(anonymous.payload));
  const badKey = await postReverse(clip4, png, "clip.mp4", "video/mp4", { key: "short" });
  assert.equal(badKey.status, 400);
  // A visitor key bills the partner nodes to that key.
  assert.equal((ok.payload.request as { extra_data?: { api_key_comfy_org?: string } } | undefined)?.extra_data?.api_key_comfy_org, "<redacted>");

  // Email: a code (shown in mock mode), a session cookie, one free video, then refused.
  const codeRoute = await import("../src/app/api/access/code/route");
  const verifyRoute = await import("../src/app/api/access/verify/route");
  const accessRoute = await import("../src/app/api/access/route");
  const askCode = async (email: string) => {
    const response = await codeRoute.POST(new Request("http://localhost/api/access/code", { method: "POST", body: JSON.stringify({ email }) }));
    return { status: response.status, body: (await response.json()) as { challenge?: string; devCode?: string; error?: { code?: string } } };
  };
  assert.equal((await askCode("not an email")).status, 400);
  const asked = await askCode("Someone@Example.com ");
  assert.equal(asked.status, 200);
  assert.match(asked.body.devCode ?? "", /^\d{6}$/);
  const wrongDigit = asked.body.devCode === "000000" ? "111111" : "000000";
  const wrong = await verifyRoute.POST(new Request("http://localhost/api/access/verify", { method: "POST", body: JSON.stringify({ challenge: asked.body.challenge, code: wrongDigit }) }));
  assert.equal(wrong.status, 400);
  const verified = await verifyRoute.POST(new Request("http://localhost/api/access/verify", { method: "POST", body: JSON.stringify({ challenge: asked.body.challenge, code: asked.body.devCode }) }));
  assert.equal(verified.status, 200);
  const setCookie = verified.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^unrender_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
  const cookie = setCookie.split(";")[0];
  const me = (await (await accessRoute.GET(new Request("http://localhost/api/access", { headers: { cookie } }))).json()) as { email?: string; used?: boolean };
  assert.deepEqual([me.email, me.used], ["someone@example.com", false]);
  const tampered = cookie.slice(0, -3) + (cookie.endsWith("abc") ? "xyz" : "abc");
  assert.equal((await postReverse(clip4, png, "clip.mp4", "video/mp4", { cookie: tampered })).status, 401);
  const free = await postReverse(clip4, png, "clip.mp4", "video/mp4", { cookie });
  assert.equal(free.status, 200, JSON.stringify(free.payload));
  const again = await postReverse(clip4, png, "clip.mp4", "video/mp4", { cookie });
  assert.equal(again.status, 403);
  const usedStill = new FormData();
  usedStill.append("frame", new File([new Uint8Array(png)], "frame.jpg", { type: "image/jpeg" }));
  usedStill.set("step", "still");
  const usedStillResponse = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: usedStill, headers: { cookie } }));
  assert.equal(usedStillResponse.status, 403);
  assert.equal((await askCode("someone@example.com")).status, 409, "a used email gets no new code");
  // The same email with its own key still works.
  assert.equal((await postReverse(clip4, png)).status, 200);
  assert.deepEqual(workflow["20"]?.inputs["model.video_1"], ["16", 0]);

  const subjectForm = new FormData();
  subjectForm.set("comfyKey", VISITOR_KEY);
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
  assert.equal(subjectBody.subject, "person waving");
  assert.equal(subjectBody.time, 0.4);
  assert.equal(subjectBody.pick?.["20"]?.class_type, "GeminiNodeV3");
  assert.equal(typeof subjectBody.reply, "string", "the mock answers with a sample reply, read like a model's");
  assert.equal(parseSceneFind(subjectBody.reply ?? "", 2).subjects.length, 3);
  assert.equal(subjectBody.positions, undefined, "the toy is the blocks, not a mesh");
  assert.equal(subjectBody.mock, true);

  // The second job: the chosen frame, a close-up per subject, their kinds and where each sits in its close-up.
  const markForm = new FormData();
  markForm.set("comfyKey", VISITOR_KEY);
  markForm.set("step", "mark");
  markForm.append("frame", new File([new Uint8Array(png)], "frame.jpg", { type: "image/jpeg" }));
  for (let index = 0; index < 3; index += 1) {
    markForm.append("crop", new File([new Uint8Array(png)], `subject_${index + 1}.jpg`, { type: "image/jpeg" }));
  }
  markForm.set("kinds", "person,person,object");
  markForm.set("boxes", "115,267,896,731,120,300,880,700,145,110,855,890");
  const postMark = async (form: FormData) => {
    const response = await postSubject(new Request("http://localhost/api/reverse-3d/subject", { method: "POST", body: form }));
    const body = (await response.json()) as {
      mock?: boolean;
      step?: string;
      reply?: string;
      mark?: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
      error?: { message?: string };
    };
    return { status: response.status, body };
  };
  const marked = await postMark(markForm);
  assert.equal(marked.status, 200, JSON.stringify(marked.body.error));
  assert.equal(marked.body.step, "mark");
  assert.equal(marked.body.mock, true);
  assert.equal(marked.body.mark?.["4"]?.inputs?.image, "subject_3.png");
  assert.match(String(marked.body.mark?.["20"]?.inputs?.["model.prompt"]), /Image 4 shows an object inside the box \[145, 110, 855, 890\]/);
  assert.equal(parseSceneMarks(marked.body.reply ?? "", 3).filter(Boolean).length, 3);
  const refused = async (edit: (form: FormData) => void, pattern: RegExp) => {
    const form = new FormData();
    for (const [key, value] of markForm) form.append(key, value);
    edit(form);
    const result = await postMark(form);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error?.message ?? "", pattern);
  };
  await refused((form) => form.set("kinds", "person,robot,object"), /needs its kind/);
  await refused((form) => form.set("kinds", "person,person"), /needs its kind/);
  await refused((form) => form.set("boxes", "115,267,896,731,120,300,880,700,145,110,855"), /needs its box/);
  await refused((form) => form.set("boxes", "115,267,896,731,120,300,880,700,145,110,855,1200"), /needs its box/);
  await refused((form) => {
    for (let index = 0; index < 6; index += 1) form.append("crop", new File([new Uint8Array(png)], "more.jpg", { type: "image/jpeg" }));
  }, /1 to 8 close-ups/);
  await refused((form) => form.delete("frame"), /Upload a frame/);
  await refused((form) => form.append("frame", new File([new Uint8Array(png)], "frame_2.jpg", { type: "image/jpeg" })), /chosen frame once/);

  const cutoutForm = new FormData();
  cutoutForm.set("comfyKey", VISITOR_KEY);
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
