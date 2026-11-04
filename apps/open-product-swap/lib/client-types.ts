import type { ComfyOutputFile, JobStatus, PipelineId } from "./types";

export type SkuDraft = {
  id: string;
  name: string;
  photos: { id: string; file: File; url: string }[];
};

export type ClientJob = {
  id: string;
  skuId: string;
  skuName: string;
  pipeline: PipelineId;
  status: JobStatus;
  progress?: number;
  message?: string;
  error?: string;
  outputs: ComfyOutputFile[];
};
