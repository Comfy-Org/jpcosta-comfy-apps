import { AppError } from "@/lib/http";
import type { Workflow } from "@/lib/workflow";

/**
 * Kling 4.0 Edit rejects a source under 700px on either side, over 4553px,
 * or with a width/height ratio outside 0.40–2.50 (fal / Creatify schema;
 * the live error was "Video height must be at least 700px").
 * The working frame is also capped at 1080p-class pixels so an 18s 24fps
 * batch is not upscaled toward that 4553px ceiling.
 */
export const KLING_MIN_SIDE = 700;
export const KLING_MAX_SIDE = 4553;
export const KLING_MIN_ASPECT = 0.4;
export const KLING_MAX_ASPECT = 2.5;
export const KLING_FRAME_MAX_SIDE = 1920;
export const KLING_FRAME_MAX_PIXELS = 1920 * 1080;

/** ResizeAndPadImage between GetVideoComponents and CreateVideo. */
export const KLING_FIT_NODE = "17";

export type KlingFrame = {
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  padded: boolean;
};

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function contained(srcW: number, srcH: number, canvasW: number, canvasH: number): { contentWidth: number; contentHeight: number } {
  const scale = Math.min(canvasW / srcW, canvasH / srcH);
  const contentWidth = Math.trunc(srcW * scale);
  const contentHeight = Math.trunc(srcH * scale);
  if (contentWidth < 2 || contentHeight < 2) {
    throw new AppError(400, "invalid_input", "That video is too thin to fit the playblast frame.");
  }
  return { contentWidth, contentHeight };
}

function paddedFrame(srcW: number, srcH: number, canvasW: number, canvasH: number): KlingFrame {
  const content = contained(srcW, srcH, canvasW, canvasH);
  return {
    width: canvasW,
    height: canvasH,
    contentWidth: content.contentWidth,
    contentHeight: content.contentHeight,
    padded: content.contentWidth < canvasW || content.contentHeight < canvasH,
  };
}

/**
 * Canvas for ResizeAndPadImage. The whole frame is scaled uniformly.
 * Bars are added only when the ratio is outside Kling's 0.40–2.50 window,
 * using the smallest legal canvas (700px on the short side).
 */
export function fitKlingFrame(srcWidth: number, srcHeight: number): KlingFrame {
  if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth < 1 || srcHeight < 1) {
    throw new AppError(400, "invalid_input", "Could not read that video's dimensions.");
  }
  const srcW = Math.round(srcWidth);
  const srcH = Math.round(srcHeight);
  const aspect = srcW / srcH;

  if (aspect < KLING_MIN_ASPECT) {
    return paddedFrame(srcW, srcH, KLING_MIN_SIDE, even(KLING_MIN_SIDE / KLING_MIN_ASPECT));
  }
  if (aspect > KLING_MAX_ASPECT) {
    return paddedFrame(srcW, srcH, even(KLING_MIN_SIDE * KLING_MAX_ASPECT), KLING_MIN_SIDE);
  }

  let scale = 1;
  const short = Math.min(srcW, srcH);
  const long = Math.max(srcW, srcH);
  if (short < KLING_MIN_SIDE) scale = KLING_MIN_SIDE / short;
  if (long * scale > KLING_FRAME_MAX_SIDE) scale = KLING_FRAME_MAX_SIDE / long;
  if (srcW * srcH * scale * scale > KLING_FRAME_MAX_PIXELS) {
    scale = Math.sqrt(KLING_FRAME_MAX_PIXELS / (srcW * srcH));
  }

  const width = Math.min(KLING_FRAME_MAX_SIDE, Math.max(KLING_MIN_SIDE, even(srcW * scale)));
  const height = Math.min(KLING_FRAME_MAX_SIDE, Math.max(KLING_MIN_SIDE, even(srcH * scale)));
  const outAspect = width / height;
  if (outAspect < KLING_MIN_ASPECT || outAspect > KLING_MAX_ASPECT) {
    return outAspect < KLING_MIN_ASPECT
      ? paddedFrame(srcW, srcH, KLING_MIN_SIDE, even(KLING_MIN_SIDE / KLING_MIN_ASPECT))
      : paddedFrame(srcW, srcH, even(KLING_MIN_SIDE * KLING_MAX_ASPECT), KLING_MIN_SIDE);
  }
  return paddedFrame(srcW, srcH, width, height);
}

export function applyKlingFrame(workflow: Workflow, srcWidth: number, srcHeight: number): KlingFrame {
  const frame = fitKlingFrame(srcWidth, srcHeight);
  const node = workflow[KLING_FIT_NODE];
  if (!node || node.class_type !== "ResizeAndPadImage") {
    throw new AppError(500, "internal", "Reverse 3D is missing its frame fit node.");
  }
  node.inputs.target_width = frame.width;
  node.inputs.target_height = frame.height;
  node.inputs.padding_color = "black";
  node.inputs.interpolation = "lanczos";
  return frame;
}

function boxSize(buf: Buffer, offset: number): { size: number; header: number } | null {
  if (offset + 8 > buf.length) return null;
  const size32 = buf.readUInt32BE(offset);
  if (size32 === 1) {
    if (offset + 16 > buf.length) return null;
    const size = Number(buf.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(size) || size < 16) return null;
    return { size, header: 16 };
  }
  if (size32 === 0) return { size: buf.length - offset, header: 8 };
  if (size32 < 8) return null;
  return { size: size32, header: 8 };
}

const VISUAL_SAMPLE = new Set([
  "avc1",
  "avc3",
  "avc4",
  "hvc1",
  "hev1",
  "vp08",
  "vp09",
  "av01",
  "mp4v",
  "encv",
  "apch",
  "apcn",
  "apcs",
  "apco",
  "dvh1",
  "dvhe",
]);

function readStsdSize(buf: Buffer, offset: number, end: number, inSample: boolean): { width: number; height: number } | null {
  let cursor = offset;
  while (cursor + 8 <= end) {
    const box = boxSize(buf, cursor);
    if (!box || cursor + box.size > end) return null;
    const type = buf.toString("latin1", cursor + 4, cursor + 8);
    const start = cursor + box.header;
    const boxEnd = cursor + box.size;
    if (inSample && VISUAL_SAMPLE.has(type) && cursor + 36 <= buf.length) {
      const width = buf.readUInt16BE(cursor + 32);
      const height = buf.readUInt16BE(cursor + 34);
      if (width >= 2 && height >= 2 && width <= 16384 && height <= 16384) return { width, height };
    } else if (type === "stsd" && start + 8 <= boxEnd) {
      const entry = readStsdSize(buf, start + 8, boxEnd, true);
      if (entry) return entry;
    } else if (!inSample && (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl")) {
      const entry = readStsdSize(buf, start, boxEnd, false);
      if (entry) return entry;
    }
    cursor = boxEnd;
  }
  return null;
}

function vint(buf: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const marker = buf[offset] ?? 0;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (marker & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = marker & (mask - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + (buf[offset + index] ?? 0);
  return { value, length };
}

const WEBM_MASTER = new Set([
  0x1a45dfa3, // EBML
  0x18538067, // Segment
  0x114d9b74, // SeekHead
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xe0, // Video
]);

function readWebmId(buf: Buffer, offset: number): { value: number; length: number } | null {
  const sized = vint(buf, offset);
  if (!sized) return null;
  let value = 0;
  for (let index = 0; index < sized.length; index += 1) value = value * 256 + (buf[offset + index] ?? 0);
  return { value, length: sized.length };
}

function readWebmSize(buf: Buffer): { width: number; height: number } | null {
  const limit = Math.min(buf.length, 1_500_000);
  let width = 0;
  let height = 0;
  function walk(offset: number, end: number): boolean {
    while (offset + 2 <= end) {
      const id = readWebmId(buf, offset);
      const size = vint(buf, offset + (id?.length ?? 0));
      if (!id || !size) return false;
      const data = offset + id.length + size.length;
      const rawSize = buf.subarray(offset + id.length, data);
      const allOnes = rawSize.length > 0 && [...rawSize].every((byte) => byte === 0xff);
      const childEnd = allOnes ? end : data + size.value;
      if (childEnd < data || childEnd > end + 8) return false;
      const bounded = Math.min(childEnd, limit);
      if (id.value === 0xb0 && size.value >= 1 && size.value <= 4 && data + size.value <= buf.length) {
        width = buf.readUIntBE(data, size.value);
      } else if (id.value === 0xba && size.value >= 1 && size.value <= 4 && data + size.value <= buf.length) {
        height = buf.readUIntBE(data, size.value);
      } else if (WEBM_MASTER.has(id.value)) {
        if (walk(data, bounded)) return true;
      }
      if (width >= 2 && height >= 2) return true;
      if (allOnes) break;
      offset = childEnd;
    }
    return width >= 2 && height >= 2;
  }
  walk(0, limit);
  if (width >= 2 && height >= 2 && width <= 16384 && height <= 16384) return { width, height };
  return null;
}

/** Coded frame size for the MP4, MOV, and WebM files this app accepts. */
export function readVideoPixelSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    return readStsdSize(buf, 0, buf.length, false);
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return readWebmSize(buf);
  }
  return null;
}
