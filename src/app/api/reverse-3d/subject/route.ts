import { fetchAssetUrl, submitJob, uploadAsset } from "@/lib/comfy";
import { deploymentTarget } from "@/lib/deployments";
import { apiKey, isMockMode, missingKeyMessage } from "@/lib/env";
import { AppError, errorResponse } from "@/lib/http";
import { publicRouteId } from "@/lib/ids";
import { prepareImage } from "@/lib/images";
import { blockFigureMesh, decodeGlb, reduceMesh } from "@/lib/mesh-reduce";
import { verifyAssetSignature } from "@/lib/signing";
import { buildMeshWorkflow, buildPickWorkflow, parseSubjectChoice, SUBJECT_FRAME_CAP } from "@/lib/subject-pipeline";
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
          mesh: buildMeshWorkflow(),
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

    const workflow = buildMeshWorkflow();
    if (mock) {
      const reduced = reduceMesh(blockFigureMesh());
      return Response.json({ mock: true, ...meshPayload(reduced, 0, "The main subject", times[0] ?? 0), mesh: workflow });
    }
    const target = deploymentTarget("reverse-3d");
    const png = await prepareImage(files[0], FRAME_SIDE);
    const id = await uploadAsset(target, png, "subject.png", "image/png");
    wireImage(workflow, "1", id, "subject.png");
    const jobId = await submitJob(target, { workflow, extra_data: { api_key_comfy_org: key ?? "" } }, crypto.randomUUID());
    return Response.json({ step: "mesh", jobId: publicRouteId("reverse-3d", jobId) });
  } catch (error) {
    return errorResponse(error);
  }
}
