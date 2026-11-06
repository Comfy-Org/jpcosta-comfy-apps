import { AppError } from "@/lib/http";

/** Stay under Vercel's ~4.5 MB request-body cap, with room for the other form fields. */
export const VIDEO_MAX_BYTES = 4 * 1024 * 1024;

const DECLARED = new Set([
  "",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/mov",
  "application/octet-stream",
]);

export type PreparedVideo = {
  bytes: Buffer;
  contentType: string;
  filePath: string;
};

function bad(message: string): never {
  throw new AppError(400, "invalid_input", message);
}

/** Strip RFC 6838 parameters such as ";codecs=vp9" so MediaRecorder types match. */
export function videoMimeEssence(type: string): string {
  return type.toLowerCase().split(";")[0].trim();
}

export function isAllowedVideoMime(type: string): boolean {
  return DECLARED.has(videoMimeEssence(type));
}

export function sniffVideo(buf: Buffer): "mp4" | "mov" | "webm" | null {
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand.startsWith("qt")) return "mov";
    return "mp4";
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  return null;
}

export function videoContentType(kind: "mp4" | "mov" | "webm"): string {
  if (kind === "webm") return "video/webm";
  if (kind === "mov") return "video/quicktime";
  return "video/mp4";
}

export async function prepareVideo(file: File, maxBytes = VIDEO_MAX_BYTES): Promise<PreparedVideo> {
  if (!(file instanceof File) || file.size <= 0) bad("Upload a video of someone holding the product.");
  if (file.size > maxBytes) {
    bad("That video is over 4 MB. Trim it and try again. Uploads have to stay under about 4.5 MB.");
  }
  if (!isAllowedVideoMime(file.type)) bad("Use an MP4, MOV, or WebM video.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniffVideo(bytes);
  if (!kind) bad("That file is not an MP4, MOV, or WebM video.");
  const ext = kind === "webm" ? "webm" : kind === "mov" ? "mov" : "mp4";
  return {
    bytes,
    contentType: videoContentType(kind),
    filePath: `input.${ext}`,
  };
}
