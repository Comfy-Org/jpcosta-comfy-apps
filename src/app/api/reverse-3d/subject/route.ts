import { fetchAssetUrl, fetchDeploymentJson, fetchJob, submitJob, uploadAsset } from "@/lib/comfy";
import { deploymentTarget, type DeploymentTarget } from "@/lib/deployments";
import { apiKey, isMockMode, missingKeyMessage } from "@/lib/env";
import { AppError, errorResponse } from "@/lib/http";
import { isUuid, parsePublicRouteId, publicRouteId } from "@/lib/ids";
import { prepareImage, sniffImage } from "@/lib/images";
import { blockFigureMesh, decodeGlb, reduceMesh } from "@/lib/mesh-reduce";
import { signAssetId, verifyAssetSignature } from "@/lib/signing";
import {
  backgroundModelForDeployment,
  backgroundModelName,
  buildCutoutWorkflow,
  buildHunyuanWorkflow,
  buildMarkWorkflow,
  buildPickWorkflow,
  buildKlingStillWorkflow,
  comboOptions,
  cutoutAssetToken,
  isSubjectKind,
  MAX_SUBJECTS,
  MOCK_FIND_REPLY,
  MOCK_MARK_REPLY,
  parseSceneFind,
  SUBJECT_FRAME_CAP,
  type SubjectKind,
} from "@/lib/subject-pipeline";
import type { JobView } from "@/lib/types";
import { assetRef, type Workflow } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FRAME_SIDE = 1024;
/** Close-ups arrive at this size from the browser; a bigger one is scaled down. */
const CLOSE_UP_SIDE = 768;

function numbers(value: FormDataEntryValue | null): number[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

/** The kind of each close-up, in order, from a comma list. */
function closeUpKinds(value: FormDataEntryValue | null, count: number): SubjectKind[] {
  const kinds = typeof value === "string" ? value.split(",").map((part) => part.trim()) : [];
  if (kinds.length !== count || !kinds.every(isSubjectKind)) throw new AppError(400, "invalid_input", "Each close-up needs its kind.");
  return kinds as SubjectKind[];
}

/** Where each subject sits in its close-up: four numbers per close-up, [ymin, xmin, ymax, xmax] in 0-1000. */
function closeUpBoxes(value: FormDataEntryValue | null, count: number): number[][] {
  const values = typeof value === "string" && value.trim() ? value.split(",").map((part) => Number(part)) : [];
  if (values.length !== count * 4 || values.some((part) => !Number.isFinite(part) || part < 0 || part > 1000)) {
    throw new AppError(400, "invalid_input", "Each close-up needs its box.");
  }
  return Array.from({ length: count }, (_, index) => values.slice(index * 4, index * 4 + 4));
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
 * A stopped or cold host is reported as that, not as an empty model list.
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
      if (error instanceof AppError && (error.code === "deployment_stopped" || error.code === "deployment_not_ready" || error.code === "deployment_unavailable")) {
        throw error;
      }
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

function assetUuid(id: string): string {
  const routed = parsePublicRouteId(id);
  const uuid = routed?.id ?? id;
  if (!isUuid(uuid)) throw new AppError(502, "upstream_error", "The background cut-out did not return an image.");
  return uuid;
}

function cutoutOutputId(job: JobView): string {
  const image =
    job.outputs.find((output) => output.nodeId === "6") ??
    job.outputs.find((output) => /\.(png|webp|jpe?g)$/i.test(output.name)) ??
    job.outputs.find((output) => isUuid(output.id) || Boolean(parsePublicRouteId(output.id)));
  if (!image) throw new AppError(502, "upstream_error", "The background cut-out did not return an image.");
  return assetUuid(image.id);
}

async function downloadAsset(target: DeploymentTarget, id: string): Promise<Buffer> {
  const signed = await fetchAssetUrl(target, assetUuid(id));
  const upstream = await fetch(signed, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!upstream.ok) throw new AppError(502, "upstream_error", "Could not download the cut-out.");
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024 || !sniffImage(bytes)) {
    throw new AppError(502, "upstream_error", "The background cut-out did not return an image.");
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

function mockMesh(frame: number, subject: string, time: number) {
  return {
    mock: true,
    ...meshPayload(reduceMesh(blockFigureMesh()), frame, subject, time),
    pick: buildPickWorkflow(1),
    mesh: buildHunyuanWorkflow(),
    cutout: buildCutoutWorkflow(backgroundModelName(["birefnet.safetensors"])),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const cutoutJob = url.searchParams.get("cutoutJob");
    if (cutoutJob !== null) {
      if (!isUuid(cutoutJob)) throw new AppError(400, "invalid_input", "That cut-out job is not valid.");
      if (isMockMode()) throw new AppError(404, "not_found", "Output not found.");
      const job = await fetchJob(deploymentTarget("background-removal"), cutoutJob);
      if (job.status === "failed" || job.status === "canceled" || job.status === "expired") {
        return Response.json({ status: job.status, error: job.error?.message || "The background cut-out failed." });
      }
      if (job.status !== "succeeded") return Response.json({ status: job.status });
      const cutout = cutoutOutputId(job);
      return Response.json({ status: "succeeded", cutout, sig: signAssetId(cutoutAssetToken(cutout)) });
    }

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
    let decoded: ReturnType<typeof decodeGlb>;
    try {
      decoded = decodeGlb(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hunyuan returned a file that is not a GLB mesh.";
      throw new AppError(502, "upstream_error", message);
    }
    const reduced = reduceMesh(decoded);
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
    const requested = form.get("step");
    const step =
      requested === "hunyuan"
        ? "hunyuan"
        : requested === "cutout" || requested === "mesh"
          ? "cutout"
          : requested === "mark"
            ? "mark"
            : requested === "still"
              ? "still"
              : "pick";
    const files = form.getAll("frame").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (step !== "hunyuan" && files.length === 0) throw new AppError(400, "invalid_input", "Upload a frame from the clip.");
    if (files.length > SUBJECT_FRAME_CAP) {
      throw new AppError(400, "invalid_input", `Send at most ${SUBJECT_FRAME_CAP} frames.`);
    }
    const times = numbers(form.get("times"));
    const mock = isMockMode();
    if (!mock && !apiKey("reverse-3d")) throw new AppError(500, "missing_key", missingKeyMessage("reverse-3d"));
    const key = apiKey("reverse-3d");

    if (step === "pick") {
      const workflow = buildPickWorkflow(files.length);
      if (mock) {
        const found = parseSceneFind(MOCK_FIND_REPLY, files.length);
        return Response.json({
          mock: true,
          step: "pick",
          frame: found.frame,
          subject: found.subject,
          time: times[found.frame] ?? 0,
          reply: MOCK_FIND_REPLY,
          pick: workflow,
        });
      }
      const target = deploymentTarget("reverse-3d");
      // Upload the frames side by side: this is the wait before the 3D toy can start.
      await Promise.all(
        files.map(async (file, index) => {
          const png = await prepareImage(file, FRAME_SIDE);
          const filePath = `frame_${index + 1}.png`;
          const id = await uploadAsset(target, png, filePath, "image/png");
          wireImage(workflow, String(index + 1), id, filePath);
        }),
      );
      const jobId = await submitJob(target, { workflow, extra_data: { api_key_comfy_org: key ?? "" } }, crypto.randomUUID());
      return Response.json({ step: "pick", jobId: publicRouteId("reverse-3d", jobId) });
    }

    // The playblast look: the first frame redrawn as a grey blocking pass. Its image is the video's look reference.
    if (step === "still") {
      if (files.length !== 1) throw new AppError(400, "invalid_input", "Upload the first frame once.");
      // Nano Banana 2 Lite (partner node, billed to the app key) draws the still Kling copies.
      const workflow = buildKlingStillWorkflow();
      if (mock) return Response.json({ mock: true, step: "still", still: workflow });
      const target = deploymentTarget("reverse-3d");
      const png = await prepareImage(files[0], FRAME_SIDE);
      const id = await uploadAsset(target, png, "frame.png", "image/png");
      wireImage(workflow, "1", id, "frame.png");
      const body = { workflow, extra_data: { api_key_comfy_org: key ?? "" } };
      const jobId = await submitJob(target, body, crypto.randomUUID());
      return Response.json({ step: "still", jobId: publicRouteId("reverse-3d", jobId) });
    }

    // Second job: the chosen frame and one close-up per subject, each marked part by part.
    if (step === "mark") {
      if (files.length !== 1) throw new AppError(400, "invalid_input", "Upload the chosen frame once.");
      const crops = form.getAll("crop").filter((entry): entry is File => entry instanceof File && entry.size > 0);
      if (crops.length === 0 || crops.length > MAX_SUBJECTS) {
        throw new AppError(400, "invalid_input", `Send 1 to ${MAX_SUBJECTS} close-ups.`);
      }
      const kinds = closeUpKinds(form.get("kinds"), crops.length);
      const boxes = closeUpBoxes(form.get("boxes"), crops.length);
      const workflow = buildMarkWorkflow(kinds, boxes);
      if (mock) return Response.json({ mock: true, step: "mark", reply: MOCK_MARK_REPLY, mark: workflow });
      const target = deploymentTarget("reverse-3d");
      const uploads = [
        { file: files[0], side: FRAME_SIDE, node: "1", filePath: "frame.png" },
        ...crops.map((file, index) => ({ file, side: CLOSE_UP_SIDE, node: String(index + 2), filePath: `subject_${index + 1}.png` })),
      ];
      await Promise.all(
        uploads.map(async (upload) => {
          const png = await prepareImage(upload.file, upload.side);
          const id = await uploadAsset(target, png, upload.filePath, "image/png");
          wireImage(workflow, upload.node, id, upload.filePath);
        }),
      );
      const jobId = await submitJob(target, { workflow, extra_data: { api_key_comfy_org: key ?? "" } }, crypto.randomUUID());
      return Response.json({ step: "mark", jobId: publicRouteId("reverse-3d", jobId) });
    }

    if (mock) return Response.json(mockMesh(0, "The main subject", times[0] ?? 0));

    if (step === "hunyuan") {
      if (!apiKey("background-removal")) {
        throw new AppError(500, "missing_key", missingKeyMessage("background-removal"));
      }
      const cutout = String(form.get("cutout") ?? "");
      const signature = String(form.get("sig") ?? "");
      let token = "";
      try {
        token = cutoutAssetToken(cutout);
      } catch {
        throw new AppError(403, "forbidden", "That cut-out link is not valid.");
      }
      if (!verifyAssetSignature(token, signature)) throw new AppError(403, "forbidden", "That cut-out link is not valid.");
      const cutoutBytes = await downloadAsset(deploymentTarget("background-removal"), cutout);
      const hunyuan = buildHunyuanWorkflow();
      const meshTarget = deploymentTarget("reverse-3d");
      const subjectAsset = await uploadAsset(meshTarget, cutoutBytes, "subject.png", "image/png");
      wireImage(hunyuan, "1", subjectAsset, "subject.png");
      const jobId = await submitJob(
        meshTarget,
        { workflow: hunyuan, extra_data: { api_key_comfy_org: key ?? "" } },
        crypto.randomUUID(),
      );
      return Response.json({ step: "hunyuan", jobId: publicRouteId("reverse-3d", jobId) });
    }

    const png = await prepareImage(files[0], FRAME_SIDE);
    // Without the Background Removal deployment (no key, or stopped), Hunyuan gets the frame as is.
    // Hunyuan3D separates the subject itself; the cut-out only makes it cleaner.
    const uncut = async () => {
      const hunyuan = buildHunyuanWorkflow();
      const meshTarget = deploymentTarget("reverse-3d");
      const subjectAsset = await uploadAsset(meshTarget, png, "subject.png", "image/png");
      wireImage(hunyuan, "1", subjectAsset, "subject.png");
      const meshJob = await submitJob(meshTarget, { workflow: hunyuan, extra_data: { api_key_comfy_org: key ?? "" } }, crypto.randomUUID());
      return Response.json({ step: "hunyuan", jobId: publicRouteId("reverse-3d", meshJob) });
    };
    if (!apiKey("background-removal")) return await uncut();

    // Submit BiRefNet and return. Waiting here used to sit inside this 60s
    // function until the cut-out finished, so a cold worker never reached Hunyuan.
    const cutoutTarget = deploymentTarget("background-removal");
    try {
      const modelName = modelFromList(cutoutTarget.deploymentId, await listedBackgroundModels(cutoutTarget));
      const cutout = buildCutoutWorkflow(modelName);
      const cutoutAsset = await uploadAsset(cutoutTarget, png, "subject.png", "image/png");
      wireImage(cutout, "1", cutoutAsset, "subject.png");
      const jobId = await submitJob(cutoutTarget, { workflow: cutout }, crypto.randomUUID());
      return Response.json({ step: "cutout", jobId });
    } catch (error) {
      if (error instanceof AppError && error.code === "deployment_stopped") return await uncut();
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
