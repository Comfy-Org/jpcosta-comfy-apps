import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
  if (!job?.outputRelpath) {
    return NextResponse.json({ error: "No output yet." }, { status: 404 });
  }
  const abs = path.join(process.cwd(), job.outputRelpath);
  try {
    await stat(abs);
  } catch {
    return NextResponse.json({ error: "Output file missing." }, { status: 404 });
  }
  const buf = await readFile(abs);
  const type = abs.endsWith(".png") ? "image/png" : "video/mp4";
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=60",
    },
  });
}
