import { downloadPublicImage } from "@/lib/fetch-image";
import { errorResponse, AppError } from "@/lib/http";
import { contentTypeFor, sniffImage } from "@/lib/images";
import { isPublicApp } from "@/lib/public-surface";
import { readSceneChoice } from "@/lib/scene-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    if (!isPublicApp("paparazzi-me")) throw new AppError(404, "not_found", "Not found.");
    const url = new URL(request.url);
    const choice = readSceneChoice(url.searchParams.get("token") ?? "");
    const full = url.searchParams.get("size") === "full";
    let buf: Buffer;
    try {
      buf = await downloadPublicImage(full ? choice.imageUrl : choice.thumbUrl || choice.imageUrl);
    } catch (error) {
      if (full || choice.thumbUrl === choice.imageUrl) throw error;
      try {
        buf = await downloadPublicImage(choice.imageUrl);
      } catch {
        if (error instanceof AppError) throw error;
        throw new AppError(502, "scene_download_failed", "Could not download that photo.");
      }
    }
    const kind = sniffImage(buf);
    if (!kind) throw new AppError(502, "scene_download_failed", "That photo was not a PNG, JPG, or WebP image.");
    // Node Buffer is Uint8Array<ArrayBufferLike>, which is not a fetch BodyInit under this TypeScript version.
    const body = new Uint8Array(buf.byteLength);
    body.set(buf);
    return new Response(body, {
      headers: {
        "Content-Type": contentTypeFor(kind),
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
