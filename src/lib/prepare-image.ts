const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/jpg"]);
const TARGET_BYTES = 3_600_000;
export const VIDEO_MAX_BYTES = 4 * 1024 * 1024;
/** File bytes to keep under Vercel's request-body cap, including a video plus photos. */
export const FORM_BUDGET_BYTES = 3_800_000;
/** A 4 MB clip plus a small product photo, still under the 4.5 MB request cap. */
export const VIDEO_FORM_BUDGET_BYTES = 4_480_000;

export function videoTypeRejectReason(file: File): string | null {
  const type = file.type.toLowerCase();
  const named = /\.(mp4|mov|webm)$/i.test(file.name);
  const typed = type === "video/mp4" || type === "video/quicktime" || type === "video/webm" || type === "video/mov";
  if (!named && !typed) return "Use an MP4, MOV, or WebM video.";
  if (file.size <= 0) return "That video is empty.";
  return null;
}

export function videoRejectReason(file: File): string | null {
  const typed = videoTypeRejectReason(file);
  if (typed) return typed;
  if (file.size > VIDEO_MAX_BYTES) {
    return "That video is over 4 MB. Trim it and try again. Uploads have to stay under about 4.5 MB.";
  }
  return null;
}

export function imageRejectReason(file: File): string | null {
  const named = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!ALLOWED.has(file.type) && !named) return "Use a PNG, JPG, or WebP image.";
  if (file.size <= 0) return "That image is empty.";
  if (file.size > 15 * 1024 * 1024) return "Image must be 15 MB or smaller.";
  return null;
}

export type PreparedFile = {
  file: File;
  width: number;
  height: number;
};

function fail(message: string): never {
  throw new Error(message);
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    fail("Could not read that image.");
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not read that image."))), type, quality);
  });
}

export async function shrinkForUpload(file: File, maxSide = 2048, targetBytes = TARGET_BYTES): Promise<PreparedFile> {
  const reason = imageRejectReason(file);
  if (reason) fail(reason);

  const bitmap = await decode(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const smallEnough = scale === 1 && file.size <= targetBytes && ALLOWED.has(file.type);

  if (smallEnough) {
    bitmap.close();
    return { file, width, height };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) fail("Could not read that image.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = 0.92;
  let blob = await canvasBlob(canvas, "image/jpeg", quality);
  while (blob.size > targetBytes && quality > 0.45) {
    quality -= 0.1;
    blob = await canvasBlob(canvas, "image/jpeg", quality);
  }
  if (blob.size > 4_200_000) {
    fail("That image is still too large after resizing. Try a smaller file.");
  }
  const name = file.name.replace(/\.[^.]+$/, "") || "image";
  return {
    file: new File([blob], `${name}.jpg`, { type: "image/jpeg" }),
    width,
    height,
  };
}

export async function packImages(files: File[], budgetBytes: number, maxSide = 1280): Promise<PreparedFile[]> {
  let side = maxSide;
  let target = Math.max(70_000, Math.floor(budgetBytes / Math.max(1, files.length)));
  let prepared = await Promise.all(files.map((file) => shrinkForUpload(file, side, target)));
  let total = prepared.reduce((sum, item) => sum + item.file.size, 0);
  while (total > budgetBytes && side > 480) {
    side = Math.max(480, Math.round(side * 0.72));
    target = Math.max(50_000, Math.floor(target * 0.68));
    prepared = await Promise.all(files.map((file) => shrinkForUpload(file, side, target)));
    total = prepared.reduce((sum, item) => sum + item.file.size, 0);
  }
  if (total > budgetBytes) {
    fail("Those photos are still over 4 MB together. Use fewer images or smaller files.");
  }
  return prepared;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] & 0x7fffffff;
}
