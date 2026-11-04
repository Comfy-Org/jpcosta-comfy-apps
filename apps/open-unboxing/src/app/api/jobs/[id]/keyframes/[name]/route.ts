import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir, readJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; name: string }> },
): Promise<Response> {
  const { id, name } = await ctx.params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  if (!/^kf[0-4]_[a-z]+\.png$/.test(name)) {
    return NextResponse.json({ error: "Unknown keyframe." }, { status: 400 });
  }
  const abs = path.join(jobDir(id), "out", name);
  try {
    await stat(abs);
  } catch {
    return NextResponse.json({ error: "Not ready." }, { status: 404 });
  }
  const buf = await readFile(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "image/png", "Content-Length": String(buf.length) },
  });
}
