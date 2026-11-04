import { NextResponse } from "next/server";
import { ComfyError, redact, submitWorkflow, uploadInput } from "@/lib/comfy";
import type { PipelineId } from "@/lib/types";
import { PIPELINES } from "@/lib/types";
import {
  DEFAULT_MASK_OBJECT,
  DEFAULT_PROMPT,
  loadWorkflow,
  patchWorkflow,
  wanFrameCount,
} from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function asPipeline(value: FormDataEntryValue | null): PipelineId {
  const id = String(value || "ltx");
  if (PIPELINES.some((p) => p.id === id)) return id as PipelineId;
  return "ltx";
}

function extOf(file: File, fallback: string): string {
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return name.slice(dot).toLowerCase();
  if (file.type.includes("png")) return ".png";
  if (file.type.includes("jpeg") || file.type.includes("jpg")) return ".jpg";
  if (file.type.includes("webp")) return ".webp";
  if (file.type.includes("mp4")) return ".mp4";
  if (file.type.includes("webm")) return ".webm";
  return fallback;
}

type SkuSpec = { id: string; name: string };

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const video = form.get("video");
    if (!(video instanceof File) || video.size === 0) {
      return NextResponse.json({ error: "Upload a source video." }, { status: 400 });
    }

    const pipeline = asPipeline(form.get("pipeline"));
    const prompt = String(form.get("prompt") || DEFAULT_PROMPT);
    const maskObject = String(form.get("maskObject") || DEFAULT_MASK_OBJECT);
    const seed = Number(form.get("seed") || Date.now() % 1_000_000_000);
    const durationSec = Number(form.get("durationSec") || 0) || undefined;
    const width = Number(form.get("width") || 0) || undefined;
    const height = Number(form.get("height") || 0) || undefined;
    const skipPartnerNodes =
      form.get("skipPartner") === "1" || form.get("skipPartner") === "true";
    const frames =
      Number(form.get("frames") || 0) ||
      (pipeline === "wan-vace" && durationSec
        ? wanFrameCount(durationSec)
        : undefined);

    let skuSpecs: SkuSpec[] = [];
    const rawSpecs = form.get("skus");
    if (typeof rawSpecs === "string" && rawSpecs.trim()) {
      skuSpecs = JSON.parse(rawSpecs) as SkuSpec[];
    }
    if (!skuSpecs.length) {
      skuSpecs = [{ id: "sku-1", name: "SKU 1" }];
    }

    const uploadedVideo = await uploadInput(
      video,
      `ops_src_${Date.now()}${extOf(video, ".mp4")}`,
    );

    const jobs: { id: string; skuId: string; skuName: string; pipeline: PipelineId }[] =
      [];

    for (const spec of skuSpecs) {
      const photos: File[] = [];
      for (const [key, value] of form.entries()) {
        if (key === `sku_${spec.id}` && value instanceof File && value.size > 0) {
          photos.push(value);
        }
      }
      if (!photos.length) {
        return NextResponse.json(
          { error: `SKU “${spec.name}” needs at least one product photo.` },
          { status: 400 },
        );
      }
      if (photos.length > 5) {
        return NextResponse.json(
          { error: "Each SKU accepts at most 5 photos." },
          { status: 400 },
        );
      }

      const skuFilenames: string[] = [];
      for (const [index, photo] of photos.entries()) {
        const uploaded = await uploadInput(
          photo,
          `ops_${spec.id}_${index}${extOf(photo, ".png")}`,
        );
        skuFilenames.push(uploaded.filename);
      }

      const workflow = patchWorkflow(await loadWorkflow(pipeline), {
        pipeline,
        videoFilename: uploadedVideo.filename,
        skuFilenames,
        maskObject,
        prompt,
        seed: seed + jobs.length * 97,
        width,
        height,
        durationSec,
        frames,
        skipPartnerNodes,
      });

      const id = await submitWorkflow(workflow);
      jobs.push({
        id,
        skuId: spec.id,
        skuName: spec.name,
        pipeline,
      });
    }

    return NextResponse.json({ jobs });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "Submit failed");
    const status = error instanceof ComfyError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
