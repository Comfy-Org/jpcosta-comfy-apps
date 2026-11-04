export type PipelineMode = "ltx" | "h3";
export type EditEngine = "flux3" | "qwen";

export type BoxId = "kraft_mailer" | "rigid_luxury" | "tissue_wrap";

export type InsertRect = {
  /** Normalized 0–1, relative to the empty plate. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BoxPreset = {
  id: BoxId;
  name: string;
  blurb: string;
  /** Inner well size in millimetres, used only as a scale hint. */
  innerMm: { w: number; h: number; d: number };
  lidOn: string;
  empty: string;
  mask: string;
  /** Fallback well if the magenta mask cannot be read. */
  insert: InsertRect;
};

export type JobStage =
  | "queued"
  | "uploading"
  | "cutout"
  | "composite"
  | "keyframes"
  | "animate"
  | "concat"
  | "done"
  | "error";

export type JobEvent = {
  t: number;
  stage: JobStage;
  message: string;
  promptId?: string;
};

export type JobRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: JobStage;
  mode: PipelineMode;
  editEngine: EditEngine;
  boxId: BoxId;
  photoCount: number;
  hasLogo: boolean;
  events: JobEvent[];
  error?: string;
  outputRelpath?: string;
  keyframeRelpaths?: string[];
  clipRelpaths?: string[];
};

export type GenerateRequestMeta = {
  boxId: BoxId;
  mode: PipelineMode;
  editEngine: EditEngine;
};
