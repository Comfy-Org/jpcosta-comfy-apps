import { readFileSync } from "node:fs";
import path from "node:path";
import { getApp } from "@/lib/config";
import { AppError } from "@/lib/http";

export type DeploymentRecord = {
  deploymentId: string;
  endpointUrl: string;
  releaseId: string;
  env: string;
  /**
   * When set, this app authenticates with only this env var.
   * There is no fallback to COMFY_API_KEY or COMFY_CLOUD_API_KEY.
   */
  keyEnv?: string;
  note?: string;
};

export type DeploymentsFile = {
  $comment?: string;
  account: string;
  gpu?: string;
  region?: string;
  activeDeploymentLimit?: number;
  apps: Record<string, DeploymentRecord>;
};

export type DeploymentTarget = {
  slug: string;
  appTitle: string;
  baseUrl: string;
  deploymentId: string;
};

let cached: DeploymentsFile | null = null;

export function deploymentEnvName(slug: string): string {
  return `COMFY_BASE_URL_${slug.toUpperCase().replace(/-/g, "_")}`;
}

export function loadDeployments(): DeploymentsFile {
  if (!cached) {
    const file = path.join(process.cwd(), "workflows", "deployments.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DeploymentsFile;
    for (const [slug, record] of Object.entries(parsed.apps)) {
      const expectedEnv = deploymentEnvName(slug);
      if (record.env !== expectedEnv) {
        throw new AppError(500, "invalid_deployment", `workflows/deployments.json env for ${slug} must be ${expectedEnv}.`);
      }
      if (record.keyEnv !== undefined && !/^COMFY_API_KEY_[A-Z0-9_]+$/.test(record.keyEnv)) {
        throw new AppError(
          500,
          "invalid_deployment",
          `workflows/deployments.json keyEnv for ${slug} must look like COMFY_API_KEY_WORK_PERSONAL.`,
        );
      }
      assertDeploymentUrl(record.endpointUrl, slug, "checked-in deployment");
    }
    cached = parsed;
  }
  return cached;
}

export function listDeploymentSlugs(): string[] {
  return Object.keys(loadDeployments().apps);
}

export function getDeployment(slug: string): DeploymentRecord | null {
  return loadDeployments().apps[slug] ?? null;
}

/** Host for this app. Checked-in URL, unless COMFY_BASE_URL_<SLUG> is set. */
export function deploymentBaseUrl(slug: string): string {
  const record = getDeployment(slug);
  if (!record) {
    throw new AppError(500, "missing_deployment", `No serverless deployment is configured for ${slug}.`);
  }
  const fromEnv = process.env[record.env]?.trim();
  if (!fromEnv) return normalizeDeploymentUrl(record.endpointUrl);
  return assertDeploymentUrl(fromEnv, slug, record.env);
}

export function deploymentTarget(slug: string): DeploymentTarget {
  const record = getDeployment(slug);
  if (!record) {
    throw new AppError(500, "missing_deployment", `No serverless deployment is configured for ${slug}.`);
  }
  return {
    slug,
    appTitle: getApp(slug)?.title ?? slug,
    baseUrl: deploymentBaseUrl(slug),
    deploymentId: record.deploymentId,
  };
}

/**
 * User-facing text for a deployment that cannot run yet.
 * `deployment_stopped` is terminal until someone starts it.
 * `deployment_not_ready` is a cold start (min instances is 0).
 */
export function deploymentFailureMessage(appTitle: string, code: string, retryAfter: string | null): string | null {
  if (code === "deployment_stopped") {
    return `${appTitle} deployment is stopped, so this run cannot start. Start that deployment (only 3 can be active at once), then run again.`;
  }
  // deployment_not_ready is a cold start (HTTP 429). The worker can still become ready.
  if (code === "deployment_not_ready") {
    return `${appTitle} is cold-starting. The GPU worker is not ready yet. Wait ${waitPhrase(retryAfter)}, then run again.`;
  }
  return null;
}

export function deploymentUnavailableMessage(appTitle: string, baseUrl: string): string {
  return `${appTitle} deployment (${hostOf(baseUrl)}) did not respond. It may be stopped or still cold-starting. Start it if needed, then run again.`;
}

function waitPhrase(retryAfter: string | null): string {
  if (!retryAfter || !/^\d+$/.test(retryAfter)) return "a minute or two";
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return "a minute or two";
  if (seconds <= 90) return `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minutes`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function assertDeploymentUrl(raw: string, slug: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(500, "invalid_deployment", `${source} for ${slug} is not a valid URL.`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new AppError(500, "invalid_deployment", `${source} for ${slug} must be an origin only (https://<deployment>.run.comfy.app).`);
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.comfy.app")) {
    throw new AppError(
      500,
      "invalid_deployment",
      `${source} for ${slug} must be an https://<deployment>.run.comfy.app host, not ${url.host}.`,
    );
  }
  return url.origin;
}

function normalizeDeploymentUrl(raw: string): string {
  return new URL(raw).origin;
}
