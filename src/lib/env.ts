import { getApp } from "@/lib/config";
import { loadDeployments } from "@/lib/deployments";

export function isMockMode(): boolean {
  const value = process.env.COMFY_MOCK;
  return value === "1" || value === "true";
}

/** Env var that replaces COMFY_API_KEY for this slug. Null means the shared key. */
export function keyEnvFor(slug?: string): string | null {
  if (!slug) return null;
  const name = loadDeployments().apps[slug]?.keyEnv?.trim();
  return name || null;
}

/**
 * Key for a deployment.
 * A slug whose record sets `keyEnv` uses only that variable.
 * Every other caller keeps COMFY_API_KEY, then COMFY_CLOUD_API_KEY.
 */
export function apiKey(slug?: string): string | null {
  const dedicated = keyEnvFor(slug);
  if (dedicated) {
    const value = process.env[dedicated]?.trim();
    return value || null;
  }
  const preferred = process.env.COMFY_API_KEY?.trim();
  if (preferred) return preferred;
  const legacy = process.env.COMFY_CLOUD_API_KEY?.trim();
  return legacy || null;
}

export function hasApiKey(): boolean {
  return Boolean(apiKey());
}

export function missingKeyMessage(slug?: string): string {
  const dedicated = keyEnvFor(slug);
  if (dedicated) {
    return `Set ${dedicated} on the server for this app, or COMFY_MOCK=1 for sample output.`;
  }
  return "Set COMFY_API_KEY or COMFY_CLOUD_API_KEY on the server, or COMFY_MOCK=1 for sample output.";
}

/** Banner text when a dedicated workspace key is unset. No secret values. */
export function missingDedicatedKeyMessage(onlySlug?: string): string | null {
  const pending: string[] = [];
  const names = new Set<string>();
  for (const [slug, record] of Object.entries(loadDeployments().apps)) {
    if (onlySlug && slug !== onlySlug) continue;
    const name = record.keyEnv?.trim();
    if (!name || process.env[name]?.trim()) continue;
    names.add(name);
    pending.push(getApp(slug)?.title ?? slug);
  }
  if (pending.length === 0) return null;
  const label = pending.length === 1 ? pending[0] : `${pending.slice(0, -1).join(", ")} and ${pending[pending.length - 1]}`;
  return `${label} need ${[...names].join(", ")} on the server. That variable is the only key used for those apps.`;
}
