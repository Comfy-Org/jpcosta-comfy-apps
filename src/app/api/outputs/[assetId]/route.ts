import { readVisitorKeyHeader } from "@/lib/access";
import { getApp } from "@/lib/config";
import { fetchAssetUrl } from "@/lib/comfy";
import { deploymentTarget, getDeployment } from "@/lib/deployments";
import { isMockMode } from "@/lib/env";
import { errorResponse, AppError } from "@/lib/http";
import { isMockOutputId, parsePublicRouteId } from "@/lib/ids";
import { contentTypeFor, sniffImage } from "@/lib/images";
import { sniffVideo, videoContentType } from "@/lib/media";
import { readMockOutputApp, renderMockOutput } from "@/lib/mock";
import { isPublicApp } from "@/lib/public-surface";
import { verifyAssetSignature } from "@/lib/signing";
import { unrenderTarget } from "@/lib/unrender-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE = 40 * 1024 * 1024;
const MAX_VIDEO = 80 * 1024 * 1024;

function attachment(name: string, type: string, bytes: Uint8Array): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${name.replace(/[^a-zA-Z0-9._-]/g, "") || "output.png"}"`,
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await context.params;
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      throw new AppError(404, "not_found", "Output not found.");
    }
    const routedEarly = parsePublicRouteId(assetId);
    if (routedEarly && !isPublicApp(routedEarly.app)) {
      throw new AppError(404, "not_found", "Output not found.");
    }

    const signature = new URL(request.url).searchParams.get("sig");
    if (!verifyAssetSignature(assetId, signature)) {
      throw new AppError(404, "not_found", "Output not found.");
    }

    if (isMockOutputId(assetId)) {
      if (!isMockMode()) throw new AppError(404, "not_found", "Output not found.");
      const owner = await readMockOutputApp(assetId);
      if (!owner || !isPublicApp(owner)) throw new AppError(404, "not_found", "Output not found.");
      const grids = getApp("sprite-generator")?.grids;
      const png = await renderMockOutput(assetId, grids);
      return attachment("output.png", "image/png", png);
    }

    const routed = parsePublicRouteId(assetId);
    if (!routed || !isPublicApp(routed.app) || !getDeployment(routed.app)) throw new AppError(404, "not_found", "Output not found.");

    const target = routed.app === "reverse-3d" ? unrenderTarget(readVisitorKeyHeader(request)) : deploymentTarget(routed.app);
    const signed = await fetchAssetUrl(target, routed.id);
    let upstream: Response;
    try {
      upstream = await fetch(signed, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new AppError(502, "upstream_error", "Could not download the output.");
    }
    if (!upstream.ok || !upstream.url.startsWith("https://")) {
      throw new AppError(502, "upstream_error", "Could not download the output.");
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength === 0) throw new AppError(502, "upstream_error", "The deployment returned an empty output.");
    const buf = Buffer.from(bytes);
    const videoKind = sniffVideo(buf);
    if (videoKind) {
      if (bytes.byteLength > MAX_VIDEO) throw new AppError(502, "upstream_error", "Output video is too large to proxy.");
      const ext = videoKind === "webm" ? "webm" : "mp4";
      return attachment(`output.${ext}`, videoContentType(videoKind), bytes);
    }
    if (bytes.byteLength > MAX_IMAGE) throw new AppError(502, "upstream_error", "Output image is too large to proxy.");

    const kind = sniffImage(buf) ?? "bin";
    const type = contentTypeFor(kind);
    const ext = kind === "jpeg" ? "jpg" : kind === "bin" ? "bin" : kind;
    return attachment(`output.${ext}`, type, bytes);
  } catch (error) {
    return errorResponse(error);
  }
}
