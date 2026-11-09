import { getApp } from "@/lib/config";
import type { DeploymentTarget } from "@/lib/deployments";
import { apiKey, missingKeyMessage } from "@/lib/env";
import { AppError } from "@/lib/http";

/**
 * Unrender runs on Comfy Cloud itself, not on a serverless deployment: a visitor's own key then runs the job on
 * their account and spends their credits, and Comfy Cloud has every model and node pack the open-source graph uses.
 * Without a key (an email's free video) the app's key pays. The API is the same Comfy API v2 as a deployment.
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
