import { getApp } from "@/lib/config";
import { deploymentTarget, type DeploymentTarget } from "@/lib/deployments";
import { apiKey, missingKeyMessage } from "@/lib/env";
import { AppError } from "@/lib/http";

/**
 * Unrender's free video (an email) runs the open-source graph on Comfy Cloud itself, not on the serverless deployment:
 * Comfy Cloud has every model and node pack it uses. The app's key pays. The API is the same Comfy API v2 as a deployment.
 * A visitor's own key runs the Kling graph on the reverse-3d deployment instead (src/lib/reverse-3d-kling.ts).
 */
export const COMFY_CLOUD_ORIGIN = "https://cloud.comfy.org";
const SLUG = "reverse-3d";

export function unrenderTarget(visitorKey: string | null): DeploymentTarget {
  const key = visitorKey ?? apiKey(SLUG);
  if (!key) throw new AppError(500, "missing_key", missingKeyMessage(SLUG));
  return {
    slug: SLUG,
    appTitle: getApp(SLUG)?.title ?? "Unrender",
    baseUrl: COMFY_CLOUD_ORIGIN,
    deploymentId: "comfy-cloud",
    key,
    visitorKey: Boolean(visitorKey),
  };
}

/**
 * Where an Unrender job lives, for its status and output: the browser sends the visitor's key with every poll when the
 * run used one, so a request with a key reads the deployment (Kling) and one without reads Comfy Cloud (open source).
 */
export function unrenderJobTarget(visitorKey: string | null): DeploymentTarget {
  return visitorKey ? deploymentTarget(SLUG) : unrenderTarget(null);
}
