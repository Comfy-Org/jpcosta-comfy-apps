#!/usr/bin/env node
/**
 * End-to-end: upload demo/input assets to the local Next.js API, which
 * submits the Wan VACE product-swap graph via Comfy Cloud API v2 and polls.
 *
 *   npm run build && npm start
 *   node scripts/e2e.mjs
 *
 * Optional env (defaults are the short 480² clip):
 *   OPS_WIDTH OPS_HEIGHT OPS_DURATION OPS_FRAMES OPS_VIDEO
 *   OPS_OUT OPS_JOB_JSON OPS_SUBMIT_JSON OPS_MAX_WAIT_MS
 *   OPS_FALLBACK_WIDTH OPS_FALLBACK_HEIGHT
 *
 * Requires COMFY_API_KEY on the Next.js server. Never prints the key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const BASE = process.env.OPS_BASE || "http://127.0.0.1:3000";
const ROOT = new URL("..", import.meta.url).pathname;
const DEMO = join(ROOT, "demo");
const POLL_MS = 4000;
const WIDTH = Number(process.env.OPS_WIDTH || 480);
const HEIGHT = Number(process.env.OPS_HEIGHT || 480);
const DURATION = String(process.env.OPS_DURATION || "1.5");
const FRAMES = String(process.env.OPS_FRAMES || "17");
const VIDEO = process.env.OPS_VIDEO || join(DEMO, "input", "source.mp4");
const OUT_VIDEO = process.env.OPS_OUT || "open_product_swap_wan.mp4";
const JOB_JSON = process.env.OPS_JOB_JSON || "job.json";
const SUBMIT_JSON = process.env.OPS_SUBMIT_JSON || "submit.json";
const MAX_WAIT_MS = Number(process.env.OPS_MAX_WAIT_MS || 20 * 60 * 1000);
const FALLBACK_W = Number(process.env.OPS_FALLBACK_WIDTH || 0);
const FALLBACK_H = Number(process.env.OPS_FALLBACK_HEIGHT || 0);

function redact(s) {
  const prefix = ["comfy", "ui-"].join("");
  return String(s)
    .replace(new RegExp(`(${prefix}|sk-)[A-Za-z0-9_\\-]{8,}`, "gi"), "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

async function main() {
  await mkdir(join(DEMO, "output"), { recursive: true });

  const health = await fetch(`${BASE}/api/health`);
  const healthJson = await health.json();
  const host = healthJson.base ? new URL(healthJson.base).host : "";
  console.log(
    "health",
    health.ok,
    "hasKey",
    Boolean(healthJson.hasKey),
    "host",
    host,
    healthJson.cloud || healthJson.error || "",
  );
  if (!healthJson.hasKey) {
    console.error("Server is missing COMFY_API_KEY");
    process.exit(1);
  }

  const primary = { width: WIDTH, height: HEIGHT };
  let submitted = await submitOnce(primary, false);
  if (!submitted.ok && isMissingPartner(submitted.body)) {
    console.log("Flux3 unavailable on worker; retrying open-weights Wan VACE");
    submitted = await submitOnce(primary, true);
  }
  await writeFile(
    join(DEMO, "output", SUBMIT_JSON),
    JSON.stringify(submitted.body, null, 2),
  );
  console.log("submit", submitted.status, `${primary.width}x${primary.height}`);
  if (!submitted.ok) {
    console.error("Comfy rejected the job. See", SUBMIT_JSON);
    process.exit(1);
  }

  let job = submitted.body.jobs[0];
  console.log("job", job.id);
  let result = await pollUntil(job.id, MAX_WAIT_MS);
  let used = { ...primary, jobId: job.id, fallback: false };

  if (!isSuccess(result) && FALLBACK_W && FALLBACK_H) {
    const why = result.timedOut
      ? "timed out"
      : redact(result.snap?.error || result.snap?.status || "failed");
    console.log(
      `primary ${primary.width}x${primary.height} ${why}; falling back to ${FALLBACK_W}x${FALLBACK_H}`,
    );
    const fb = { width: FALLBACK_W, height: FALLBACK_H };
    submitted = await submitOnce(fb, false);
    await writeFile(
      join(DEMO, "output", SUBMIT_JSON),
      JSON.stringify({ primary: submitted.body, fallbackOf: job.id, ...submitted.body }, null, 2),
    );
    if (!submitted.ok) {
      console.error("Fallback submit rejected");
      process.exit(1);
    }
    job = submitted.body.jobs[0];
    console.log("fallback job", job.id);
    result = await pollUntil(job.id, MAX_WAIT_MS);
    used = { ...fb, jobId: job.id, fallback: true };
  }

  await writeFile(
    join(DEMO, "output", JOB_JSON),
    JSON.stringify({ ...result.snap, used }, null, 2),
  );

  if (!isSuccess(result)) {
    console.error(
      result.timedOut
        ? "Timed out waiting for job"
        : redact(result.snap?.error || "Job failed"),
    );
    process.exit(1);
  }

  const saved = await saveOutputs(job.id, result.snap);
  if (!saved) {
    console.error("Job succeeded but no video output was saved");
    process.exit(1);
  }
}

function isSuccess(result) {
  return Boolean(result && !result.timedOut && result.snap && result.snap.status === "success");
}

async function pollUntil(id, maxWaitMs) {
  const started = Date.now();
  let lastSnap = null;
  for (;;) {
    const poll = await fetch(`${BASE}/api/jobs/${id}`);
    const snap = await poll.json();
    lastSnap = snap;
    console.log(
      new Date().toISOString(),
      snap.status,
      snap.rawStatus || "",
      snap.message || snap.error || "",
    );
    if (["success", "error", "cancelled", "lost"].includes(snap.status)) {
      return { timedOut: false, snap };
    }
    if (Date.now() - started > maxWaitMs) {
      return { timedOut: true, snap };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function saveOutputs(jobId, snap) {
  let savedVideo = false;
  for (const file of snap.outputs || []) {
    const params = new URLSearchParams({
      filename: file.filename || "output",
      subfolder: file.subfolder || "",
      type: file.type || "output",
    });
    if (file.id) params.set("id", file.id);
    const res = await fetch(`${BASE}/api/jobs/${jobId}/file?${params}`);
    if (!res.ok) {
      console.error("download failed", res.status, redact(await res.text()));
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const video =
      /video/i.test(`${file.type || ""} ${file.format || ""}`) ||
      /\.(mp4|webm|mov|mkv)$/i.test(file.filename || "") ||
      String(file.filename || "").includes("video/");
    const destName = video
      ? OUT_VIDEO
      : OUT_VIDEO.includes("720p")
        ? "open_product_swap_keyframe_720p.png"
        : String(file.filename || file.id || "output").replace(/[^\w.-]+/g, "_");
    const dest = join(DEMO, "output", destName);
    await writeFile(dest, buf);
    console.log("saved", dest, buf.length);
    if (video) savedVideo = true;
  }
  return savedVideo;
}

async function submitOnce(size, skipPartner) {
  const form = new FormData();
  form.append("video", new Blob([await read(VIDEO)]), basename(VIDEO));
  form.append(
    "sku_sku-1",
    new Blob([await read(join(DEMO, "input", "sku_haven_ginger.jpg"))]),
    "sku_haven_ginger.jpg",
  );
  form.append("pipeline", "wan-vace");
  form.append("skus", JSON.stringify([{ id: "sku-1", name: "Haven Ginger" }]));
  form.append(
    "prompt",
    "A person holds the amber Haven Ginger bottle. Photorealistic, original lighting, hands and motion unchanged.",
  );
  form.append("maskObject", "red soda can, can in the person's hand");
  form.append("durationSec", DURATION);
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  form.append("frames", FRAMES);
  if (skipPartner) form.append("skipPartner", "1");

  const submit = await fetch(`${BASE}/api/jobs`, { method: "POST", body: form });
  const body = await submit.json();
  return { ok: submit.ok, status: submit.status, body };
}

function isMissingPartner(body) {
  const msg = redact(JSON.stringify(body || {})).toLowerCase();
  return (
    msg.includes("flux3") ||
    msg.includes("flux 3") ||
    msg.includes("class_type") ||
    msg.includes("unknown node")
  );
}

function read(p) {
  return import("node:fs/promises").then((fs) => fs.readFile(p));
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
