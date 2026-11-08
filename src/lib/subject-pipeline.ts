import type { Workflow } from "@/lib/workflow";

/** Frames sent to the model. The clip is already trimmed to 10 seconds. */
export const SUBJECT_FRAME_CAP = 12;

/**
 * Share of the image-to-3D face count kept before the browser.
 * The slider's right end is this reduced mesh, drawn as boxes.
 */
export const MESH_KEEP_FRACTION = 0.3;

export const SUBJECT_PROMPT = `These {count} images are frames from one clip, in order. Image 1 is the earliest.
The shot will be rebuilt as a grey 3D blockout seen from the same camera, so every block has to sit exactly on the part it stands for in the frame.

1. Name the single main subject: the person, animal or object the clip is about.
2. Choose the frame where the subject is easiest to see: large, sharp, whole and not hidden.
3. In that frame, split the subject into 5 to 14 parts that each read as one box. For a person: head, torso, hips, upper arms, forearms, thighs, shins, and hands or feet when they are clearly visible. For an animal: head, neck, body, legs, tail. For a vehicle: body, cabin, wheels. For a simple object: a few big pieces.
   Mark each part's long axis with two points through the middle of the part: "a" at one end and "b" at the other. For a forearm: elbow to wrist. For a torso: the base of the neck to the waist. For a head: the chin to the top of the head. Follow the pose exactly as it is in the frame.
   "w" is the part's width across that axis divided by the axis length. "d" is its depth along the camera's view divided by that width (1 = as deep as it is wide). "z" is 1 when the part is clearly closer to the camera than the body, -1 when it is clearly farther, otherwise 0.
4. Add up to 3 other solid objects that the subject touches, holds or stands right beside, at about the same distance from the camera: a chair they sit on, a table they lean on, a bike they ride, a board they carry. Never the floor, a wall, the sky, a building, a tree, or anything farther back.
   Mark each one like a part: "a" and "b" at the two ends of its longest side as it looks in the frame, through its middle, so a board held at a slant gets a slanted axis. Give "w", "d" and "z" as above, with "z" compared with the subject.
Points are [y, x], normalized to 0-1000 on the chosen frame.

Reply with JSON only, in this shape:
{"frame": <integer from 1 to {count}>, "subject": "<short name>", "parts": [{"name": "head", "a": [y, x], "b": [y, x], "w": 0.8, "d": 1, "z": 0}], "props": [{"name": "table", "a": [y, x], "b": [y, x], "w": 0.6, "d": 1, "z": -1}]}`;

/** Gemini looks at every sampled frame, picks the subject and the frame, and marks its parts on that frame. */
export function buildPickWorkflow(frameCount: number): Workflow {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const workflow: Workflow = {};
  const prompt = SUBJECT_PROMPT.replaceAll("{count}", String(count));
  const gemini: Record<string, unknown> = {
    model: "Gemini 3.5 Flash",
    "model.prompt": prompt,
    // LOW leaves a little room to reason about the pose and stays a few seconds long.
    // The cap includes thinking, so it stays well above the short JSON answer.
    "model.thinking_level": "LOW",
    "model.max_output_tokens": 8192,
    "model.seed": 0,
    "model.system_prompt": "You mark the parts of a video's main subject on one frame, precisely, so a 3D blockout can be built over it. Reply with JSON only.",
    "model.temperature": 0,
    "model.top_p": 0.95,
  };
  for (let index = 0; index < count; index += 1) {
    const node = String(index + 1);
    workflow[node] = {
      class_type: "LoadImage",
      inputs: { image: `frame_${index + 1}.png` },
      _meta: { title: `Frame ${index + 1}` },
    };
    gemini[`model.images.image_${index + 1}`] = [node, 0];
  }
  workflow["20"] = {
    class_type: "GeminiNodeV3",
    inputs: gemini,
    _meta: { title: "Pick the subject and mark its parts" },
  };
  workflow["21"] = {
    class_type: "SaveText",
    inputs: {
      text: ["20", 0],
      filename_prefix: "reverse-3d/subject",
      format: "txt",
    },
    _meta: { title: "Subject and parts" },
  };
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

/** One part of the subject as the model marked it on the chosen frame. */
export type FramePart = {
  name: string;
  /** The two ends of the part's long axis. */
  a: FramePoint;
  b: FramePoint;
  /** Width across the axis, divided by the axis length. */
  w: number;
  /** Depth along the camera's view, divided by the width. */
  d: number;
  /** 1 closer to the camera than the body, -1 farther, 0 level with it. */
  z: -1 | 0 | 1;
};

/** Something next to the subject: marked like a part along its longest side, or as a plain box. */
export type FrameProp = {
  name: string;
  /** The two ends of its longest side, and its width across that side divided by the side's length. */
  a?: FramePoint;
  b?: FramePoint;
  w?: number;
  /** Used when there is no a and b: [ymin, xmin, ymax, xmax], each 0-1000. */
  box?: [number, number, number, number];
  /** Depth along the camera's view, divided by the width. */
  d: number;
  /** 1 in front of the subject, -1 behind it, 0 level with it. */
  z: -1 | 0 | 1;
};

export type SubjectScene = SubjectChoice & { parts: FramePart[]; props: FrameProp[] };

const MAX_PARTS = 16;
const MAX_PROPS = 3;

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

function readProp(item: Record<string, unknown>): FrameProp | null {
  const a = framePoint(item.a);
  const b = framePoint(item.b);
  if (a && b) {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) return null;
    return { name: label(item.name, "prop"), a, b, w: ratio(item.w, 0.5, 3), d: ratio(item.d, 0.8, 4), z: side(item.z) };
  }
  const raw = Array.isArray(item.box_2d) ? item.box_2d : Array.isArray(item.box) ? item.box : null;
  if (!raw || raw.length < 4) return null;
  const [y0, x0, y1, x1] = raw.slice(0, 4).map(unit);
  if (y0 === null || x0 === null || y1 === null || x1 === null) return null;
  const box: [number, number, number, number] = [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)];
  if (box[2] - box[0] < 4 || box[3] - box[1] < 4) return null;
  return { name: label(item.name, "prop"), box, d: ratio(item.d, 0.8, 4), z: side(item.z) };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

/**
 * Read the frame, the subject, the parts and the props from the model's JSON.
 * A reply that was cut short still gives the parts it got to: each object is read on its own.
 */
export function parseSubjectScene(text: string, frameCount: number): SubjectScene {
  const choice = parseSubjectChoice(text, frameCount);
  let partItems: Record<string, unknown>[] = [];
  let propItems: Record<string, unknown>[] = [];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let whole: unknown = null;
  if (start >= 0 && end > start) {
    try {
      whole = JSON.parse(text.slice(start, end + 1));
    } catch {
      whole = null;
    }
  }
  if (whole && typeof whole === "object") {
    partItems = records((whole as Record<string, unknown>).parts);
    propItems = records((whole as Record<string, unknown>).props);
  } else {
    // Props are marked like parts, so an object is a prop when it comes after the "props" key.
    const propsAt = text.search(/"props"\s*:/);
    for (const match of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        const item = JSON.parse(match[0]) as unknown;
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const isProp = "box_2d" in record || "box" in record || (propsAt >= 0 && (match.index ?? 0) > propsAt);
        if (isProp) propItems.push(record);
        else if ("a" in record && "b" in record) partItems.push(record);
      } catch {
        // A cut-off object at the end of the reply.
      }
    }
  }
  const parts = partItems.map(readPart).filter((part): part is FramePart => part !== null).slice(0, MAX_PARTS);
  const props = propItems.map(readProp).filter((prop): prop is FrameProp => prop !== null).slice(0, MAX_PROPS);
  if (parts.length === 0) throw new Error("The model did not mark any parts.");
  return { ...choice, parts, props };
}

/** What the mock server says Gemini replied: a person waving next to a table on a 16:9 frame. Not a model answer. */
export const MOCK_SCENE_REPLY = JSON.stringify({
  frame: 1,
  subject: "The main subject",
  parts: [
    { name: "head", a: [262, 462], b: [168, 461], w: 0.85, d: 1, z: 0 },
    { name: "torso", a: [282, 461], b: [475, 462], w: 0.62, d: 0.55, z: 0 },
    { name: "hips", a: [470, 462], b: [540, 462], w: 1.45, d: 0.6, z: 0 },
    { name: "left upper arm", a: [300, 426], b: [440, 412], w: 0.28, d: 1, z: 0 },
    { name: "left forearm", a: [440, 412], b: [566, 420], w: 0.26, d: 1, z: 1 },
    { name: "right upper arm", a: [300, 498], b: [240, 560], w: 0.34, d: 1, z: 0 },
    { name: "right forearm", a: [240, 560], b: [128, 572], w: 0.3, d: 1, z: 0 },
    { name: "left thigh", a: [540, 448], b: [700, 444], w: 0.38, d: 1, z: 0 },
    { name: "left shin", a: [700, 444], b: [868, 442], w: 0.3, d: 1, z: 0 },
    { name: "right thigh", a: [540, 476], b: [700, 486], w: 0.38, d: 1, z: 0 },
    { name: "right shin", a: [700, 486], b: [868, 492], w: 0.3, d: 1, z: 0 },
  ],
  props: [{ name: "table", a: [690, 600], b: [690, 800], w: 0.7, d: 1.2, z: -1 }],
});
