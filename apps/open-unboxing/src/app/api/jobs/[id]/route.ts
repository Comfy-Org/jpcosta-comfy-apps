import { NextResponse } from "next/server";
import { readJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const job = await readJob(id);
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  return NextResponse.json(job);
}
