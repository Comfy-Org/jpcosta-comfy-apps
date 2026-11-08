import { measureElements, pickBusiestIndex } from "@/lib/scene-mesh";
import { loadVideoElement, seekTo } from "@/lib/video-client";

export const SCENE_SAMPLE_LONG_SIDE = 96;
export const SCENE_FRAME_SAMPLES = 12;

export type ScenePick = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  time: number;
  elements: number;
};

/**
 * Sample the accepted clip and keep the frame with the most separate regions.
 * `duration` is the already-capped length from the upload prep.
 */
export async function pickSceneFrame(file: File, duration: number): Promise<ScenePick> {
  if (!(duration > 0)) throw new Error("Could not read that video.");
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const playable = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const limit = Math.min(duration, playable);
    const long = Math.max(video.videoWidth, video.videoHeight);
    const scale = SCENE_SAMPLE_LONG_SIDE / long;
    const width = Math.max(8, Math.round(video.videoWidth * scale));
    const height = Math.max(8, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not read that video.");

    const sampleCount = Math.min(SCENE_FRAME_SAMPLES, Math.max(4, Math.round(limit * 2)));
    const frames: ScenePick[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(((index + 0.5) / sampleCount) * limit, Math.max(limit - 0.001, 0));
      await seekTo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      const measured = measureElements(image.data, width, height);
      frames.push({
        pixels: new Uint8ClampedArray(image.data),
        width,
        height,
        time,
        elements: measured.elementCount,
      });
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    const picked = frames[pickBusiestIndex(frames.map((frame) => frame.elements))];
    if (!picked) throw new Error("Could not read that video.");
    return picked;
  } finally {
    URL.revokeObjectURL(url);
  }
}
