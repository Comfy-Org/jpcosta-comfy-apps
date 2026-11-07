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

const ISO_PARENT = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/**
 * 90° and 270° display matrices. LoadVideo (Comfy `VideoFromFile.get_components`)
 * applies `np.rot90` for an odd rotation quadrant, which swaps the decoded frame.
 * The coded sample size stays unrotated, so the fit canvas has to follow the
 * decoded orientation or ResizeAndPadImage letterboxes the long way.
 */
function matrixSwapsAxes(a: number, b: number, c: number, d: number): boolean {
  const scale = 65536;
  return Math.abs(a) < scale / 2 && Math.abs(d) < scale / 2 && Math.abs(b) > scale / 2 && Math.abs(c) > scale / 2;
}

function readTkhdSwap(buf: Buffer, content: number, end: number): boolean {
  if (content >= end) return false;
  const version = buf[content] ?? 0;
  const matrix = content + (version === 1 ? 52 : 40);
  if (matrix + 20 > end) return false;
  const a = buf.readInt32BE(matrix);
  const b = buf.readInt32BE(matrix + 4);
  const c = buf.readInt32BE(matrix + 12);
  const d = buf.readInt32BE(matrix + 16);
  return matrixSwapsAxes(a, b, c, d);
}

function readVisualSample(buf: Buffer, cursor: number): { width: number; height: number } | null {
  if (cursor + 36 > buf.length) return null;
  const width = buf.readUInt16BE(cursor + 32);
  const height = buf.readUInt16BE(cursor + 34);
  if (width >= 2 && height >= 2 && width <= 16384 && height <= 16384) return { width, height };
  return null;
}

function readIsoVideoSize(buf: Buffer): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  function walk(offset: number, end: number, inSample: boolean, handler: string | null, swap: boolean): void {
    let cursor = offset;
    while (cursor + 8 <= end) {
      const box = boxSize(buf, cursor);
      if (!box || cursor + box.size > end) return;
      const type = buf.toString("latin1", cursor + 4, cursor + 8);
      const content = cursor + box.header;
      const boxEnd = cursor + box.size;
      if (type === "trak") {
        walk(content, boxEnd, false, null, false);
      } else if (type === "tkhd") {
        swap = readTkhdSwap(buf, content, boxEnd);
      } else if (type === "hdlr" && content + 12 <= boxEnd) {
        const next = buf.toString("latin1", content + 8, content + 12);
        if (next === "vide" || next === "soun") handler = next;
      } else if (type === "stsd" && content + 8 <= boxEnd) {
        walk(content + 8, boxEnd, true, handler, swap);
      } else if (inSample && VISUAL_SAMPLE.has(type) && (handler === "vide" || handler === null)) {
        const sample = readVisualSample(buf, cursor);
        if (sample && !found) {
          found = swap ? { width: sample.height, height: sample.width } : sample;
        }
      } else if (!inSample && ISO_PARENT.has(type)) {
        walk(content, boxEnd, false, handler, swap);
      }
      cursor = boxEnd;
    }
  }
  walk(0, buf.length, false, null, false);
  return found;
}

/**
 * EBML element size. Unknown length is every *data* bit set, per VINT width.
 * An 8-byte unknown size is `01 FF FF FF FF FF FF FF`: the marker fills the
 * first byte, so a raw "all bytes are 0xFF" check misses Chrome MediaRecorder.
 */
function readEbmlVint(buf: Buffer, offset: number): { length: number; data: bigint; unknown: boolean } | null {
  if (offset >= buf.length) return null;
  const marker = buf[offset] ?? 0;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (marker & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let data = BigInt(marker & ((mask - 1) & 0xff));
  for (let index = 1; index < length; index += 1) data = (data << 8n) + BigInt(buf[offset + index] ?? 0);
  const width = 7n * BigInt(length);
  const unknown = data === (1n << width) - 1n;
  return { length, data, unknown };
}

function readEbmlId(buf: Buffer, offset: number): { value: number; length: number } | null {
  const sized = readEbmlVint(buf, offset);
  if (!sized) return null;
  let value = 0;
  for (let index = 0; index < sized.length; index += 1) value = value * 256 + (buf[offset + index] ?? 0);
  return { value, length: sized.length };
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

/** How far to look for PixelWidth/PixelHeight. This is not the end of the file. */
export const WEBM_HEADER_SCAN_BYTES = 1_500_000;

function readWebmSize(buf: Buffer): { width: number; height: number } | null {
  const scanEnd = Math.min(buf.length, WEBM_HEADER_SCAN_BYTES);
  let width = 0;
  let height = 0;
  // `containerEnd` is the parent element's real end (the file, for the top call).
  // A finite Segment larger than the scan budget is still valid; only a size past
  // that real end is truncated. Cluster bytes after the budget are not read.
  function walk(offset: number, containerEnd: number): boolean {
    const lookEnd = Math.min(containerEnd, scanEnd);
    while (offset + 2 <= lookEnd) {
      const id = readEbmlId(buf, offset);
      if (!id) return false;
      const size = readEbmlVint(buf, offset + id.length);
      if (!size) return false;
      const data = offset + id.length + size.length;
      let childEnd = containerEnd;
      if (!size.unknown) {
        if (data > containerEnd || size.data > BigInt(containerEnd - data)) return false;
        childEnd = data + Number(size.data);
      }
      if (childEnd < data || childEnd > containerEnd) return false;
      const payloadEnd = data + Number(size.data);
      if (id.value === 0xb0 && size.data >= 1n && size.data <= 4n && payloadEnd <= buf.length) {
        width = buf.readUIntBE(data, Number(size.data));
      } else if (id.value === 0xba && size.data >= 1n && size.data <= 4n && payloadEnd <= buf.length) {
        height = buf.readUIntBE(data, Number(size.data));
      } else if (WEBM_MASTER.has(id.value) && data < lookEnd) {
        if (walk(data, childEnd)) return true;
      }
      if (width >= 2 && height >= 2) return true;
      if (size.unknown || childEnd > lookEnd) break;
      offset = childEnd;
    }
    return width >= 2 && height >= 2;
  }
  if (!walk(0, buf.length)) return null;
  if (width >= 2 && height >= 2 && width <= 16384 && height <= 16384) return { width, height };
  return null;
}

/**
 * Frame size LoadVideo will decode. MP4/MOV sample dimensions are swapped when
 * the track matrix is 90° or 270°. WebM uses PixelWidth and PixelHeight, and
 * an unknown-length Segment does not reject the file.
 */
export function readVideoPixelSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    return readIsoVideoSize(buf);
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return readWebmSize(buf);
  }
  return null;
}
