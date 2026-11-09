import { deploymentFailureMessage, deploymentUnavailableMessage, getDeployment, type DeploymentTarget } from "@/lib/deployments";
import { apiKey, missingKeyMessage } from "@/lib/env";
import { AppError } from "@/lib/http";
import type { JobBody } from "@/lib/workflow";
import type { JobStatus, JobView } from "@/lib/types";

const STATUSES = new Set<JobStatus>([
  "queued",
  "running",
  "succeeded",
  "canceling",
  "canceled",
  "failed",
  "expired",
]);

type ErrorEnvelope = {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
};

type AssetRecord = {
  id?: string;
  url?: string;
};

type RawOutput = {
  id?: string;
  node_id?: string;
  name?: string;
  type?: string;
  content_type?: string;
};

type RawJob = {
  id?: string;
  status?: string;
  progress?: { value?: number } | null;
  outputs?: RawOutput[];
  error?: { code?: string; message?: string } | null;
};

function rejectedKeyMessage(slug: string): string {
  const name = getDeployment(slug)?.keyEnv?.trim();
  if (name) return `The Comfy API key was rejected. Check ${name} on the server.`;
  return "The Comfy API key was rejected. Check COMFY_API_KEY (or COMFY_CLOUD_API_KEY) on the server.";
}

async function comfyFetch(target: DeploymentTarget, pathname: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const key = apiKey(target.slug);
  if (!key) throw new AppError(500, "missing_key", missingKeyMessage(target.slug));
  try {
    return await fetch(`${target.baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError(504, "timeout", deploymentUnavailableMessage(target.appTitle, target.baseUrl));
    }
    throw new AppError(503, "deployment_unavailable", deploymentUnavailableMessage(target.appTitle, target.baseUrl));
  }
}

async function throwEnvelope(target: DeploymentTarget, res: Response): Promise<never> {
  let code = "upstream_error";
  let message = `${target.appTitle} deployment returned ${res.status}.`;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    const nested = body.error;
    if (nested?.code) code = nested.code;
    else if (body.code) code = body.code;
    if (nested?.message) message = nested.message;
    else if (body.message) message = body.message;
  } catch {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new AppError(503, "deployment_unavailable", deploymentUnavailableMessage(target.appTitle, target.baseUrl));
    }
  }

  const lifecycle = deploymentFailureMessage(target.appTitle, code, res.headers.get("retry-after"));
  if (lifecycle) {
    const status = code === "deployment_stopped" ? 422 : 503;
    throw new AppError(status, code === "deployment_stopped" ? code : "deployment_not_ready", lifecycle);
  }
  if (code === "unauthorized" || res.status === 401) {
    throw new AppError(401, "unauthorized", rejectedKeyMessage(target.slug));
  }

  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  throw new AppError(status, code, message);
}

/** Multipart field order is required. The deployment returns 422 if `file` precedes `content_type`. */
export function buildAssetForm(bytes: Buffer, filePath: string, contentType = "image/png"): FormData {
  const form = new FormData();
  form.append("content_type", contentType);
  form.append("file_path", filePath);
  form.append("tags", JSON.stringify(["input"]));
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filePath);
  return form;
}

export async function uploadAsset(
  target: DeploymentTarget,
  bytes: Buffer,
  filePath: string,
  contentType = "image/png",
): Promise<string> {
  const form = buildAssetForm(bytes, filePath, contentType);
  const res = await comfyFetch(target, "/api/v2/assets", { method: "POST", body: form }, 60_000);
  if (!res.ok) await throwEnvelope(target, res);
  const asset = (await res.json()) as AssetRecord;
  if (!asset.id) throw new AppError(502, "upstream_error", `${target.appTitle} deployment did not return an asset id.`);
  return asset.id;
}

export async function submitJob(target: DeploymentTarget, body: JobBody, idempotencyKey: string): Promise<string> {
  const res = await comfyFetch(
    target,
    "/api/v2/jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    45_000,
  );
  if (!res.ok) await throwEnvelope(target, res);
  const job = (await res.json()) as RawJob;
  if (!job.id) throw new AppError(502, "upstream_error", `${target.appTitle} deployment did not return a job id.`);
  return job.id;
}

export function mapJob(job: RawJob): JobView {
  const status = STATUSES.has(job.status as JobStatus) ? (job.status as JobStatus) : "failed";
  const outputs = (job.outputs ?? [])
    .filter((item) => typeof item.id === "string" && item.id.length > 0)
    .map((item) => ({
      id: item.id as string,
      nodeId: typeof item.node_id === "string" ? item.node_id : "",
      name: typeof item.name === "string" ? item.name : "",
      ...(typeof item.type === "string" && item.type ? { type: item.type } : {}),
      ...(typeof item.content_type === "string" && item.content_type ? { contentType: item.content_type } : {}),
    }));
  const value = job.progress?.value;
  const progress = typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  const error =
    job.error && typeof job.error.message === "string"
      ? { code: job.error.code || "failed", message: job.error.message }
      : null;
  return {
    id: job.id || "",
    status,
    progress,
    outputs,
    error,
  };
}

export async function fetchJob(target: DeploymentTarget, id: string): Promise<JobView> {
  const res = await comfyFetch(target, `/api/v2/jobs/${encodeURIComponent(id)}`, { method: "GET" }, 20_000);
  if (!res.ok) await throwEnvelope(target, res);
  return mapJob((await res.json()) as RawJob);
}

/** GET a JSON route on this deployment. Callers that need a missing route can catch a 404. */
export async function fetchDeploymentJson(target: DeploymentTarget, pathname: string): Promise<unknown> {
  const res = await comfyFetch(target, pathname, { method: "GET" }, 20_000);
  if (!res.ok) await throwEnvelope(target, res);
  return res.json();
}

export async function fetchAssetUrl(target: DeploymentTarget, id: string): Promise<string> {
  const res = await comfyFetch(target, `/api/v2/assets/${encodeURIComponent(id)}`, { method: "GET" }, 20_000);
  if (!res.ok) await throwEnvelope(target, res);
  const asset = (await res.json()) as AssetRecord;
  if (!asset.url || !asset.url.startsWith("https://")) {
    throw new AppError(502, "upstream_error", `${target.appTitle} deployment did not return a signed output URL.`);
  }
  return asset.url;
}
