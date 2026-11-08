/** Browser helpers for Reverse 3D: duration checks, upload transcode, side-by-side compare. */

export const REVERSE_3D_MAX_SECONDS = 10;
export const REVERSE_3D_MIN_SECONDS = 3;
export const REVERSE_3D_MIN_WIDTH = 720;
export const REVERSE_3D_FPS = 24;
export const REVERSE_3D_UPLOAD_TARGET_BYTES = 3_600_000;

function fail(message: string): never {
  throw new Error(message);
}

function pickRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") fail("This browser cannot record video for upload or compare.");
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function extensionForMime(type: string): string {
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

export function loadVideoElement(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const done = () => {
      el.onloadedmetadata = null;
      el.onerror = null;
      resolve(el);
    };
    el.onloadedmetadata = () => {
      if (el.readyState >= 1) done();
    };
    el.onerror = () => reject(new Error("Could not read that video."));
    el.src = src;
    el.load();
  });
}

export async function probeVideoFile(file: File): Promise<{ duration: number; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const el = await loadVideoElement(url);
    const duration = await readDuration(el);
    const width = el.videoWidth || 0;
    const height = el.videoHeight || 0;
    el.removeAttribute("src");
    el.load();
    return { duration, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    await seekTo(video, 1e9);
  } catch {
    // Some MediaRecorder WebMs expose duration only after a long seek.
  }
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return 0;
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requestTrackFrame(track: MediaStreamTrack): void {
  const typed = track as MediaStreamTrack & { requestFrame?: () => void };
  typed.requestFrame?.();
}

async function recordCanvasFrames(
  canvas: HTMLCanvasElement,
  frameCount: number,
  drawFrame: (index: number) => Promise<void> | void,
  bitsPerSecond: number,
): Promise<Blob> {
  const mime = pickRecorderMime();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  if (!track) fail("This browser cannot record video for upload or compare.");
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond })
    : new MediaRecorder(stream, { videoBitsPerSecond: bitsPerSecond });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("Could not record the video."));
    recorder.onstop = () => {
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
      if (chunks.length === 0) {
        reject(new Error("Could not record the video."));
        return;
      }
      resolve(new Blob(chunks, { type: recorder.mimeType || mime || "video/webm" }));
    };
  });
  recorder.start(100);
  const frameDelay = 1000 / REVERSE_3D_FPS;
  for (let index = 0; index < frameCount; index += 1) {
    await drawFrame(index);
    requestTrackFrame(track);
    await sleep(frameDelay);
  }
  if (recorder.state !== "inactive") recorder.stop();
  return stopped;
}

function estimateFrameDuration(video: HTMLVideoElement): number {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) return 1 / REVERSE_3D_FPS;
  const errorFor = (fps: number) => Math.abs(duration * fps - Math.round(duration * fps));
  return errorFor(REVERSE_3D_FPS) <= errorFor(30) ? 1 / REVERSE_3D_FPS : 1 / 30;
}

export function acceptedClipDuration(seconds: number): { duration: number; trimmed: boolean } {
  if (!(seconds > 0)) fail("Could not read that video.");
  if (seconds + 0.05 < REVERSE_3D_MIN_SECONDS) {
    fail(`Use a clip of at least ${REVERSE_3D_MIN_SECONDS} seconds.`);
  }
  const trimmed = seconds > REVERSE_3D_MAX_SECONDS + 0.05;
  return { duration: trimmed ? REVERSE_3D_MAX_SECONDS : seconds, trimmed };
}

export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs((video.currentTime || 0) - time) < 0.0005) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", failSeek);
      resolve();
    };
    const failSeek = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", failSeek);
      reject(new Error("Could not read that video."));
    };
    video.addEventListener("seeked", done);
    video.addEventListener("error", failSeek);
    video.currentTime = Math.max(0, time);
  });
}

export async function prepareReverse3dUpload(file: File): Promise<{
  file: File;
  width: number;
  height: number;
  duration: number;
  trimmed: boolean;
}> {
  const probe = await probeVideoFile(file);
  if (probe.duration <= 0 || probe.width <= 0 || probe.height <= 0) {
    fail("Could not read that video.");
  }
  const accepted = acceptedClipDuration(probe.duration);
  const trimmed = accepted.trimmed;
  const duration = accepted.duration;
  const needsScale = probe.width < REVERSE_3D_MIN_WIDTH;
  const fits = file.size <= REVERSE_3D_UPLOAD_TARGET_BYTES && !needsScale && !trimmed;
  if (fits) return { file, width: probe.width, height: probe.height, duration, trimmed: false };

  const scale = Math.max(REVERSE_3D_MIN_WIDTH / probe.width, 1);
  const width = even(probe.width * scale);
  const height = even(probe.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) fail("Could not prepare that video.");

  const srcUrl = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(srcUrl);
    const frameCount = Math.max(Math.round(duration * REVERSE_3D_FPS), Math.round(REVERSE_3D_MIN_SECONDS * REVERSE_3D_FPS));
    const bitrate = Math.max(400_000, Math.floor((REVERSE_3D_UPLOAD_TARGET_BYTES * 8) / Math.max(duration, 1)));
    const blob = await recordCanvasFrames(
      canvas,
      frameCount,
      async (index) => {
        const time = Math.min((index + 0.5) / REVERSE_3D_FPS, Math.max(duration - 1 / REVERSE_3D_FPS, 0));
        await seekTo(video, time);
        ctx.drawImage(video, 0, 0, width, height);
      },
      bitrate,
    );
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (blob.size > 4 * 1024 * 1024) {
      fail("That video is still over 4 MB after compressing. Try a shorter or smaller clip.");
    }
    const mime = blob.type || "video/webm";
    const cleanType = extensionForMime(mime) === "mp4" ? "video/mp4" : "video/webm";
    const prepared = new File([blob], `input.${extensionForMime(mime)}`, { type: cleanType });
    return { file: prepared, width, height, duration, trimmed };
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

function containSize(srcW: number, srcH: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(maxW / Math.max(srcW, 1), maxH / Math.max(srcH, 1));
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

export async function composeSideBySide(playblastUrl: string, originalUrl: string): Promise<Blob> {
  const playblast = await loadVideoElement(playblastUrl);
  const original = await loadVideoElement(originalUrl);
  const playblastDuration = await readDuration(playblast);
  const originalDuration = await readDuration(original);
  const skipPlayblast = Math.min(estimateFrameDuration(playblast), Math.max(playblastDuration / 2, 0));
  const skipOriginal = Math.min(estimateFrameDuration(original), Math.max(originalDuration / 2, 0));
  const remainPlayblast = playblastDuration - skipPlayblast;
  const remainOriginal = originalDuration - skipOriginal;
  if (remainPlayblast <= 0 || remainOriginal <= 0) fail("Could not build the comparison video.");

  const outputDuration = Math.min(remainPlayblast, remainOriginal);
  const frameCount = Math.max(2, Math.round(outputDuration * REVERSE_3D_FPS));

  const canvasWidth = 1920;
  const canvasHeight = 1080;
  const gutter = 32;
  const marginX = 48;
  const marginY = 48;
  const panelMaxW = (canvasWidth - marginX * 2 - gutter) / 2;
  const panelMaxH = canvasHeight - marginY * 2;
  const left = containSize(original.videoWidth || 1, original.videoHeight || 1, panelMaxW, panelMaxH);
  const right = containSize(playblast.videoWidth || 1, playblast.videoHeight || 1, panelMaxW, panelMaxH);
  const groupW = left.width + gutter + right.width;
  const leftX = even((canvasWidth - groupW) / 2);
  const rightX = leftX + left.width + gutter;
  const leftY = even((canvasHeight - left.height) / 2);
  const rightY = even((canvasHeight - right.height) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) fail("Could not build the comparison video.");

  const bitrate = Math.max(1_200_000, Math.floor((8_000_000 * 8) / Math.max(outputDuration, 1)));
  try {
    return await recordCanvasFrames(
      canvas,
      frameCount,
      async (index) => {
        const u = frameCount <= 1 ? 0 : index / (frameCount - 1);
        await seekTo(original, skipOriginal + u * remainOriginal);
        await seekTo(playblast, skipPlayblast + u * remainPlayblast);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.drawImage(original, leftX, leftY, left.width, left.height);
        ctx.drawImage(playblast, rightX, rightY, right.width, right.height);
      },
      bitrate,
    );
  } finally {
    playblast.pause();
    original.pause();
    playblast.removeAttribute("src");
    original.removeAttribute("src");
    playblast.load();
    original.load();
  }
}
