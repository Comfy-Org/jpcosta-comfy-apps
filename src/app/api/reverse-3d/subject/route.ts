import { fetchAssetUrl, fetchDeploymentJson, fetchJob, submitJob, uploadAsset } from "@/lib/comfy";
import { deploymentTarget, type DeploymentTarget } from "@/lib/deployments";
import { apiKey, isMockMode, missingKeyMessage } from "@/lib/env";
import { AppError, errorResponse } from "@/lib/http";
import { publicRouteId } from "@/lib/ids";
import { prepareImage } from "@/lib/images";
import { blockFigureMesh, decodeGlb, reduceMesh } from "@/lib/mesh-reduce";
import { verifyAssetSignature } from "@/lib/signing";
import {
  backgroundModelForDeployment,
  backgroundModelName,
  buildCutoutWorkflow,
  buildHunyuanWorkflow,
  buildPickWorkflow,
  comboOptions,
  parseSubjectChoice,
  SUBJECT_FRAME_CAP,
} from "@/lib/subject-pipeline";
import type { JobView } from "@/lib/types";
import { assetRef, type Workflow } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FRAME_SIDE = 1024;

function numbers(value: FormDataEntryValue | null): number[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

function wireImage(workflow: Workflow, nodeId: string, id: string, filePath: string): void {
  const node = workflow[nodeId];
  if (!node) throw new AppError(500, "internal", "The subject workflow is missing an image input.");
  node.inputs.image = assetRef(id, filePath);
}

/**
 * Comfy API v2 on a deployment serves `/api/v2/assets` and `/api/v2/jobs`.
 * `object_info` is the older cloud route, so these paths 404 and the combo cannot be read.
 * A body with names is a real list. Null means the route was missing or rejected.
 */
async function listedBackgroundModels(target: DeploymentTarget): Promise<readonly string[] | null> {
  const paths = ["/api/object_info", "/api/object_info/LoadBackgroundRemovalModel", "/object_info/LoadBackgroundRemovalModel"];
  for (const pathname of paths) {
    try {
      const body = await fetchDeploymentJson(target, pathname);
      const names = comboOptions(body, "bg_removal_name");
      if (names.length > 0) return names;
      // A 200 that never mentions the input is the wrong shape, not an empty combo.
      if (JSON.stringify(body).includes("bg_removal_name")) return [];
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 405)) continue;
      return null;
    }
  }
  return null;
}

function modelFromList(deploymentId: string, listed: readonly string[] | null): string {
  try {
    return backgroundModelForDeployment(deploymentId, listed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the background-removal model list.";
    throw new AppError(502, "upstream_error", message);
  }
}

async function waitForCutout(target: DeploymentTarget, jobId: string): Promise<JobView> {
  const started = Date.now();
  for (;;) {
    const job = await fetchJob(target, jobId);
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "canceled" || job.status === "expired") {
      throw new AppError(502, job.error?.code || "upstream_error", job.error?.message || "The background cut-out failed.");
    }
    if (Date.now() - started > 40_000) {
      throw new AppError(504, "timeout", "The background cut-out is still running. Run again in a moment.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function cutoutOutputId(job: JobView): string {
  const image =
    job.outputs.find((output) => output.nodeId === "6") ??
    job.outputs.find((output) => /\.(png|webp|jpe?g)$/i.test(output.name)) ??
    job.outputs[0];
  if (!image) throw new AppError(502, "upstream_error", "The background cut-out did not return an image.");
  return image.id;
}

async function downloadAsset(target: DeploymentTarget, id: string): Promise<Buffer> {
  const signed = await fetchAssetUrl(target, id);
  const upstream = await fetch(signed, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!upstream.ok) throw new AppError(502, "upstream_error", "Could not download the cut-out.");
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) {
    throw new AppError(502, "upstream_error", "Could not download the cut-out.");
  }
  return bytes;
}

function meshPayload(reduced: ReturnType<typeof reduceMesh>, frame: number, subject: string, time: number) {
  return {
    frame,
    subject,
    time,
    sourceFaces: reduced.sourceFaces,
    reducedFaces: reduced.reducedFaces,
    positions: Array.from(reduced.positions),
    indices: Array.from(reduced.indices),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const output = url.searchParams.get("output") ?? "";
    const signature = url.searchParams.get("sig");
    if (!output || output.includes("/") || output.includes("..") || !verifyAssetSignature(output, signature)) {
      throw new AppError(404, "not_found", "Output not found.");
    }
    if (isMockMode()) throw new AppError(404, "not_found", "Output not found.");
    const target = deploymentTarget("reverse-3d");
    const signed = await fetchAssetUrl(target, output.includes("~") ? output.slice(output.indexOf("~") + 1) : output);
    const upstream = await fetch(signed, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (!upstream.ok) throw new AppError(502, "upstream_error", "Could not download the 3D model.");
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 40 * 1024 * 1024) {
      throw new AppError(502, "upstream_error", "Could not download the 3D model.");
    }
    const reduced = reduceMesh(decodeGlb(bytes));
    return Response.json(meshPayload(reduced, 0, "", 0));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError(400, "invalid_input", "Upload the frames as form data.");
    }
    const step = form.get("step") === "mesh" ? "mesh" : "pick";
    const files = form.getAll("frame").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length === 0) throw new AppError(400, "invalid_input", "Upload a frame from the clip.");
    if (files.length > SUBJECT_FRAME_CAP) {
      throw new AppError(400, "invalid_input", `Send at most ${SUBJECT_FRAME_CAP} frames.`);
    }
    const times = numbers(form.get("times"));
    const mock = isMockMode();
    const key = apiKey("reverse-3d");
    if (!mock && !key) throw new AppError(500, "missing_key", missingKeyMessage("reverse-3d"));

    if (step === "pick") {
      const workflow = buildPickWorkflow(files.length);
      if (mock) {
        const choice = parseSubjectChoice("frame: 1\nsubject: The main subject", files.length);
        const reduced = reduceMesh(blockFigureMesh());
        return Response.json({
          mock: true,
          ...meshPayload(reduced, choice.frame, choice.subject, times[choice.frame] ?? 0),
          pick: workflow,
          mesh: buildHunyuanWorkflow(),
          cutout: buildCutoutWorkflow(backgroundModelName(["birefnet.safetensors"])),
        });
      }
      const target = deploymentTarget("reverse-3d");
      for (let index = 0; index < files.length; index += 1) {
        const png = await prepareImage(files[index], FRAME_SIDE);
        const filePath = `frame_${index + 1}.png`;
        const id = await uploadAsset(target, png, filePath, "image/png");
        wireImage(workflow, String(index + 1), id, filePath);
      }
      const jobId = await submitJob(target, { workflow, extra_data: { api_key_comfy_org: key ?? "" } }, crypto.randomUUID());
      return Response.json({ step: "pick", jobId: publicRouteId("reverse-3d", jobId) });
    }

    if (mock) {
      const reduced = reduceMesh(blockFigureMesh());
      return Response.json({
        mock: true,
        ...meshPayload(reduced, 0, "The main subject", times[0] ?? 0),
        mesh: buildHunyuanWorkflow(),
        cutout: buildCutoutWorkflow(backgroundModelName(["birefnet.safetensors"])),
      });
    }
    if (!apiKey("background-removal")) {
      throw new AppError(500, "missing_key", missingKeyMessage("background-removal"));
    }
    const cutoutTarget = deploymentTarget("background-removal");
    const meshTarget = deploymentTarget("reverse-3d");
    const modelName = modelFromList(cutoutTarget.deploymentId, await listedBackgroundModels(cutoutTarget));
    const cutout = buildCutoutWorkflow(modelName);
    const png = await prepareImage(files[0], FRAME_SIDE);
    const cutoutAsset = await uploadAsset(cutoutTarget, png, "subject.png", "image/png");
    wireImage(cutout, "1", cutoutAsset, "subject.png");
    const cutoutJob = await submitJob(cutoutTarget, { workflow: cutout }, crypto.randomUUID());
    const finished = await waitForCutout(cutoutTarget, cutoutJob);
    const cutoutBytes = await downloadAsset(cutoutTarget, cutoutOutputId(finished));
    const hunyuan = buildHunyuanWorkflow();
    const subjectAsset = await uploadAsset(meshTarget, cutoutBytes, "subject.png", "image/png");
    wireImage(hunyuan, "1", subjectAsset, "subject.png");
    const jobId = await submitJob(
      meshTarget,
      { workflow: hunyuan, extra_data: { api_key_comfy_org: key ?? "" } },
      crypto.randomUUID(),
    );
    return Response.json({ step: "mesh", jobId: publicRouteId("reverse-3d", jobId) });
  } catch (error) {
    return errorResponse(error);
  }
}
