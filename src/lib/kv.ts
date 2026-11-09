import { isMockMode } from "@/lib/env";
import { AppError } from "@/lib/http";

/**
 * A few keys in Upstash Redis over its REST API (Vercel Marketplace sets either name pair).
 * Mock mode keeps them in memory, so local runs need no database.
 */

const memory = new Map<string, { value: string; expires: number | null }>();

function restConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function kvConfigured(): boolean {
  return Boolean(restConfig()) || isMockMode();
}

async function command(args: (string | number)[]): Promise<unknown> {
  const config = restConfig();
  if (!config) {
    throw new AppError(503, "access_off", "Free videos are not set up yet. Use your own Comfy API key for now.");
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(args.map(String)),
    signal: AbortSignal.timeout(8000),
  });
  const payload = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!response.ok || !payload || payload.error) {
    throw new AppError(502, "upstream_error", "Could not reach the sign-in store. Try again in a moment.");
  }
  return payload.result;
}

function memoryRead(key: string): string | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expires !== null && hit.expires <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function inMemory(): boolean {
  return !restConfig() && isMockMode();
}

export async function kvGet(key: string): Promise<string | null> {
  if (inMemory()) return memoryRead(key);
  const result = await command(["GET", key]);
  return typeof result === "string" ? result : null;
}

/** Sets the key only when it is not there yet. True when this call set it. */
export async function kvSetIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
  if (inMemory()) {
    if (memoryRead(key) !== null) return false;
    memory.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    return true;
  }
  const args: (string | number)[] = ["SET", key, value, "NX"];
  if (ttlSeconds) args.push("EX", ttlSeconds);
  return (await command(args)) === "OK";
}

export async function kvDelete(key: string): Promise<void> {
  if (inMemory()) {
    memory.delete(key);
    return;
  }
  await command(["DEL", key]);
}

/** Counts up and returns the new count. The window starts with the first count. */
export async function kvCount(key: string, windowSeconds: number): Promise<number> {
  if (inMemory()) {
    const next = Number(memoryRead(key) ?? "0") + 1;
    const expires = memory.get(key)?.expires ?? Date.now() + windowSeconds * 1000;
    memory.set(key, { value: String(next), expires });
    return next;
  }
  const count = Number(await command(["INCR", key]));
  if (count === 1) await command(["EXPIRE", key, windowSeconds]);
  return count;
}
