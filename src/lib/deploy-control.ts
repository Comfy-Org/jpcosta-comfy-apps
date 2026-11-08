import { AppError } from "@/lib/http";
import { BACKGROUND_REMOVAL_DEPLOYMENT_ID } from "@/lib/subject-pipeline";

const DEPLOY_API = "https://platformapi.comfy.org/deploy/v1";

/** Reverse 3D Kling playblast. Never stop this one to free a slot. */
export const REVERSE_3D_DEPLOYMENT_ID = "dep-a166b403-62ba-4598-adeb-708471c20c8c";

/**
 * Personal-workspace deployments whose releases were deleted.
 * They cannot serve the apps anymore, so they are the slot to free when the
 * three-active cap blocks background removal.
 */
export const RELEASE_DELETED_DEPLOYMENTS = [
  "dep-1a2d3e32-57f0-4617-8ee1-a302160f4cb8",
  "dep-226ed4ac-b5eb-4d8d-bb9c-51907d71718a",
] as const;

const HOLDS_SLOT = new Set(["queued", "provisioning", "starting", "ready", "unhealthy"]);
const NEEDS_START = new Set(["stopped", "failed"]);

export type DeploymentRow = {
  id: string;
  status: string;
};

export type DeploymentView = DeploymentRow & {
  stopped: string | null;
};

class DeployHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeployHttpError";
  }
}

function rowFrom(value: unknown): DeploymentRow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const inner =
    record.deployment && typeof record.deployment === "object"
      ? (record.deployment as Record<string, unknown>)
      : record;
  const id = typeof inner.id === "string" ? inner.id : "";
  const status = typeof inner.status === "string" ? inner.status : "";
  if (!id) return null;
  return { id, status };
}

export function deploymentRows(body: unknown): DeploymentRow[] {
  if (Array.isArray(body)) {
    return body.flatMap((item) => {
      const row = rowFrom(item);
      return row ? [row] : [];
    });
  }
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const list = record.deployments ?? record.data;
  if (Array.isArray(list)) return deploymentRows(list);
  const one = rowFrom(body);
  return one ? [one] : [];
}

/**
 * One active deployment to stop so background removal can start.
 * Reverse 3D is never chosen. Only a host whose release was already deleted qualifies.
 */
export function spareDeploymentToStop(rows: readonly DeploymentRow[], keep: readonly string[]): string | null {
  const held = new Set(keep);
  const active = new Set(rows.filter((row) => HOLDS_SLOT.has(row.status)).map((row) => row.id));
  return RELEASE_DELETED_DEPLOYMENTS.find((id) => active.has(id) && !held.has(id)) ?? null;
}

async function deployCall(key: string, method: string, path: string): Promise<unknown> {
  const headers: Record<string, string>[] = [{ "X-API-Key": key }, { Authorization: `Bearer ${key}` }];
  let sawAuth = false;
  for (const header of headers) {
    const requestHeaders: Record<string, string> = { ...header };
    if (method === "POST") requestHeaders["Content-Type"] = "application/json";
    const response = await fetch(`${DEPLOY_API}${path}`, {
      method,
      headers: requestHeaders,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401) {
      sawAuth = true;
      continue;
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : `Deploy API returned ${response.status}.`;
      throw new DeployHttpError(response.status, message);
    }
    return body;
  }
  if (sawAuth) throw new AppError(401, "unauthorized", "The Comfy API key was rejected by the deploy API.");
  throw new AppError(502, "upstream_error", "The deploy API did not answer.");
}

async function getDeployment(key: string, id: string): Promise<DeploymentRow> {
  const body = await deployCall(key, "GET", `/deployments/${encodeURIComponent(id)}`);
  return rowFrom(body) ?? { id, status: "" };
}

async function listDeployments(key: string): Promise<DeploymentRow[]> {
  const body = await deployCall(key, "GET", "/deployments?limit=100");
  return deploymentRows(body);
}

async function postAction(key: string, id: string, action: "start" | "stop"): Promise<DeploymentRow> {
  const body = await deployCall(key, "POST", `/deployments/${encodeURIComponent(id)}/${action}`);
  return rowFrom(body) ?? { id, status: action === "start" ? "starting" : "stopping" };
}

export function startingMessage(view: DeploymentView): string {
  const state = view.status || "starting";
  const freed = view.stopped ? ` Stopped ${view.stopped} to free one of the three active slots.` : "";
  return `Background removal is ${state}.${freed} Wait a minute, then run again.`;
}

/** Read the background-removal deployment. Does not start or stop anything. */
export async function readBackgroundRemoval(key: string): Promise<DeploymentRow> {
  return getDeployment(key, BACKGROUND_REMOVAL_DEPLOYMENT_ID);
}

/**
 * Start background removal when it is stopped.
 * A ready or already-starting host is left alone.
 * The three-slot cap stops a deleted-release deployment, never Reverse 3D, then retries once.
 */
export async function ensureBackgroundRemoval(key: string): Promise<DeploymentView> {
  let current = await getDeployment(key, BACKGROUND_REMOVAL_DEPLOYMENT_ID);
  if (current.status && !NEEDS_START.has(current.status)) {
    return { ...current, stopped: null };
  }
  let stopped: string | null = null;
  try {
    current = await postAction(key, BACKGROUND_REMOVAL_DEPLOYMENT_ID, "start");
  } catch (error) {
    if (!(error instanceof DeployHttpError) || error.status !== 429) throw error;
    const spare = spareDeploymentToStop(await listDeployments(key), [
      BACKGROUND_REMOVAL_DEPLOYMENT_ID,
      REVERSE_3D_DEPLOYMENT_ID,
    ]);
    if (!spare) {
      throw new AppError(
        503,
        "deployment_quota",
        "Background removal is stopped, and three other deployments are already active. Reverse 3D was left running.",
      );
    }
    await postAction(key, spare, "stop");
    stopped = spare;
    current = await postAction(key, BACKGROUND_REMOVAL_DEPLOYMENT_ID, "start");
  }
  return { id: current.id || BACKGROUND_REMOVAL_DEPLOYMENT_ID, status: current.status || "starting", stopped };
}
