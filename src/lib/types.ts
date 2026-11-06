export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "canceling"
  | "canceled"
  | "failed"
  | "expired";

export type JobOutput = {
  id: string;
  nodeId: string;
  name: string;
  /** HMAC of `id`. Present on responses from GET /api/jobs. Required to download. */
  sig?: string;
};

export type JobView = {
  id: string;
  status: JobStatus;
  progress: number | null;
  outputs: JobOutput[];
  error: { code: string; message: string } | null;
};

export type RunResponse = {
  jobId: string;
  idempotencyKey: string;
  /** Exact JSON body posted to the deployment's POST /api/v2/jobs, with the partner key redacted. */
  request: unknown;
  deployment?: { slug: string; endpointUrl: string; deploymentId: string };
};

export type SegControl = {
  type: "seg";
  key: string;
  label: string;
  options: { value: string; label: string }[];
  default: string;
  clientOnly?: boolean;
};

export type SelectControl = {
  type: "select";
  key: string;
  label: string;
  options: { value: string; label: string }[];
  default: string;
  clientOnly?: boolean;
};

export type SliderControl = {
  type: "slider";
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  clientOnly?: boolean;
};

export type TextControl = {
  type: "text";
  key: string;
  label: string;
  placeholder: string;
  default: string;
  /** Single-line input. Textareas are the default. */
  multiline?: boolean;
  optional?: boolean;
  hint?: string;
  clientOnly?: boolean;
};

export type CardsControl = {
  type: "cards";
  key: string;
  label: string;
  options: { value: string; label: string; image: string }[];
  default: string;
  hint?: string;
};

export type ClientControl = SegControl | SelectControl | SliderControl | TextControl | CardsControl;

export type CatalogImage = {
  key: string;
  label: string;
  optional?: boolean;
  accept?: "image" | "video";
  multiple?: boolean;
  maxCount?: number;
  hint?: string;
};

export type SpriteGrid = {
  cols: number;
  rows: number;
};

export type CatalogApp = {
  id: string;
  name: string;
  icon: string;
  runLabel: string;
  endpoint: string;
  views: string[];
  kind: "relight" | "upscale" | "sprite" | "tryon" | "cutout" | "swap" | "paparazzi" | "product-swap" | "unboxing" | "carve" | "reverse-3d";
  images: CatalogImage[];
  controls: ClientControl[];
  hasSeed: boolean;
  empty: string;
  tagline?: string;
  grids?: Record<string, SpriteGrid>;
  /** image still, or an mp4 the result viewer plays. */
  output: "image" | "video";
  /** How long the browser keeps polling. Video jobs use 15 minutes. */
  pollMs: number;
};

export const LILAC = "#DBD6F2";

export const TERMINAL_STATUSES: JobStatus[] = ["succeeded", "canceled", "failed", "expired"];
