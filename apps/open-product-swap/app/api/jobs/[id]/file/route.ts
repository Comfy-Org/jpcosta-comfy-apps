import { NextResponse } from "next/server";
import { ComfyError, downloadOutput, redact } from "@/lib/comfy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const filename = url.searchParams.get("filename") || "output";
    if (!id && !url.searchParams.get("filename")) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const file = await downloadOutput({
      id: id || undefined,
      filename,
      subfolder: url.searchParams.get("subfolder") || "",
      type: url.searchParams.get("type") || "output",
    });
    const headers = new Headers();
    headers.set("Content-Type", file.contentType);
    headers.set("Cache-Control", "private, max-age=300");
    const safeName = filename.replace(/"/g, "");
    headers.set("Content-Disposition", `inline; filename="${safeName}"`);
    return new NextResponse(file.bytes, { headers });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "Download failed");
    const status = error instanceof ComfyError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
