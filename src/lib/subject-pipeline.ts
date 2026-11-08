import type { Workflow } from "@/lib/workflow";

/** Frames sent to the model. The clip is already trimmed to 10 seconds. */
export const SUBJECT_FRAME_CAP = 12;

/**
 * Share of the image-to-3D face count kept before the browser.
 * The slider's right end is this reduced mesh, drawn as boxes.
 */
export const MESH_KEEP_FRACTION = 0.3;

export const SUBJECT_PROMPT = `These {count} images are frames from one clip, in order. Image 1 is the earliest.
This shot will be rebuilt as a toy made of a few big grey blocks, like a 3D blockout.

1. Name the single main subject, the person, animal or object the clip is about.
2. Choose the one frame where that subject is easiest to see: large, unobstructed, and not blurred.
3. In that frame, describe the subject as 5 to 12 big blocks, one per part. For a person: head, torso, hips, upper arms, forearms, thighs, shins. For a car: body, cabin, wheels. Match the pose and the proportions you see.
4. Add 0 to 4 big blocks for the largest things right next to the subject, such as a table, a chair, a wall, a car or a rock. Skip the sky, the ground itself and anything small.

Coordinates, as seen from the camera of that frame:
- The subject is 1 unit tall.
- y points up, and y = 0 is the ground under the subject.
- x points to the right of the image, z points toward the camera.
- The subject is centred on x = 0, z = 0.
Each block is a box that is not rotated. Give the x of its centre, the y of its bottom, the z of its centre, then its width along x, height along y and depth along z. Blocks may touch or overlap a little. Nothing goes below y = 0.

Reply with only these lines and no other text:
frame: <integer from 1 to {count}>
subject: <a short name>
part: <name> | <x> <bottom y> <z> | <width> <height> <depth>
prop: <name> | <x> <bottom y> <z> | <width> <height> <depth>
Write one part line per subject block and one prop line per block around it. For example:
part: head | 0 0.86 0 | 0.15 0.14 0.16`;

/** Gemini looks at every sampled frame, picks the subject and the frame, and lays the shot out as blocks. */
export function buildPickWorkflow(frameCount: number): Workflow {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const workflow: Workflow = {};
  const prompt = SUBJECT_PROMPT.replaceAll("{count}", String(count));
  const gemini: Record<string, unknown> = {
    model: "Gemini 3.5 Flash",
    "model.prompt": prompt,
    // LOW leaves a little room to reason about the pose and stays a few seconds long.
    // The cap includes thinking, so it stays well above the 20 short lines of the answer.
    "model.thinking_level": "LOW",
    "model.max_output_tokens": 4096,
    "model.seed": 0,
    "model.system_prompt": "You turn a video shot into a simple 3D blockout made of boxes. Reply only in the exact line format you are given.",
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
    _meta: { title: "Pick the subject and lay it out as blocks" },
  };
  workflow["21"] = {
    class_type: "SaveText",
    inputs: {
      text: ["20", 0],
      filename_prefix: "reverse-3d/subject",
      format: "txt",
    },
    _meta: { title: "Subject and blocks" },
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

/** Read the two-line reply. A missing frame number is not a guess from the pixels. */
export function parseSubjectChoice(text: string, frameCount: number): SubjectChoice {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const frameMatch = /frame\s*[:=]\s*(\d+)/i.exec(text);
  const subjectMatch = /subject\s*[:=]\s*([^\n\r]+)/i.exec(text);
  if (!frameMatch) throw new Error("The model did not choose a frame.");
  const frame = Number(frameMatch[1]);
  if (!Number.isInteger(frame) || frame < 1 || frame > count) {
    throw new Error("The model chose a frame that was not sampled.");
  }
  const subject = (subjectMatch?.[1] ?? "").trim();
  if (!subject) throw new Error("The model did not name a subject.");
  return { frame: frame - 1, subject };
}

/** One box from the model, in subject units: the subject is 1 tall and stands on y = 0. */
export type SceneBlock = {
  name: string;
  /** A piece of the subject, or something next to it. */
  kind: "part" | "prop";
  x: number;
  /** Height of the box's bottom above the ground. */
  bottom: number;
  z: number;
  width: number;
  height: number;
  depth: number;
};

export type SubjectScene = SubjectChoice & { blocks: SceneBlock[] };

const MAX_PARTS = 14;
const MAX_PROPS = 4;
const BLOCK_LINE = /^[\s*>-]*(part|prop)\s*:\s*([^|\n\r]*)\|([^|\n\r]+)\|([^\n\r]+)$/gim;

function blockNumbers(text: string): number[] {
  return text
    .replace(/[()[\]`]/g, " ")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
}

/**
 * Read the frame, the subject and the block lines. Lines that do not parse are skipped,
 * so a reply that was cut short still gives the blocks it got to.
 */
export function parseSubjectScene(text: string, frameCount: number): SubjectScene {
  const choice = parseSubjectChoice(text, frameCount);
  const blocks: SceneBlock[] = [];
  let parts = 0;
  let props = 0;
  for (const match of text.matchAll(BLOCK_LINE)) {
    const kind = match[1]?.toLowerCase() === "prop" ? "prop" : "part";
    const place = blockNumbers(match[3] ?? "");
    const size = blockNumbers(match[4] ?? "");
    if (place.length < 3 || size.length < 3) continue;
    const [x, bottom, z] = place as [number, number, number];
    const [width, height, depth] = size as [number, number, number];
    if (![x, bottom, z, width, height, depth].every(Number.isFinite)) continue;
    if (width <= 0 || height <= 0 || depth <= 0) continue;
    if (kind === "part" ? parts >= MAX_PARTS : props >= MAX_PROPS) continue;
    const clampSize = (value: number) => Math.min(6, Math.max(0.02, value));
    const clampPlace = (value: number) => Math.min(6, Math.max(-6, value));
    blocks.push({
      name: (match[2] ?? "").trim().slice(0, 40) || (kind === "part" ? "part" : "prop"),
      kind,
      x: clampPlace(x),
      bottom: Math.min(6, Math.max(0, bottom)),
      z: clampPlace(z),
      width: clampSize(width),
      height: clampSize(height),
      depth: clampSize(depth),
    });
    if (kind === "part") parts += 1;
    else props += 1;
  }
  if (parts === 0) throw new Error("The model did not lay out any blocks.");
  return { ...choice, blocks };
}

/** What the mock server says Gemini replied: a person waving next to a table. Not a model answer. */
export const MOCK_SCENE_REPLY = `frame: 1
subject: The main subject
part: left shin | -0.075 0 0 | 0.1 0.27 0.12
part: right shin | 0.075 0 0 | 0.1 0.27 0.12
part: left thigh | -0.075 0.26 0 | 0.12 0.22 0.14
part: right thigh | 0.075 0.26 0 | 0.12 0.22 0.14
part: hips | 0 0.46 0 | 0.3 0.1 0.18
part: torso | 0 0.55 0 | 0.32 0.28 0.2
part: head | 0 0.85 0 | 0.15 0.15 0.16
part: left upper arm | -0.2 0.56 0 | 0.08 0.26 0.08
part: left forearm | -0.2 0.34 0.02 | 0.07 0.23 0.07
part: right upper arm | 0.24 0.75 0 | 0.17 0.07 0.08
part: right forearm | 0.35 0.75 0 | 0.07 0.21 0.07
prop: table | 0.75 0 -0.15 | 0.6 0.42 0.5
prop: wall | 0.1 0 -0.55 | 2 1.3 0.1`;
