import { randomUUID } from "node:crypto";
import type { ComfyOutputFile, ComfyWorkflow, JobStatus } from "./types";

const DEFAULT_BASE = "https://cloud.comfy.org";

export class ComfyError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** Public Cloud, or a Comfy Build serverless URL such as https://dep-xxxx.run.comfy.app */
export function comfyBaseUrl(): string {
  return (process.env.COMFY_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

/** Single key only: COMFY_API_KEY. No other env keys are read. */
export function comfyConfig() {
  const apiKey = process.env.COMFY_API_KEY;
  if (!apiKey) {
    throw new ComfyError(
      "COMFY_API_KEY is not set. Copy .env.example and export a key from https://platform.comfy.org/profile/api-keys",
      500,
    );
  }
  return { apiKey, baseUrl: comfyBaseUrl() };
}

/** Strip anything that looks like the key from upstream error text. */
export function redact(s: string): string {
  const k = process.env.COMFY_API_KEY;
  let out = k ? s.split(k).join("[redacted]") : s;
  const prefix = ["comfy", "ui-"].join("");
  out = out.replace(new RegExp(`(${prefix}|sk-)[A-Za-z0-9_\\-]{8,}`, "gi"), "[redacted]");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.slice(0, 600);
}

function authHeaders(json = false): HeadersInit {
  const { apiKey } = comfyConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function call<T>(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<T> {
  const { baseUrl } = comfyConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    body: init.body,
    headers: { ...authHeaders(false), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ComfyError(
      `Comfy API ${method} ${path.split("?")[0]} -> HTTP ${res.status}: ${redact(text)}`,
      res.status >= 500 ? 502 : res.status,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

function mimeOf(file: Blob, filename: string): string {
  if (file.type) return file.type;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

export type UploadedAsset = {
  id: string;
  filename: string;
  subfolder: string;
  type: string;
};

export type V2Asset = {
  id: string;
  file_path?: string;
  name?: string;
  url?: string;
};

export type V2JobOutput = {
  id: string;
  name: string;
  node_id: string;
  type: string;
  content_type?: string;
  size_bytes?: number;
};

export type V2Job = {
  id: string;
  status:
    | "queued"
    | "running"
    | "canceling"
    | "succeeded"
    | "failed"
    | "canceled"
    | "expired"
    | string;
  progress?: number | null | { value?: number; max?: number; message?: string };
  queue_position?: number | null;
  error?: unknown;
  outputs?: V2JobOutput[] | null;
  message?: string;
};

export async function uploadInput(
  file: File | Blob,
  filename: string,
): Promise<UploadedAsset> {
  const contentType = mimeOf(file, filename);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Field order matters: content_type, file_path, tags BEFORE the file part.
  const form = new FormData();
  form.append("content_type", contentType);
  form.append("file_path", filename);
  form.append("tags", JSON.stringify(["input"]));
  form.append("file", new Blob([bytes], { type: contentType }), filename);

  const asset = await call<V2Asset>("POST", "/api/v2/assets", { body: form });
  const filePath = asset.file_path || asset.name || filename;
  if (!asset.id) {
    throw new ComfyError("Comfy asset upload returned no id", 502);
  }
  return {
    id: asset.id,
    filename: filePath,
    subfolder: "",
    type: "input",
  };
}

export async function submitWorkflow(workflow: ComfyWorkflow): Promise<string> {
  const { apiKey } = comfyConfig();
  const job = await call<V2Job>("POST", "/api/v2/jobs", {
    body: JSON.stringify({
      workflow,
      extra_data: { api_key_comfy_org: apiKey },
    }),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
  });
  if (!job?.id) {
    throw new ComfyError("Comfy submit returned no job id", 502);
  }
  return job.id;
}

const TERMINAL_SUCCESS = new Set(["success", "succeeded", "completed", "complete"]);
const TERMINAL_ERROR = new Set([
  "error",
  "failed",
  "non_retryable_error",
  "lost",
  "expired",
]);
const TERMINAL_CANCEL = new Set(["cancelled", "canceled"]);

export function normalizeStatus(raw: string | undefined): JobStatus {
  const s = (raw || "").toLowerCase();
  if (TERMINAL_SUCCESS.has(s)) return "success";
  if (TERMINAL_ERROR.has(s)) return "error";
  if (TERMINAL_CANCEL.has(s)) return "cancelled";
  if (s.includes("queue") || s === "submitted" || s === "pending") return "queued";
  return "running";
}

export type JobSnapshot = {
  status: JobStatus;
  progress?: number;
  message?: string;
  error?: string;
  outputs: ComfyOutputFile[];
  rawStatus?: string;
};

function errorText(err: unknown): string | undefined {
  if (!err) return undefined;
  if (typeof err === "string") return redact(err);
  try {
    const e = err as { message?: string; type?: string; details?: string };
    return redact(e.message || e.details || JSON.stringify(err));
  } catch {
    return "Job failed";
  }
}

function mapOutputs(outputs: V2JobOutput[] | null | undefined): ComfyOutputFile[] {
  if (!outputs?.length) return [];
  return outputs.map((item) => ({
    id: item.id,
    filename: item.name || item.id,
    subfolder: "",
    type: item.type || "output",
    format: item.content_type,
  }));
}

export async function getJob(id: string): Promise<JobSnapshot> {
  const json = await call<V2Job>("GET", `/api/v2/jobs/${encodeURIComponent(id)}`);
  const status = normalizeStatus(json.status);
  let progress: number | undefined;
  let message: string | undefined;
  if (typeof json.progress === "number") {
    progress = json.progress;
  } else if (json.progress && typeof json.progress === "object") {
    const value = json.progress.value;
    const max = json.progress.max;
    progress =
      typeof value === "number" && typeof max === "number" && max > 0
        ? value / max
        : value;
    message = json.progress.message;
  }
  if (json.queue_position != null && json.queue_position > 0) {
    message = message || `queue position ${json.queue_position}`;
  }
  message = message || json.message;
  const error = status === "error" ? errorText(json.error) : undefined;
  return {
    status,
    progress,
    message,
    error,
    outputs: mapOutputs(json.outputs),
    rawStatus: json.status,
  };
}

export async function downloadOutput(file: ComfyOutputFile): Promise<{
  bytes: ArrayBuffer;
  contentType: string;
}> {
  const assetId = file.id || file.filename;
  if (!assetId) {
    throw new ComfyError("Output asset id is required", 400);
  }
  const asset = await call<V2Asset>(
    "GET",
    `/api/v2/assets/${encodeURIComponent(assetId)}`,
  );
  if (!asset.url) {
    throw new ComfyError("Asset response had no signed url", 502);
  }
  const signed = await fetch(asset.url, { cache: "no-store" });
  if (!signed.ok) {
    throw new ComfyError(`Download failed: HTTP ${signed.status}`, signed.status);
  }
  return {
    bytes: await signed.arrayBuffer(),
    contentType:
      signed.headers.get("content-type") ||
      file.format ||
      "application/octet-stream",
  };
}

export async function pingComfy(): Promise<{ ok: boolean; cloudVersion?: string }> {
  const { apiKey, baseUrl } = comfyConfig();
  const headers = { Authorization: `Bearer ${apiKey}` };
  const stats = await fetch(`${baseUrl}/api/system_stats`, {
    headers,
    cache: "no-store",
  });
  if (stats.ok) {
    const json = (await stats.json()) as { system?: { cloud_version?: string } };
    return { ok: true, cloudVersion: json.system?.cloud_version };
  }
  const probe = await fetch(
    `${baseUrl}/api/v2/jobs/00000000-0000-0000-0000-000000000000`,
    { headers, cache: "no-store" },
  );
  return { ok: probe.status !== 401 };
}
