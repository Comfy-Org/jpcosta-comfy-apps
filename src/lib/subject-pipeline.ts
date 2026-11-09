import type { Workflow } from "@/lib/workflow";

/** Frames sent to the model. The clip is already trimmed to its first seconds. */
export const SUBJECT_FRAME_CAP = 12;

/** Most subjects rebuilt from one shot. Each gets a close-up in the marking job, next to the whole frame. */
export const MAX_SUBJECTS = 8;

/**
 * Share of the image-to-3D face count kept before the browser.
 * The slider's right end is this reduced mesh, drawn as boxes.
 */
export const MESH_KEEP_FRACTION = 0.3;

/** What a subject is. People get body proportions, objects get straightened, the rest is marked as it looks. */
export const SUBJECT_KINDS = ["person", "animal", "vehicle", "object"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export function isSubjectKind(value: unknown): value is SubjectKind {
  return typeof value === "string" && (SUBJECT_KINDS as readonly string[]).includes(value);
}

/**
 * First job: pick the frame and find everyone in it. Only boxes, so it stays short.
 * The model is good at boxes on a small frame; the parts are marked afterwards on close-ups.
 */
export const FIND_PROMPT = `These {count} images are frames from one clip, in order. Image 1 is the earliest.
The shot will be rebuilt as grey 3D blocks seen from the same camera.

1. Choose the frame where the people, animals and vehicles are easiest to see: large, sharp and not hidden.
2. On that frame, find every person, animal and vehicle, also the ones cut off by the edge of the frame, out of focus or partly hidden. Skip tiny figures far in the background (shorter than a tenth of the frame) and anyone on a screen or a poster.
3. Also find up to 3 solid objects that someone sits on, leans on, rides, holds or carries, like a bench, a table, a bike, a guitar or a board. Never the floor, a wall, the sky, a building or a tree.
For each one give a short "name", its "kind" (person, animal, vehicle or object), its "box" around all of it that shows in the frame as [ymin, xmin, ymax, xmax] normalized to 0-1000, and "m": its real height in meters when whole and upright (an adult is about 1.7, a car 1.45, a dog 0.6, a bench 0.45).
List the most important one first, then the rest from biggest to smallest, at most ${MAX_SUBJECTS}.

Reply with JSON only, in this shape:
{"frame": <integer from 1 to {count}>, "subjects": [{"name": "man in a red jacket", "kind": "person", "box": [ymin, xmin, ymax, xmax], "m": 1.7}]}`;

const KIND_NOUN: Record<SubjectKind, string> = {
  person: "a person",
  animal: "an animal",
  vehicle: "a vehicle",
  object: "an object",
};

/**
 * Second job: the whole frame, then one close-up per subject. Each subject is marked on its own close-up,
 * where it fills the picture, so the points land on the joints instead of a few pixels of a small frame.
 * `boxes` is where the subject sits in its close-up, [ymin, xmin, ymax, xmax] 0-1000.
 */
export function markPrompt(kinds: readonly SubjectKind[], boxes: readonly (readonly number[])[]): string {
  const list = kinds
    .map((kind, index) => {
      const box = boxes[index];
      const where = box && box.length === 4 ? ` inside the box [${box.map((value) => Math.round(value)).join(", ")}]` : "";
      return `Image ${index + 2} shows ${KIND_NOUN[kind]}${where}.`;
    })
    .join(" ");
  return `Image 1 is a frame from a clip. The other images are close-ups cut from it, each one centred on one subject. ${list}
The shot will be rebuilt as grey 3D blocks seen from the same camera, so every block has to sit exactly on the part it stands for.

On each close-up, split its subject into parts that each read as one box. Ignore anyone else who shows at the edges of a close-up.
- A person: head, torso, hips, both upper arms, both forearms, both thighs, both shins, and the hands and feet when they show.
- An animal: head, neck, body, each leg, tail.
- A car, van or truck: the lower body, the cabin with its windows on top of it, and every wheel. A bike: both wheels, the frame as one thin bar from the seat to the handlebar, and the fork from the handlebar down to the middle of the front wheel. A motorbike: both wheels and its body, from the back of the seat to the front of the tank.
- An object: 1 to 4 big pieces, like a table's top and its legs.
Mark each part's long axis with two points through its middle, "a" at one end and "b" at the other, set on the joints: a head from the chin to the top of the head, a torso from the base of the neck to the waist, hips from the waist to the crotch, an upper arm from the shoulder to the elbow, a forearm from the elbow to the wrist, a hand from the wrist to the fingertips, a thigh from the hip to the knee, a shin from the knee to the ankle, a foot from the heel to the toes, a wheel from the bottom of the tire to its top. A bench, a table top, a box or anything else that stands level goes from the middle of its left end to the middle of its right end, so its axis is level. Follow the pose exactly as it is. Mark a part hidden behind the subject's own body where it would be, and leave out parts that are outside the close-up.
"w" is the part's width across that axis divided by the axis length. For a wheel it is how wide it looks over how tall it looks, measured on the close-up: round from the side (1), an oval at an angle (about 0.6), only the tire from straight in front (about 0.2). "d" is its depth along the camera's view divided by that width (1 = as deep as it is wide). "z" is 1 when the part is clearly closer to the camera than the rest of the subject, -1 when it is clearly farther, otherwise 0. Seen from the side, the near arm, leg or wheel is 1 and the far one -1; seen from the front, both sides are 0.
Points are [y, x], normalized to 0-1000 on that close-up.

Reply with JSON only, in this shape:
{"subjects": [{"image": 2, "parts": [{"name": "head", "a": [y, x], "b": [y, x], "w": 0.8, "d": 1, "z": 0}]}]}`;
}

function geminiInputs(prompt: string, system: string, maxTokens: number): Record<string, unknown> {
  return {
    model: "Gemini 3.5 Flash",
    "model.prompt": prompt,
    // LOW leaves a little room to reason about the pose and stays a few seconds long.
    // The cap includes thinking, so it stays well above the JSON answer.
    "model.thinking_level": "LOW",
    "model.max_output_tokens": maxTokens,
    "model.seed": 0,
    "model.system_prompt": system,
    "model.temperature": 0,
    "model.top_p": 0.95,
  };
}

function saveText(prefix: string, title: string): Workflow[string] {
  return {
    class_type: "SaveText",
    inputs: { text: ["20", 0], filename_prefix: prefix, format: "txt" },
    _meta: { title },
  };
}

/** Gemini looks at every sampled frame, picks one and finds the subjects in it. */
export function buildPickWorkflow(frameCount: number): Workflow {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const workflow: Workflow = {};
  const gemini = geminiInputs(
    FIND_PROMPT.replaceAll("{count}", String(count)),
    "You find the people, animals, vehicles and handled objects in a video's frames, precisely, so a 3D blockout can be built over them. Reply with JSON only.",
    4096,
  );
  for (let index = 0; index < count; index += 1) {
    const node = String(index + 1);
    workflow[node] = {
      class_type: "LoadImage",
      inputs: { image: `frame_${index + 1}.png` },
      _meta: { title: `Frame ${index + 1}` },
    };
    gemini[`model.images.image_${index + 1}`] = [node, 0];
  }
  workflow["20"] = { class_type: "GeminiNodeV3", inputs: gemini, _meta: { title: "Pick the frame and find the subjects" } };
  workflow["21"] = saveText("reverse-3d/subjects", "Frame and subjects");
  return workflow;
}

/** Gemini marks each subject's parts on its own close-up. Node 1 is the frame, nodes 2.. the close-ups in order. */
export function buildMarkWorkflow(kinds: readonly SubjectKind[], boxes: readonly (readonly number[])[]): Workflow {
  if (kinds.length === 0 || kinds.length > MAX_SUBJECTS) throw new Error(`Send 1 to ${MAX_SUBJECTS} close-ups.`);
  const workflow: Workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "frame.png" }, _meta: { title: "Chosen frame" } },
  };
  const gemini = geminiInputs(
    markPrompt(kinds, boxes),
    "You mark the parts of each subject on its close-up, precisely on the joints, so a 3D blockout can be built over the shot. Reply with JSON only.",
    16384,
  );
  gemini["model.images.image_1"] = ["1", 0];
  kinds.forEach((kind, index) => {
    const node = String(index + 2);
    workflow[node] = {
      class_type: "LoadImage",
      inputs: { image: `subject_${index + 1}.png` },
      _meta: { title: `Close-up ${index + 1}: ${kind}` },
    };
    gemini[`model.images.image_${index + 2}`] = [node, 0];
  });
  workflow["20"] = { class_type: "GeminiNodeV3", inputs: gemini, _meta: { title: "Mark every subject's parts" } };
  workflow["21"] = saveText("reverse-3d/parts", "Parts per subject");
  return workflow;
}

/**
 * Combo values for one node input.
 * Comfy sends them as the first element of `[names, options]`, or as `options`.
 * An empty array is a real answer: that deployment has no file for the input.
 */
export function comboOptions(spec: unknown, inputName: string): string[] {
  const names: string[] = [];
  const take = (value: unknown) => {
    if (Array.isArray(value)) {
      const nested = value.find((item) => Array.isArray(item));
      const list = Array.isArray(nested) ? nested : value;
      for (const item of list) {
        if (typeof item === "string" && item.trim()) names.push(item.trim());
      }
      return;
    }
    if (value && typeof value === "object" && "options" in value) {
      take((value as { options: unknown }).options);
    }
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === inputName) take(child);
      else visit(child);
    }
  };
  visit(spec);
  return [...new Set(names)];
}

/**
 * Filename `LoadBackgroundRemovalModel` will accept on the deployment that returned `listed`.
 * The installed BiRefNet weight is `birefnet.safetensors` only when that string is actually listed.
 * Any other listed name is used as-is. An empty list cannot be satisfied by a hardcoded filename.
 */
export function backgroundModelName(listed: readonly string[]): string {
  const names = [...new Set(listed.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) {
    throw new Error("That deployment lists no background-removal model, so no filename can be validated.");
  }
  const installed = names.find((name) => name === "birefnet.safetensors" || name.endsWith("/birefnet.safetensors"));
  return installed ?? names[0];
}

/** Host that ships `models/background_removal/birefnet.safetensors`. */
export const BACKGROUND_REMOVAL_DEPLOYMENT_ID = "dep-e45cb437-0991-4689-9f7c-77d5748e3adc";

/**
 * Choose `bg_removal_name`.
 * A non-empty combo wins. `listed === null` means the combo route could not be read.
 * That v2 deployment does not serve `object_info`, and the file installed there is still
 * `birefnet.safetensors`, so the cut-out loads that name instead of failing the preview.
 */
export function backgroundModelForDeployment(deploymentId: string, listed: readonly string[] | null): string {
  if (listed && listed.length > 0) return backgroundModelName(listed);
  if (listed === null && deploymentId === BACKGROUND_REMOVAL_DEPLOYMENT_ID) return "birefnet.safetensors";
  if (listed) throw new Error("That deployment lists no background-removal model, so no filename can be validated.");
  throw new Error("Could not read the background-removal model list.");
}

/**
 * Same chain as the background-removal app. Submitted only to that deployment.
 * `modelName` must be one of the names its `LoadBackgroundRemovalModel` combo lists.
 */
export function buildCutoutWorkflow(modelName: string): Workflow {
  const name = modelName.trim();
  if (!name) throw new Error("That deployment lists no background-removal model, so no filename can be validated.");
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: "subject.png" },
      _meta: { title: "Chosen frame" },
    },
    "2": {
      class_type: "LoadBackgroundRemovalModel",
      inputs: { bg_removal_name: name },
      _meta: { title: "BiRefNet" },
    },
    "3": {
      class_type: "RemoveBackground",
      inputs: {
        bg_removal_model: ["2", 0],
        image: ["1", 0],
      },
      _meta: { title: "BiRefNet foreground mask" },
    },
    "4": {
      class_type: "InvertMask",
      inputs: { mask: ["3", 0] },
    },
    "5": {
      class_type: "JoinImageWithAlpha",
      inputs: {
        image: ["1", 0],
        alpha: ["4", 0],
      },
      _meta: { title: "Cut-out subject" },
    },
    "6": {
      class_type: "SaveImage",
      inputs: {
        images: ["5", 0],
        filename_prefix: "reverse-3d/cutout",
      },
      _meta: { title: "Cut-out PNG" },
    },
  };
}

/**
 * Hunyuan3D on the Reverse 3D deployment, then SaveGLB.
 * That host is partner-only, so this graph has no `LoadBackgroundRemovalModel`.
 * Live catalog: Tencent output 0 is the legacy STRING, output 1 is FILE_3D_GLB.
 * SaveGLB is node 21, the same output slot the public job filter keeps.
 */
export function buildHunyuanWorkflow(): Workflow {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: "subject.png" },
      _meta: { title: "Cut-out subject" },
    },
    "22": {
      class_type: "TencentImageToModelNode",
      inputs: {
        model: "3.1",
        image: ["1", 0],
        face_count: 10000,
        generate_type: "Geometry",
        seed: 0,
      },
      _meta: { title: "Hunyuan3D image to model" },
    },
    "21": {
      class_type: "SaveGLB",
      inputs: {
        mesh: ["22", 1],
        filename_prefix: "reverse-3d/mesh",
      },
      _meta: { title: "Save the GLB" },
    },
  };
}

export type NamedOutput = {
  id: string;
  name: string;
  sig?: string;
  /** Comfy API v2 Output.type. A GLB is `file`, not a separate 3D kind. */
  type?: string;
  contentType?: string;
};

const NOT_MESH_TYPE = new Set(["image", "video", "audio", "text", "latent"]);

function isCommittedGlb(item: NamedOutput): boolean {
  if (!item.id || (item.type && NOT_MESH_TYPE.has(item.type))) return false;
  if (/\.glb$/i.test(item.name)) return true;
  return Boolean(item.contentType && /gltf-binary|model\/gltf(?:\+json)?/i.test(item.contentType));
}

/**
 * A committed GLB asset. An empty list, a preview image, or any other file is not a mesh.
 * The paid job that returned `outputs: []` stays null: nothing here invents a download.
 */
export function selectMeshOutput(outputs: readonly NamedOutput[]): NamedOutput | null {
  return outputs.find((item) => isCommittedGlb(item)) ?? null;
}

/** SaveText file from the frame-choice job. Skips image outputs on the same node. */
export function selectTextOutput(outputs: readonly NamedOutput[]): NamedOutput | null {
  const text = outputs.find((item) => /\.txt$/i.test(item.name));
  if (text) return text;
  return outputs.find((item) => item.name.length > 0 && !/\.(png|jpe?g|webp|gif|glb|mp4|webm|mov)$/i.test(item.name)) ?? null;
}

/** Signature subject for a cut-out asset. Not a public job or output route. */
export function cutoutAssetToken(assetId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId)) {
    throw new Error("The background cut-out did not return an image.");
  }
  return `reverse-3d-cutout~${assetId}`;
}

export type SubjectChoice = {
  /** Zero-based index into the sampled frames. */
  frame: number;
  subject: string;
};

/** Read the frame and the subject, from lines or JSON keys. A missing frame number is not a guess from the pixels. */
export function parseSubjectChoice(text: string, frameCount: number): SubjectChoice {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const frameMatch = /frame"?\s*[:=]\s*"?(\d+)/i.exec(text);
  const subjectMatch = /subject"?\s*[:=]\s*"?([^"\n\r]+)/i.exec(text);
  if (!frameMatch) throw new Error("The model did not choose a frame.");
  const frame = Number(frameMatch[1]);
  if (!Number.isInteger(frame) || frame < 1 || frame > count) {
    throw new Error("The model chose a frame that was not sampled.");
  }
  const subject = (subjectMatch?.[1] ?? "").trim();
  if (!subject) throw new Error("The model did not name a subject.");
  return { frame: frame - 1, subject };
}

/** A point on the chosen frame: [y, x], each 0-1000. */
export type FramePoint = [number, number];

/** A box on the chosen frame: [ymin, xmin, ymax, xmax], each 0-1000. */
export type FrameBox = [number, number, number, number];

/** One part of a subject as the model marked it. */
export type FramePart = {
  name: string;
  /** The two ends of the part's long axis. */
  a: FramePoint;
  b: FramePoint;
  /** Width across the axis, divided by the axis length. */
  w: number;
  /** Depth along the camera's view, divided by the width. */
  d: number;
  /** 1 closer to the camera than the rest of the subject, -1 farther, 0 level with it. */
  z: -1 | 0 | 1;
};

/** A subject the first job found: what it is and where it is on the chosen frame. */
export type FoundSubject = {
  name: string;
  kind: SubjectKind;
  box: FrameBox;
  /** Its real height in meters when whole and upright, as the model guessed it. Sets how far away it stands. */
  m: number;
};

export type SceneFind = SubjectChoice & { subjects: FoundSubject[] };

/** A subject with its parts on the chosen frame, ready to be built. */
export type SceneSubject = { name: string; kind: SubjectKind; m: number; parts: FramePart[] };

export type SubjectScene = SubjectChoice & { subjects: SceneSubject[] };

const MAX_PARTS = 16;
/** A subject smaller than this on both sides (0-1000 of the frame) is background. */
const FIND_MIN_SIDE = 40;
/** Real height guessed for a subject the model gave none for. */
const DEFAULT_HEIGHT: Record<SubjectKind, number> = { person: 1.7, animal: 0.6, vehicle: 1.5, object: 0.8 };

const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1000, Math.max(0, value)) : null);

function framePoint(value: unknown): FramePoint | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const y = unit(value[0]);
  const x = unit(value[1]);
  return y === null || x === null ? null : [y, x];
}

function ratio(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(0.05, value)) : fallback;
}

function label(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : fallback;
}

function side(value: unknown): -1 | 0 | 1 {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, Math.round(value))) as -1 | 0 | 1;
}

function readPart(item: Record<string, unknown>): FramePart | null {
  const a = framePoint(item.a);
  const b = framePoint(item.b);
  if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) return null;
  return { name: label(item.name, "part"), a, b, w: ratio(item.w, 0.4, 3), d: ratio(item.d, 0.8, 4), z: side(item.z) };
}

function readBox(value: unknown): FrameBox | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [y0, x0, y1, x1] = value.slice(0, 4).map(unit);
  if (y0 === null || x0 === null || y1 === null || x1 === null) return null;
  const box: FrameBox = [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)];
  return box[2] - box[0] < 8 || box[3] - box[1] < 8 ? null : box;
}

function readFound(item: Record<string, unknown>): FoundSubject | null {
  const box = readBox(item.box ?? item.box_2d);
  if (!box) return null;
  const said = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
  const kind: SubjectKind = isSubjectKind(said) ? said : "object";
  const m = typeof item.m === "number" && Number.isFinite(item.m) && item.m >= 0.05 ? Math.min(30, item.m) : DEFAULT_HEIGHT[kind];
  return { name: label(item.name, kind), kind, box, m };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

/** The reply as one JSON object, or null when it was cut short or is not JSON. */
function wholeReply(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every flat `{...}` object in the text, with where it starts. A reply cut short still gives the ones it got to. */
function flatObjects(text: string): { at: number; item: Record<string, unknown> }[] {
  const found: { at: number; item: Record<string, unknown> }[] = [];
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const item = JSON.parse(match[0]) as unknown;
      if (item && typeof item === "object" && !Array.isArray(item)) found.push({ at: match.index ?? 0, item: item as Record<string, unknown> });
    } catch {
      // A cut-off object at the end of the reply.
    }
  }
  return found;
}

/** How much of the smaller box the two boxes share. */
function shared(a: FrameBox, b: FrameBox): number {
  const height = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const width = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (height <= 0 || width <= 0) return 0;
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return (height * width) / Math.max(smaller, 1);
}

/** Read the first job's reply: the chosen frame and every subject's box. Tiny and repeated boxes are dropped. */
export function parseSceneFind(text: string, frameCount: number): SceneFind {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const frameMatch = /frame"?\s*[:=]\s*"?(\d+)/i.exec(text);
  if (!frameMatch) throw new Error("The model did not choose a frame.");
  const frame = Number(frameMatch[1]);
  if (!Number.isInteger(frame) || frame < 1 || frame > count) throw new Error("The model chose a frame that was not sampled.");
  const whole = wholeReply(text);
  const items = whole ? records(whole.subjects) : flatObjects(text).map((entry) => entry.item).filter((item) => "box" in item || "box_2d" in item);
  const subjects: FoundSubject[] = [];
  for (const item of items) {
    const found = readFound(item);
    if (!found) continue;
    if (found.box[2] - found.box[0] < FIND_MIN_SIDE && found.box[3] - found.box[1] < FIND_MIN_SIDE) continue;
    if (subjects.some((kept) => kept.kind === found.kind && shared(kept.box, found.box) > 0.85)) continue;
    subjects.push(found);
    if (subjects.length === MAX_SUBJECTS) break;
  }
  const first = subjects[0];
  if (!first) throw new Error("The model did not find anyone in the shot.");
  return { frame: frame - 1, subject: first.name, subjects };
}

/** Margin around a subject in its close-up, as a share of the box's longer side. */
const CLOSE_UP_MARGIN = 0.14;
/** Width over height of a close-up stays in this range, so arms and things held at the side stay in. */
const CLOSE_UP_ASPECT: [number, number] = [0.6, 2.2];
/** Shortest close-up side, in frame heights. */
const CLOSE_UP_MIN = 0.16;

/**
 * Where to cut a subject's close-up from the chosen frame: its box with a margin, kept inside the frame.
 * `aspect` is the frame's width over its height. Returned as a frame box, 0-1000.
 */
export function closeUpCrop(box: FrameBox, aspect: number): FrameBox {
  const wide = Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 16 / 9;
  // Work in frame heights, so a margin is the same number of pixels on every side.
  const top = box[0] / 1000;
  const bottom = box[2] / 1000;
  const left = (box[1] / 1000) * wide;
  const right = (box[3] / 1000) * wide;
  const margin = CLOSE_UP_MARGIN * Math.max(bottom - top, right - left);
  let height = Math.max(bottom - top + margin * 2, CLOSE_UP_MIN);
  let width = Math.max(right - left + margin * 2, CLOSE_UP_MIN);
  if (width / height < CLOSE_UP_ASPECT[0]) width = height * CLOSE_UP_ASPECT[0];
  if (width / height > CLOSE_UP_ASPECT[1]) height = width / CLOSE_UP_ASPECT[1];
  width = Math.min(width, wide);
  height = Math.min(height, 1);
  // Slide the cut back inside the frame instead of shrinking it.
  const x = Math.min(Math.max((left + right) / 2 - width / 2, 0), wide - width);
  const y = Math.min(Math.max((top + bottom) / 2 - height / 2, 0), 1 - height);
  return [y * 1000, (x / wide) * 1000, (y + height) * 1000, ((x + width) / wide) * 1000];
}

/** Where `box` sits inside `crop`, both on the frame. The answer is 0-1000 of the close-up. */
export function boxInCrop(box: FrameBox, crop: FrameBox): FrameBox {
  const height = Math.max(crop[2] - crop[0], 1e-6);
  const width = Math.max(crop[3] - crop[1], 1e-6);
  const clamp = (value: number) => Math.min(1000, Math.max(0, value));
  return [
    clamp(((box[0] - crop[0]) / height) * 1000),
    clamp(((box[1] - crop[1]) / width) * 1000),
    clamp(((box[2] - crop[0]) / height) * 1000),
    clamp(((box[3] - crop[1]) / width) * 1000),
  ];
}

/**
 * Read the second job's reply: each close-up's parts, still in that close-up's own 0-1000.
 * Index 0 is image 2. A close-up the model skipped is null. A reply cut short keeps the parts it got to.
 */
export function parseSceneMarks(text: string, count: number): (FramePart[] | null)[] {
  const marks: (FramePart[] | null)[] = Array.from({ length: Math.max(0, count) }, () => null);
  const groups: { image: number; items: Record<string, unknown>[] }[] = [];
  const whole = wholeReply(text);
  if (whole) {
    records(whole.subjects).forEach((entry, order) => {
      const image = typeof entry.image === "number" && Number.isInteger(entry.image) ? entry.image : order + 2;
      groups.push({ image, items: records(entry.parts) });
    });
  } else {
    const keys = [...text.matchAll(/"image"\s*:\s*(\d+)/g)].map((match) => ({ at: match.index ?? 0, image: Number(match[1]) }));
    for (const { at, item } of flatObjects(text)) {
      if (!("a" in item && "b" in item)) continue;
      let image = -1;
      for (const key of keys) if (key.at < at) image = key.image;
      if (image < 0) continue;
      const group = groups.find((entry) => entry.image === image);
      if (group) group.items.push(item);
      else groups.push({ image, items: [item] });
    }
  }
  // Image 1 is the whole frame, so a reply that numbers a close-up 1 counted the close-ups from 1.
  const shift = groups.some((group) => group.image === 1) ? 1 : 0;
  for (const group of groups) {
    const index = group.image + shift - 2;
    if (index < 0 || index >= marks.length) continue;
    const parts = group.items.map(readPart).filter((part): part is FramePart => part !== null);
    if (parts.length === 0) continue;
    marks[index] = [...(marks[index] ?? []), ...parts].slice(0, MAX_PARTS);
  }
  return marks;
}

/** A part marked on a close-up, moved onto the chosen frame. The close-up is the crop scaled evenly, so `w` holds. */
export function partOnFrame(part: FramePart, crop: FrameBox): FramePart {
  const place = (point: FramePoint): FramePoint => [
    crop[0] + (point[0] / 1000) * (crop[2] - crop[0]),
    crop[1] + (point[1] / 1000) * (crop[3] - crop[1]),
  ];
  return { ...part, a: place(part.a), b: place(part.b) };
}

/** How far an object's marked ends may stray outside its box, as a share of the box's longer side. */
const OBJECT_SLACK = 0.1;

/**
 * Whether every marked end of an object lies in its box. The box from the first job is reliable for objects;
 * marks that leave it went onto someone sitting on it or something next to it.
 */
function insideBox(parts: readonly FramePart[], box: FrameBox): boolean {
  const slack = OBJECT_SLACK * Math.max(box[2] - box[0], box[3] - box[1]);
  const inside = ([y, x]: FramePoint) => y >= box[0] - slack && y <= box[2] + slack && x >= box[1] - slack && x <= box[3] + slack;
  return parts.every((part) => inside(part.a) && inside(part.b));
}

/** A subject the model did not mark becomes one block over its box, along its longer side. */
function wholeBlock(subject: FoundSubject, aspect: number): FramePart {
  const [y0, x0, y1, x1] = subject.box;
  const tall = y1 - y0;
  const wide = (x1 - x0) * (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
  if (tall >= wide) {
    const x = (x0 + x1) / 2;
    return { name: subject.name, a: [y1, x], b: [y0, x], w: Math.min(3, wide / Math.max(tall, 1)), d: 0.8, z: 0 };
  }
  const y = (y0 + y1) / 2;
  return { name: subject.name, a: [y, x0], b: [y, x1], w: Math.min(3, tall / Math.max(wide, 1)), d: 0.8, z: 0 };
}

const CAR_WHEEL = /\b(wheel|tire|tyre)s?\b/i;
const CAR_CABIN = /\b(cabin|cab|roof|windows?)\b/i;
const CAR_BODY = /\b(body|chassis|hull)\b/i;
/** A car's body, from the sill to the windows, is at most this share of its box's height thick. */
const CAR_BODY_SHARE = 0.5;
/** Its cabin is at least this share of the box's height tall. */
const CAR_CABIN_SHARE = 0.18;
/** A car's depth over its length as it looks: about 0.4 from the side, up to 2.5 from the front. */
const CAR_DEPTH_RANGE: readonly [number, number] = [0.4, 2.5];
/** The cabin is a little narrower than the body. */
const CAR_CABIN_DEPTH = 0.85;

/**
 * A car, van or truck squared up. The model's line through the body is right, with its ends and its slant
 * (a car seen at an angle slants), but it marks the body about twice as thick as it is, and a body that thick
 * swallows its cabin and its wheels. So the body is at most half as thick as the car is tall, and the cabin
 * stands level on it, between its marked ends, up to the roof: the top of the car's box.
 */
function shapeCar(found: FoundSubject, parts: FramePart[], aspect: number): FramePart[] {
  const cabin = parts.find((part) => CAR_CABIN.test(part.name));
  const body = parts.find((part) => part !== cabin && !CAR_WHEEL.test(part.name) && CAR_BODY.test(part.name));
  if (found.kind !== "vehicle" || !cabin || !body) return parts;
  const wide = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const top = found.box[0];
  const height = found.box[2] - top;
  const [front, back] = body.a[1] <= body.b[1] ? [body.a, body.b] : [body.b, body.a];
  const span = back[1] - front[1];
  if (span * wide < 1 || height < 1) return parts;
  const length = Math.hypot(span * wide, back[0] - front[0]);
  const thick = Math.min(body.w * length, CAR_BODY_SHARE * height);
  const depth = Math.min(CAR_DEPTH_RANGE[1], Math.max(CAR_DEPTH_RANGE[0], body.w * body.d)) * length;
  const lineAt = (x: number) => front[0] + ((back[0] - front[0]) * (x - front[1])) / span;
  const from = Math.max(front[1], Math.min(cabin.a[1], cabin.b[1]));
  const to = Math.min(back[1], Math.max(cabin.a[1], cabin.b[1]));
  const [x0, x1] = to - from > span * 0.15 ? [from, to] : [front[1] + span * 0.2, back[1] - span * 0.2];
  // The cabin's floor is the body's top under its lower end, so no gap shows between them.
  const floor = Math.max(lineAt(x0), lineAt(x1)) - thick / 2;
  const tall = Math.max(floor - top, CAR_CABIN_SHARE * height);
  const middle = floor - tall / 2;
  return [
    { ...body, a: front, b: back, w: thick / length, d: depth / thick, z: 0 },
    {
      name: cabin.name,
      a: [middle, x0],
      b: [middle, x1],
      w: tall / ((x1 - x0) * wide),
      d: (CAR_CABIN_DEPTH * depth) / tall,
      z: 0,
    },
    ...parts.filter((part) => part !== body && part !== cabin),
  ];
}

/**
 * Put both jobs together: every found subject, with its parts moved from its close-up onto the frame.
 * A subject left unmarked, or an object marked outside its box, is one block over its box.
 * A car's body is thinned to its real thickness, with its cabin standing on it, so its wheels show.
 */
export function assembleScene(find: SceneFind, marks: readonly (FramePart[] | null)[], crops: readonly FrameBox[], aspect: number): SubjectScene {
  const subjects = find.subjects.map((found, index): SceneSubject => {
    const marked = marks[index];
    const crop = crops[index];
    const placed = marked && crop ? marked.map((part) => partOnFrame(part, crop)) : null;
    const parts = placed && (found.kind !== "object" || insideBox(placed, found.box)) ? shapeCar(found, placed, aspect) : [wholeBlock(found, aspect)];
    return { name: found.name, kind: found.kind, m: found.m, parts };
  });
  return { frame: find.frame, subject: find.subject, subjects };
}

/** Mock mode's first reply: two people at a table, read exactly like the model's. */
export const MOCK_FIND_REPLY = JSON.stringify({
  frame: 1,
  subjects: [
    { name: "person waving", kind: "person", box: [150, 300, 900, 450], m: 1.75 },
    { name: "person standing", kind: "person", box: [220, 560, 880, 690], m: 1.65 },
    { name: "table", kind: "object", box: [640, 420, 860, 600], m: 0.75 },
  ],
});

/** Mock mode's second reply: each subject's parts on its own close-up, as the model marks them. */
export const MOCK_MARK_REPLY = JSON.stringify({
  subjects: [
    {
      image: 2,
      parts: [
        { name: "head", a: [216, 499], b: [118, 499], w: 0.75, d: 1, z: 0 },
        { name: "torso", a: [225, 499], b: [450, 499], w: 0.62, d: 0.55, z: 0 },
        { name: "hips", a: [450, 499], b: [535, 499], w: 1.3, d: 0.6, z: 0 },
        { name: "left upper arm", a: [245, 385], b: [393, 368], w: 0.3, d: 1, z: 0 },
        { name: "left forearm", a: [393, 368], b: [510, 362], w: 0.27, d: 1, z: 0 },
        { name: "right upper arm", a: [245, 613], b: [240, 850], w: 0.3, d: 1, z: 0 },
        { name: "right forearm", a: [240, 850], b: [125, 862], w: 0.27, d: 1, z: 1 },
        { name: "left thigh", a: [535, 460], b: [715, 455], w: 0.36, d: 1, z: 0 },
        { name: "left shin", a: [715, 455], b: [880, 452], w: 0.28, d: 1, z: 0 },
        { name: "right thigh", a: [535, 540], b: [715, 548], w: 0.36, d: 1, z: 0 },
        { name: "right shin", a: [715, 548], b: [880, 556], w: 0.28, d: 1, z: 0 },
      ],
    },
    {
      image: 3,
      parts: [
        { name: "head", a: [228, 500], b: [125, 502], w: 0.76, d: 1, z: 0 },
        { name: "torso", a: [238, 500], b: [470, 500], w: 0.6, d: 0.55, z: 0 },
        { name: "hips", a: [470, 500], b: [555, 500], w: 1.25, d: 0.6, z: 0 },
        { name: "left upper arm", a: [258, 390], b: [406, 382], w: 0.3, d: 1, z: 0 },
        { name: "left forearm", a: [406, 382], b: [523, 390], w: 0.27, d: 1, z: 0 },
        { name: "right upper arm", a: [258, 610], b: [406, 618], w: 0.3, d: 1, z: 0 },
        { name: "right forearm", a: [406, 618], b: [523, 610], w: 0.27, d: 1, z: 0 },
        { name: "left thigh", a: [555, 462], b: [730, 458], w: 0.36, d: 1, z: 0 },
        { name: "left shin", a: [730, 458], b: [880, 456], w: 0.28, d: 1, z: 0 },
        { name: "right thigh", a: [555, 538], b: [730, 542], w: 0.36, d: 1, z: 0 },
        { name: "right shin", a: [730, 542], b: [880, 544], w: 0.28, d: 1, z: 0 },
      ],
    },
    {
      image: 4,
      parts: [
        { name: "table top", a: [190, 110], b: [190, 890], w: 0.06, d: 4, z: 0 },
        { name: "left leg", a: [225, 170], b: [855, 170], w: 0.07, d: 1, z: 0 },
        { name: "right leg", a: [225, 830], b: [855, 830], w: 0.07, d: 1, z: 0 },
      ],
    },
  ],
});

/**
 * The look of the playblast: Qwen Image Edit (open source) redraws the clip's first frame as a rough grey blocking pass.
 * The browser un-renders the frame into this image tile by tile while the video renders,
 * and the video job gets it as VACE's look reference, so every frame matches it.
 */
export const STILL_PROMPT = `Turn this exact shot into a rough Blender solid-viewport blocking playblast. Same camera, same framing, same people in the same poses and places, same objects, same layout. Everything is untextured matte light-grey under flat studio light with soft grey shadows and a plain pale-grey sky, including every costume, vehicle, sign and prop: nothing keeps its original color. Each person becomes a simple low-detail grey mannequin built from smooth primitive shapes: a plain sphere-like head with no face and no hair, a simple torso shape, limbs as smooth capsules, simple rounded hands and feet, no clothes details at all. Animals become simple grey animal shapes. Cars, bicycles and props stay the same objects as simplified grey stand-ins that keep only their main shape; never turn an object into a person. Buildings become a few large plain boxes, the ground a flat plane with a faint grid. Very low detail, like a first animation blocking pass in a 3D viewport. No color, no text.`;

export const STILL_MODEL = "qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui.safetensors";

/** One Qwen Image Edit job (4 steps): node 1 is the first frame, node 3 saves the grey still with its colour taken out. */
export function buildStillWorkflow(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "frame.png" }, _meta: { title: "First frame" } },
    "10": { class_type: "UNETLoader", inputs: { unet_name: STILL_MODEL, weight_dtype: "default" }, _meta: { title: "Qwen Image Edit 2511 (4-step)" } },
    "11": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" },
      _meta: { title: "Qwen text encoder" },
    },
    "12": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" }, _meta: { title: "Qwen VAE" } },
    "13": {
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["1", 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 },
      _meta: { title: "1 megapixel" },
    },
    "14": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["11", 0], vae: ["12", 0], image1: ["13", 0], prompt: STILL_PROMPT },
      _meta: { title: "Playblast look" },
    },
    "15": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["11", 0], vae: ["12", 0], image1: ["13", 0], prompt: "" },
      _meta: { title: "Empty negative" },
    },
    "16": { class_type: "VAEEncode", inputs: { pixels: ["13", 0], vae: ["12", 0] }, _meta: { title: "Encode frame" } },
    "17": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["10", 0], shift: 3 }, _meta: { title: "Shift" } },
    "18": {
      class_type: "KSampler",
      inputs: {
        model: ["17", 0],
        positive: ["14", 0],
        negative: ["15", 0],
        latent_image: ["16", 0],
        seed: 7,
        steps: 4,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
      _meta: { title: "Sample (4 steps)" },
    },
    "19": { class_type: "VAEDecode", inputs: { samples: ["18", 0], vae: ["12", 0] }, _meta: { title: "Decode" } },
    "2": {
      class_type: "ImageDesaturate+",
      inputs: { image: ["19", 0], factor: 1, method: "luminance (Rec.709)" },
      _meta: { title: "No color" },
    },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "reverse-3d/still" }, _meta: { title: "Playblast still" } },
  };
}

/**
 * The still for a visitor's own key (the Kling path): one Nano Banana 2 Lite job, a partner node billed to that key.
 * Node 1 is the first frame, node 3 saves the grey still.
 */
export const KLING_STILL_PROMPT = `Turn this exact shot into a rough Blender solid-viewport blocking playblast. Same camera, same framing, same people in the same poses and places, same objects, same layout. Everything is untextured matte light-grey under flat studio light with soft grey shadows and a plain pale-grey sky. Each person becomes a simple low-detail grey mannequin built from smooth primitive shapes: a plain sphere-like head with no face and no hair, a simple torso shape, limbs as smooth capsules, simple rounded hands and feet, no clothes details at all. Animals become simple grey animal shapes. Cars, bicycles and props stay the same objects as simplified grey stand-ins that keep only their main shape; never turn an object into a person. Buildings become a few large plain boxes, the ground a flat plane with a faint grid. Very low detail, like a first animation blocking pass in a 3D viewport. No color, no text.`;

export const KLING_STILL_MODEL = "Nano Banana 2 Lite";

export function buildKlingStillWorkflow(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "frame.png" }, _meta: { title: "First frame" } },
    "2": {
      class_type: "GeminiNanoBanana2V2",
      inputs: {
        prompt: KLING_STILL_PROMPT,
        model: KLING_STILL_MODEL,
        "model.aspect_ratio": "auto",
        "model.resolution": "1K",
        "model.thinking_level": "MINIMAL",
        "model.images.image_1": ["1", 0],
        seed: 7,
        response_modalities: "IMAGE",
      },
      _meta: { title: "Playblast look" },
    },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "reverse-3d/still" }, _meta: { title: "Playblast still" } },
  };
}

/** The saved still among a job's outputs. */
export function selectImageOutput(outputs: readonly NamedOutput[]): NamedOutput | null {
  return outputs.find((item) => /\.(png|jpe?g|webp)$/i.test(item.name)) ?? null;
}
