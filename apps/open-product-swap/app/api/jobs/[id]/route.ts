import { NextResponse } from "next/server";
import { ComfyError, getJob, redact } from "@/lib/comfy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }
    const snapshot = await getJob(id);
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "Poll failed");
    const status = error instanceof ComfyError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
