import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWorkflow } from "./workflows";

const BASE = (process.env.COMFY_BASE_URL || "https://cloud.comfy.org").replace(/\/$/, "");

export type ComfyFile = {
  id: string;
  filename: string;
  name?: string;
  node_id?: string;
  type?: string;
};

export type ComfyJob = {
  id: string;
  status: string;
  error?: unknown;
  outputs?: Array<{
    id?: string;
    asset_id?: string;
    name?: string;
    node_id?: string;
    type?: string;
    content_type?: string;
  }>;
};

function apiKey(): string {
  const k = process.env.COMFY_API_KEY;
  if (!k) throw new Error("COMFY_API_KEY is not set on the server");
  return k;
}

/** Strip anything that looks like the key from upstream error text before it reaches logs or clients. */
export function redact(s: string): string {
  const k = process.env.COMFY_API_KEY;
  let out = k ? s.split(k).join("[redacted]") : s;
  const prefix = "comfy" + "ui-";
  out = out.replace(new RegExp(`(${prefix}|sk-)[A-Za-z0-9_\\-]{12,}`, "gi"), "[redacted]");
  return out.slice(0, 600);
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

async function call<T>(method: string, pathname: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    body: init.body,
    headers: { Authorization: `Bearer ${apiKey()}`, ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Comfy API ${method} ${pathname.split("?")[0]} -> HTTP ${res.status}: ${redact(text)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function uploadImage(file: Buffer, filename: string): Promise<string> {
  const contentType = guessContentType(filename);
  const form = new FormData();
  form.append("content_type", contentType);
  form.append("file_path", filename);
  form.append("tags", JSON.stringify(["input"]));
  form.append("file", new Blob([new Uint8Array(file)], { type: contentType }), filename);
  const asset = await call<{ id?: string; file_path?: string }>("POST", "/api/v2/assets", { body: form });
  if (!asset.file_path) {
    throw new Error(`upload missing file_path: ${redact(JSON.stringify(asset))}`);
  }
  return asset.file_path;
}

export async function submitWorkflow(workflow: Record<string, unknown>): Promise<string> {
  const payload = {
    workflow,
    extra_data: { api_key_comfy_org: apiKey() },
  };
  const job = await call<{ id?: string }>("POST", "/api/v2/jobs", {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  });
  if (!job.id) throw new Error(`submit missing id: ${redact(JSON.stringify(job))}`);
  return job.id;
}

export async function getJob(id: string): Promise<ComfyJob> {
  return call<ComfyJob>("GET", `/api/v2/jobs/${encodeURIComponent(id)}`);
}

export async function pollStatus(promptId: string): Promise<string> {
  const job = await getJob(promptId);
  return job.status || "unknown";
}

export async function fetchHistory(promptId: string): Promise<ComfyJob> {
  return getJob(promptId);
}

const TERMINAL_OK = new Set(["succeeded"]);
const TERMINAL_BAD = new Set(["failed", "canceled", "cancelled", "expired"]);

export async function waitForJob(
  promptId: string,
  opts: { timeoutMs?: number; onStatus?: (status: string) => void } = {},
): Promise<ComfyJob> {
  const timeoutMs = opts.timeoutMs ?? 12 * 60_000;
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(promptId);
    const status = job.status || "unknown";
    if (status !== last) {
      opts.onStatus?.(status);
      last = status;
    }
    if (TERMINAL_OK.has(status)) return job;
    if (TERMINAL_BAD.has(status)) {
      throw new Error(`job ${promptId} ${status}: ${redact(JSON.stringify(job.error ?? job).slice(0, 4000))}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`job ${promptId} timed out after ${timeoutMs}ms (last=${last})`);
}

export function extractFiles(hist: unknown): ComfyFile[] {
  if (!hist || typeof hist !== "object") return [];
  const rec = hist as ComfyJob;
  const outs = rec.outputs;
  if (!Array.isArray(outs)) return [];
  const files: ComfyFile[] = [];
  for (const item of outs) {
    const id = item.id || item.asset_id;
    if (!id) continue;
    files.push({
      id,
      filename: item.name || id,
      name: item.name,
      node_id: item.node_id,
      type: item.type,
    });
  }
  return files;
}

export async function downloadView(file: ComfyFile, dest: string): Promise<Buffer> {
  if (!file.id) throw new Error("download missing asset id");
  const asset = await call<{ url?: string }>("GET", `/api/v2/assets/${encodeURIComponent(file.id)}`);
  if (!asset.url) throw new Error(`asset ${file.id} missing url`);
  const signed = await fetch(asset.url);
  if (!signed.ok) throw new Error(`signed download HTTP ${signed.status}`);
  const buf = Buffer.from(await signed.arrayBuffer());
  await writeFile(dest, buf);
  return buf;
}

export async function runNamedWorkflow(
  name: string,
  patch: (wf: Record<string, Record<string, unknown>>) => void,
  outDir: string,
  onStatus?: (status: string) => void,
): Promise<{ promptId: string; files: string[] }> {
  const wf = await loadWorkflow(name);
  patch(wf as Record<string, Record<string, unknown>>);
  const promptId = await submitWorkflow(wf);
  const job = await waitForJob(promptId, { onStatus });
  const listed = extractFiles(job);
  const saved: string[] = [];
  for (const [i, file] of listed.entries()) {
    const dest = path.join(outDir, `${i}_${path.basename(file.filename)}`);
    await downloadView(file, dest);
    saved.push(dest);
  }
  return { promptId, files: saved };
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
