/** Browser helpers for Reverse 3D: duration checks, upload transcode, side-by-side compare. */

export const REVERSE_3D_MAX_SECONDS = 18;
export const REVERSE_3D_MIN_WIDTH = 720;
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
    const duration = Number.isFinite(el.duration) ? el.duration : 0;
    const width = el.videoWidth || 0;
    const height = el.videoHeight || 0;
    el.removeAttribute("src");
    el.load();
    return { duration, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

async function recordRealtime(canvas: HTMLCanvasElement, duration: number, draw: () => boolean, bitsPerSecond: number): Promise<Blob> {
  const mime = pickRecorderMime();
  const stream = canvas.captureStream(30);
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
      for (const track of stream.getTracks()) track.stop();
      if (chunks.length === 0) {
        reject(new Error("Could not record the video."));
        return;
      }
      resolve(new Blob(chunks, { type: recorder.mimeType || mime || "video/webm" }));
    };
  });
  recorder.start(250);
  const deadline = performance.now() + duration * 1000 + 250;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const keepGoing = draw();
      if (!keepGoing || performance.now() >= deadline) {
        if (recorder.state !== "inactive") recorder.stop();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  return stopped;
}

async function playFromStart(video: HTMLVideoElement): Promise<void> {
  video.currentTime = 0;
  await video.play();
}

export async function prepareReverse3dUpload(file: File): Promise<{ file: File; width: number; height: number; duration: number }> {
  const probe = await probeVideoFile(file);
  if (probe.duration <= 0 || probe.width <= 0 || probe.height <= 0) {
    fail("Could not read that video.");
  }
  if (probe.duration > REVERSE_3D_MAX_SECONDS + 0.05) {
    fail(`Use a clip of ${REVERSE_3D_MAX_SECONDS} seconds or less.`);
  }
  const needsScale = probe.width < REVERSE_3D_MIN_WIDTH;
  const fits = file.size <= REVERSE_3D_UPLOAD_TARGET_BYTES && !needsScale;
  if (fits) return { file, width: probe.width, height: probe.height, duration: probe.duration };

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
    await playFromStart(video);
    const bitrate = Math.max(400_000, Math.floor((REVERSE_3D_UPLOAD_TARGET_BYTES * 8) / Math.max(probe.duration, 1)));
    const blob = await recordRealtime(
      canvas,
      probe.duration,
      () => {
        ctx.drawImage(video, 0, 0, width, height);
        return !video.ended && video.currentTime < probe.duration;
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
    const prepared = new File([blob], `input.${extensionForMime(mime)}`, { type: mime });
    return { file: prepared, width, height, duration: probe.duration };
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

export async function composeSideBySide(playblastUrl: string, originalUrl: string): Promise<Blob> {
  const playblast = await loadVideoElement(playblastUrl);
  const original = await loadVideoElement(originalUrl);
  const duration = Math.min(
    Number.isFinite(playblast.duration) ? playblast.duration : 0,
    Number.isFinite(original.duration) ? original.duration : 0,
  );
  if (duration <= 0) fail("Could not build the comparison video.");
  const height = even(Math.max(playblast.videoHeight || 0, original.videoHeight || 0, 2));
  const leftW = even(((playblast.videoWidth || 1) / Math.max(playblast.videoHeight || 1, 1)) * height);
  const rightW = even(((original.videoWidth || 1) / Math.max(original.videoHeight || 1, 1)) * height);
  const canvas = document.createElement("canvas");
  canvas.width = leftW + rightW;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) fail("Could not build the comparison video.");
  await playFromStart(playblast);
  await playFromStart(original);
  const bitrate = Math.max(800_000, Math.floor((6_000_000 * 8) / Math.max(duration, 1)));
  try {
    return await recordRealtime(
      canvas,
      duration,
      () => {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(playblast, 0, 0, leftW, height);
        ctx.drawImage(original, leftW, 0, rightW, height);
        return !playblast.ended && playblast.currentTime < duration;
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
