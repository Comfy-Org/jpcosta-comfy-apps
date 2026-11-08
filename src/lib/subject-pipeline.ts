import type { Workflow } from "@/lib/workflow";

/** Frames sent to the model. The clip is already trimmed to 10 seconds. */
export const SUBJECT_FRAME_CAP = 12;

/**
 * Share of the image-to-3D face count kept before the browser.
 * The slider's right end is this reduced mesh, drawn as boxes.
 */
export const MESH_KEEP_FRACTION = 0.3;

export const SUBJECT_PROMPT = `These {count} images are frames from one clip, in order. Image 1 is the earliest.
Name the single main subject, the person or object the clip is about.
Choose the one frame where that subject is easiest to see: large, unobstructed, and not blurred.
Reply with exactly two lines and no other text:
frame: <integer from 1 to {count}>
subject: <a short name>`;

/** Gemini looks at every sampled frame and names the subject and the frame. */
export function buildPickWorkflow(frameCount: number): Workflow {
  const count = Math.max(1, Math.min(SUBJECT_FRAME_CAP, Math.round(frameCount)));
  const workflow: Workflow = {};
  const prompt = SUBJECT_PROMPT.replaceAll("{count}", String(count));
  const gemini: Record<string, unknown> = {
    model: "Gemini 3.5 Flash",
    "model.prompt": prompt,
    "model.thinking_level": "LOW",
    "model.max_output_tokens": 256,
    "model.seed": 0,
    "model.system_prompt": "You identify the main subject of a clip. Reply in the exact two-line format you are given.",
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
    _meta: { title: "Name the subject and frame" },
  };
  workflow["21"] = {
    class_type: "SaveText",
    inputs: {
      text: ["20", 0],
      filename_prefix: "reverse-3d/subject",
      format: "txt",
    },
    _meta: { title: "Subject choice" },
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
 * Hunyuan3D on the Reverse 3D deployment.
 * That host is partner-only, so this graph has no `LoadBackgroundRemovalModel`.
 * Node 21 is the job output, same slot the playblast graph uses for its save.
 */
export function buildHunyuanWorkflow(): Workflow {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: "subject.png" },
      _meta: { title: "Cut-out subject" },
    },
    "21": {
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
  };
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
