import { readFile } from "fs/promises";
import path from "path";
import type { ComfyNode, ComfyWorkflow, PipelineId } from "./types";
import { PIPELINES } from "./types";

export type WorkflowPatch = {
  pipeline: PipelineId;
  videoFilename: string;
  skuFilenames: string[];
  maskObject: string;
  prompt: string;
  seed: number;
  width?: number;
  height?: number;
  durationSec?: number;
  frames?: number;
  /** Skip FLUX 3 partner node; wire SKU photo as VACE/LTX reference. */
  skipPartnerNodes?: boolean;
};

function asWorkflow(raw: unknown): ComfyWorkflow {
  if (!raw || typeof raw !== "object") throw new Error("Invalid workflow JSON");
  const rec = raw as Record<string, unknown>;
  const out: ComfyWorkflow = {};
  for (const [id, node] of Object.entries(rec)) {
    if (id === "_meta") continue;
    if (!node || typeof node !== "object") continue;
    const n = node as ComfyNode;
    if (!n.class_type || !n.inputs) continue;
    out[id] = {
      class_type: n.class_type,
      inputs: { ...n.inputs },
      _meta: n._meta,
    };
  }
  return out;
}

export async function loadWorkflow(pipeline: PipelineId): Promise<ComfyWorkflow> {
  const spec = PIPELINES.find((p) => p.id === pipeline);
  if (!spec) throw new Error(`Unknown pipeline: ${pipeline}`);
  const filePath = path.join(process.cwd(), "workflows", spec.file);
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return asWorkflow(raw);
}

function nextNodeId(wf: ComfyWorkflow): string {
  const ids = Object.keys(wf)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  return String(Math.max(0, ...ids) + 1);
}

export function patchWorkflow(wf: ComfyWorkflow, patch: WorkflowPatch): ComfyWorkflow {
  const out: ComfyWorkflow = structuredClone(wf);

  const loadVideo = out["1"];
  if (loadVideo?.class_type === "LoadVideo") {
    loadVideo.inputs.file = patch.videoFilename;
  }

  const slice = out["2"];
  if (slice?.class_type === "Video Slice" && patch.durationSec) {
    slice.inputs.duration = patch.durationSec;
  }

  const scale = out["4"];
  if (scale?.class_type === "ImageScale") {
    if (patch.width) scale.inputs.width = patch.width;
    if (patch.height) scale.inputs.height = patch.height;
  }

  const sku = patch.skuFilenames[0];
  if (sku && out["6"]?.class_type === "LoadImage") {
    out["6"].inputs.image = sku;
  }

  const flux = out["8"];
  if (patch.skipPartnerNodes) {
    if (flux?.class_type === "Flux3ImageNode") {
      delete out["8"];
    }
    if (out["20"]?.class_type === "WanVaceToVideo") {
      out["20"].inputs.reference_image = ["7", 0];
    }
    if (out["23"]?.class_type === "LTXVImgToVideoInplace") {
      out["23"].inputs.image = ["7", 0];
    }
    for (const node of Object.values(out)) {
      if (node.class_type === "SaveImage" && Array.isArray(node.inputs.images)) {
        const src = node.inputs.images as [string, number];
        if (src[0] === "8") node.inputs.images = ["7", 0];
      }
    }
  } else if (flux?.class_type === "Flux3ImageNode") {
    flux.inputs.prompt = fluxPrompt(patch.prompt, patch.skuFilenames.length);
    flux.inputs.seed = patch.seed;
    for (let i = 1; i < patch.skuFilenames.length; i += 1) {
      const id = nextNodeId(out);
      out[id] = {
        class_type: "LoadImage",
        inputs: { image: patch.skuFilenames[i] },
        _meta: { title: `SKU photo ${i + 1}` },
      };
      flux.inputs[`images.image_${i + 2}`] = [id, 0];
    }
  }

  if (out["10"]?.class_type === "CLIPTextEncode") {
    out["10"].inputs.text = patch.maskObject;
  }

  const positive = Object.values(out).find(
    (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive",
  );
  if (positive) {
    positive.inputs.text = patch.prompt;
  }

  for (const node of Object.values(out)) {
    if (node.class_type === "KSampler") {
      node.inputs.seed = patch.seed;
    }
    if (node.class_type === "EmptyLTXVLatentVideo") {
      if (patch.width) node.inputs.width = patch.width;
      if (patch.height) node.inputs.height = patch.height;
      if (patch.frames) node.inputs.length = toLtxFrames(patch.frames);
    }
    if (node.class_type === "EmptyImage") {
      // Grey fill for the VACE control video must match the frame size.
      if (patch.width) node.inputs.width = patch.width;
      if (patch.height) node.inputs.height = patch.height;
    }
    if (node.class_type === "WanVaceToVideo") {
      if (patch.width) node.inputs.width = patch.width;
      if (patch.height) node.inputs.height = patch.height;
      if (patch.frames) node.inputs.length = patch.frames;
    }
  }

  return out;
}

function toLtxFrames(n: number): number {
  if (n <= 1) return 9;
  return Math.floor((n - 1) / 8) * 8 + 1;
}

export function wanFrameCount(durationSec: number, fps = 16): number {
  const n = Math.max(9, Math.round(durationSec * fps));
  return Math.floor((n - 1) / 4) * 4 + 1;
}

function fluxPrompt(userPrompt: string, skuCount: number): string {
  const refs =
    skuCount <= 1
      ? "image 2"
      : `images 2–${skuCount + 1} (the same SKU from different angles)`;
  return [
    `Replace the product held in image 1 with the product shown in ${refs}.`,
    "Keep the person's hands, fingers, pose, clothing, background, camera angle and lighting identical.",
    "Seat the new product naturally in the grip with matching perspective, contact shadows and reflections.",
    userPrompt.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

export const DEFAULT_PROMPT =
  "A person holds the replacement product. Photorealistic, original lighting, hands and motion unchanged.";

export const DEFAULT_MASK_OBJECT =
  "product in the person's hand, bottle, can, box, cup, phone";
