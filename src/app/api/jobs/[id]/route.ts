import { getApp } from "@/lib/config";
import { fetchJob } from "@/lib/comfy";
import { deploymentFailureMessage, deploymentTarget, getDeployment } from "@/lib/deployments";
import { isMockMode } from "@/lib/env";
import { errorJson, errorResponse, AppError } from "@/lib/http";
import { isMockJobId, isUuid, parsePublicRouteId, publicRouteId } from "@/lib/ids";
import { mockJobView, readMockMeta } from "@/lib/mock";
import { isPublicApp } from "@/lib/public-surface";
import { signJobView } from "@/lib/signing";
import type { JobView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clarifyDeploymentError(appTitle: string, job: JobView): JobView {
  if (!job.error) return job;
  const message = deploymentFailureMessage(appTitle, job.error.code, null);
  if (!message) return job;
  return { ...job, error: { ...job.error, message } };
}

function scopeOutputs(app: string, job: JobView): JobView {
  const outputNode = getApp(app)?.output.node;
  const matched = outputNode ? job.outputs.filter((output) => output.nodeId === outputNode) : [];
  const outputs = matched.length > 0 ? matched : job.outputs;
  return {
    ...job,
    outputs: outputs.filter((output) => isUuid(output.id)).map((output) => ({ ...output, id: publicRouteId(app, output.id) })),
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (isMockJobId(id)) {
      if (!isMockMode()) throw new AppError(404, "not_found", "Job not found.");
      const meta = await readMockMeta(id);
      if (!meta || !isPublicApp(meta.app)) throw new AppError(404, "not_found", "Job not found.");
      return Response.json(signJobView(mockJobView(meta)));
    }
    const routed = parsePublicRouteId(id);
    if (!routed || !isUuid(routed.id) || !isPublicApp(routed.app) || !getDeployment(routed.app)) {
      return errorJson(404, "not_found", "Job not found.");
    }
    // Unrender jobs live on the deployment (Kling, the visitor's key) or on Comfy Cloud (open source, free).
    const target = deploymentTarget(routed.app);
    const job = clarifyDeploymentError(target.appTitle, await fetchJob(target, routed.id));
    return Response.json(signJobView(scopeOutputs(routed.app, job)));
  } catch (error) {
    return errorResponse(error);
  }
}
