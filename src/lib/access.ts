import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { apiKey, isMockMode } from "@/lib/env";
import { AppError } from "@/lib/http";
import { kvConfigured, kvCount, kvDelete, kvGet, kvSetIfAbsent } from "@/lib/kv";

/**
 * Who may start a paid job on Unrender. Both run on Comfy Cloud (src/lib/unrender-cloud.ts).
 * - A visitor's own Comfy API key: the jobs run on their Comfy Cloud account and spend their credits.
 *   No limit on how many, clips up to 60 seconds.
 * - An email signed in with a code: one free video per email, up to 10 seconds, paid by the app's key.
 * The code and the session are signed tokens; the store only keeps which emails used their video and the counters.
 */

export const SESSION_COOKIE = "unrender_session";
const SESSION_SECONDS = 12 * 60 * 60;
const CODE_SECONDS = 10 * 60;
const CODE_TRIES = 5;
const SENDS_PER_HOUR = 4;
/** Stills an email may draw before its one video (a retry after a bad clip). */
const STILLS_PER_EMAIL = 3;
export const VISITOR_KEY_FIELD = "comfyKey";
export const VISITOR_KEY_HEADER = "x-comfy-key";

export type Access = { kind: "key"; key: string } | { kind: "email"; email: string };

function secret(): string {
  const explicit = process.env.ACCESS_SECRET?.trim() || process.env.OUTPUT_SIGNING_SECRET?.trim();
  if (explicit) return `access:${explicit}`;
  return `access:${createHash("sha256").update(apiKey("reverse-3d") ?? "unrender-dev").digest("hex")}`;
}

function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify<T extends Record<string, unknown>>(token: string | null | undefined): T | null {
  if (!token || token.length > 2048) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac("sha256", secret()).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { x?: number };
    if (typeof payload.x !== "number" || payload.x < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new AppError(400, "invalid_input", "Enter a valid email address.");
  }
  return email;
}

/** A pasted Comfy API key, or null when the field is empty. It is never stored on the server. */
export function readVisitorKey(form: FormData): string | null {
  return checkVisitorKey(form.get(VISITOR_KEY_FIELD));
}

/** The same key, sent as a header when the browser polls a job or downloads its output. */
export function readVisitorKeyHeader(request: Request): string | null {
  return checkVisitorKey(request.headers.get(VISITOR_KEY_HEADER));
}

function checkVisitorKey(raw: unknown): string | null {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return null;
  if (!/^[\x21-\x7e]{20,256}$/.test(key)) {
    throw new AppError(400, "invalid_input", "That does not look like a Comfy API key. Copy it again from your Comfy account.");
  }
  return key;
}

function hashCode(email: string, code: string, nonce: string): string {
  return createHmac("sha256", secret()).update(`${email}:${code}:${nonce}`).digest("hex");
}

const usedKey = (email: string) => `unrender:used:${email}`;

export function emailLoginReady(): boolean {
  return kvConfigured() && (Boolean(process.env.RESEND_API_KEY?.trim()) || isMockMode());
}

async function sendCodeEmail(email: string, code: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    throw new AppError(503, "access_off", "Email sign-in is not set up yet. Use your own Comfy API key for now.");
  }
  const from = process.env.RESEND_FROM?.trim() || "Unrender <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Unrender code`,
      text: `Your Unrender code is ${code}.\n\nIt works for 10 minutes and gets you one free playblast.\nIf you did not ask for it, ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#17181c"><p>Your Unrender code is</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p><p style="color:#5d6270">It works for 10 minutes and gets you one free playblast. If you did not ask for it, ignore this email.</p></div>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.warn(`resend ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    throw new AppError(502, "upstream_error", "Could not send the code. Check the address and try again.");
  }
}

/**
 * Emails a 6-digit code. Returns the signed challenge the browser sends back with the code.
 * In mock mode without Resend the code comes back in the response, for local testing only.
 */
export async function startEmailLogin(rawEmail: unknown): Promise<{ challenge: string; devCode?: string }> {
  const email = normalizeEmail(rawEmail);
  if (await kvGet(usedKey(email))) {
    throw new AppError(409, "free_used", "This email already made its free video. Use your own Comfy API key to make more.");
  }
  if ((await kvCount(`unrender:send:${email}`, 60 * 60)) > SENDS_PER_HOUR) {
    throw new AppError(429, "rate_limited", "Too many codes for this email. Wait an hour and try again.");
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const nonce = randomBytes(9).toString("base64url");
  const challenge = sign({ k: "code", e: email, h: hashCode(email, code, nonce), n: nonce, x: Date.now() + CODE_SECONDS * 1000 });
  if (isMockMode() && !process.env.RESEND_API_KEY?.trim()) return { challenge, devCode: code };
  await sendCodeEmail(email, code);
  return { challenge };
}

/** Checks the code. Returns the session token for the cookie and whether the free video is still there. */
export async function finishEmailLogin(challenge: unknown, rawCode: unknown): Promise<{ token: string; email: string; used: boolean }> {
  const payload = verify<{ k?: string; e?: string; h?: string; n?: string }>(typeof challenge === "string" ? challenge : null);
  if (!payload || payload.k !== "code" || !payload.e || !payload.h || !payload.n) {
    throw new AppError(400, "code_expired", "That code expired. Ask for a new one.");
  }
  if ((await kvCount(`unrender:try:${payload.n}`, CODE_SECONDS)) > CODE_TRIES) {
    throw new AppError(429, "rate_limited", "Too many tries. Ask for a new code.");
  }
  const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
  const expected = Buffer.from(payload.h, "hex");
  const given = Buffer.from(hashCode(payload.e, code, payload.n), "hex");
  if (code.length !== 6 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError(400, "wrong_code", "That code is not right. Check the email and try again.");
  }
  const token = sign({ k: "session", e: payload.e, x: Date.now() + SESSION_SECONDS * 1000 });
  return { token, email: payload.e, used: Boolean(await kvGet(usedKey(payload.e))) };
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The signed-in email from the request's cookie, or null. */
export function sessionEmail(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const payload = verify<{ k?: string; e?: string }>(match?.slice(SESSION_COOKIE.length + 1));
  return payload?.k === "session" && payload.e ? payload.e : null;
}

export async function freeVideoUsed(email: string): Promise<boolean> {
  return Boolean(await kvGet(usedKey(email)));
}

/** A visitor key wins over a session. Without either, the job is refused before anything is uploaded. */
export function requireAccess(request: Request, form: FormData): Access {
  const key = readVisitorKey(form);
  if (key) return { kind: "key", key };
  const email = sessionEmail(request);
  if (email) return { kind: "email", email };
  throw new AppError(401, "sign_in", "Sign in with your email for one free video, or paste your own Comfy API key.");
}

/** Marks the email's one free video as taken. False when it was already taken. */
export async function claimFreeVideo(email: string): Promise<boolean> {
  return kvSetIfAbsent(usedKey(email), new Date().toISOString());
}

/** Gives the free video back when the job could not be started. */
export async function releaseFreeVideo(email: string): Promise<void> {
  await kvDelete(usedKey(email));
}

/** The look still before the video: a few per email, refused once the free video is taken. */
export async function allowStill(email: string): Promise<void> {
  if (await freeVideoUsed(email)) {
    throw new AppError(403, "free_used", "This email already made its free video. Use your own Comfy API key to make more.");
  }
  if ((await kvCount(`unrender:still:${email}`, 24 * 60 * 60)) > STILLS_PER_EMAIL) {
    throw new AppError(429, "rate_limited", "Too many tries with this email today. Use your own Comfy API key, or try tomorrow.");
  }
}
