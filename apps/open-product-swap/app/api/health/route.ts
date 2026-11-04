import { NextResponse } from "next/server";
import { comfyBaseUrl, pingComfy, redact } from "@/lib/comfy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const hasKey = Boolean(process.env.COMFY_API_KEY);
  const base = comfyBaseUrl();
  if (!hasKey) {
    return NextResponse.json({ ok: false, hasKey: false, base, cloud: null });
  }
  try {
    const ping = await pingComfy();
    return NextResponse.json({
      ok: ping.ok,
      cloud: ping.cloudVersion ?? null,
      hasKey: true,
      base,
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "health check failed");
    return NextResponse.json(
      { ok: false, error: message, hasKey, base },
      { status: 500 },
    );
  }
}
