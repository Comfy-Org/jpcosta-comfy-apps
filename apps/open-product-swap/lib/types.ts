export type PipelineId = "ltx" | "wan-vace";

export type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ComfyWorkflow = Record<string, ComfyNode>;

export type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "lost";

export type ComfyOutputFile = {
  id?: string;
  filename: string;
  subfolder?: string;
  type?: string;
  format?: string;
};

export type SwapJob = {
  id: string;
  skuId: string;
  skuName: string;
  pipeline: PipelineId;
  status: JobStatus;
  progress?: number;
  message?: string;
  error?: string;
  outputs: ComfyOutputFile[];
  createdAt: string;
};

export const PIPELINES: {
  id: PipelineId;
  label: string;
  blurb: string;
  file: string;
}[] = [
  {
    id: "ltx",
    label: "LTX-2.3 IC-LoRA",
    blurb: "Core video model for the Comfy LTX bonus. SAM3 mask → FLUX 3 keyframe → LTX in-outpainting.",
    file: "product-swap-ltx.json",
  },
  {
    id: "wan-vace",
    label: "Wan 2.1 VACE",
    blurb: "Open-weights video inpaint. SAM3 mask → FLUX 3 keyframe → Wan VACE + CausVid 4-step.",
    file: "product-swap-wan-vace.json",
  },
];
