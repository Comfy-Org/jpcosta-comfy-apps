import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createJob, jobDir } from "@/lib/jobs";
import { runPipeline } from "@/lib/pipeline";
import type { BoxId, EditEngine, PipelineMode } from "@/lib/types";
import { BOX_PRESETS } from "@/lib/presets";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BOX_IDS = new Set(BOX_PRESETS.map((p) => p.id));

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const boxId = String(form.get("boxId") || "");
  const mode = (String(form.get("mode") || "ltx") as PipelineMode) || "ltx";
  const editEngine = (String(form.get("editEngine") || "flux3") as EditEngine) || "flux3";

  if (!BOX_IDS.has(boxId as BoxId)) {
    return NextResponse.json({ error: "Pick a box from the preset library." }, { status: 400 });
  }
  if (mode !== "ltx" && mode !== "h3") {
    return NextResponse.json({ error: "Mode must be ltx or h3." }, { status: 400 });
  }
  if (editEngine !== "flux3" && editEngine !== "qwen") {
    return NextResponse.json({ error: "Edit engine must be flux3 or qwen." }, { status: 400 });
  }

  const photos = form.getAll("photos").filter((v): v is File => v instanceof File && v.size > 0);
  if (photos.length < 5) {
    return NextResponse.json({ error: "Upload at least 5 product-only photos." }, { status: 400 });
  }

  const logoEntry = form.get("logo");
  const logoFile = logoEntry instanceof File && logoEntry.size > 0 ? logoEntry : null;

  const job = await createJob({
    boxId: boxId as BoxId,
    mode,
    editEngine,
    photoCount: photos.length,
    hasLogo: Boolean(logoFile),
  });

  const saved: { absPath: string; filename: string }[] = [];
  for (const [i, file] of photos.entries()) {
    const ext = path.extname(file.name) || ".png";
    const absPath = path.join(jobDir(job.id), "inputs", `photo_${i}${ext}`);
    await writeFile(absPath, Buffer.from(await file.arrayBuffer()));
    saved.push({ absPath, filename: file.name });
  }

  let logoPath: string | undefined;
  if (logoFile) {
    const ext = path.extname(logoFile.name) || ".png";
    logoPath = path.join(jobDir(job.id), "inputs", `logo${ext}`);
    await writeFile(logoPath, Buffer.from(await logoFile.arrayBuffer()));
  }

  void runPipeline({
    jobId: job.id,
    boxId: boxId as BoxId,
    mode,
    editEngine,
    photos: saved,
    logoPath,
  });

  return NextResponse.json({ id: job.id, stage: job.stage });
}
