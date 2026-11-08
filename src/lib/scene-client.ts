import { layoutFrameScene, partBoxesMesh, type PartBoxes } from "@/lib/scene-mesh";
import { parseSubjectScene, selectTextOutput, SUBJECT_FRAME_CAP, type SubjectScene } from "@/lib/subject-pipeline";
import { loadVideoElement, seekTo } from "@/lib/video-client";

export const SCENE_SAMPLE_LONG_SIDE = 512;
/** The frame shown behind the blocks is grabbed again at this size, so it stays sharp on a big screen. */
export const SCENE_PLATE_LONG_SIDE = 1280;

export type SceneModel = {
  /** The shot as named blocks, placed for the loading build. */
  parts: PartBoxes;
  /** The same blocks as one mesh, for the orbit view. */
  positions: Float32Array;
  indices: Uint32Array;
  sourceFaces: number;
  reducedFaces: number;
  time: number;
  /** Index of the chosen frame in the sampled frames. */
  frame: number;
  subject: string;
  /** The chosen frame, shown behind the blocks. Added once it has been grabbed. */
  plate?: Blob | null;
  /** Set only when the server returned the sample block figure. Not a model result. */
  mock?: boolean;
};

type SubjectPayload = {
  mock?: boolean;
  step?: string;
  jobId?: string;
  frame?: number;
  subject?: string;
  time?: number;
  /** Mock mode only: the sample reply, read exactly like a model's. */
  reply?: string;
  error?: { code?: string; message?: string } | string;
};

type JobPayload = {
  status?: string;
  error?: { message?: string } | null;
  outputs?: { id: string; name: string; sig?: string; type?: string; contentType?: string }[];
};

/**
 * Encode the canvas right away. `toBlob` waits for a free main-thread task, and while the
 * loading build animates that took about a second per frame, so it held the 3D toy back.
 */
function jpegFrame(canvas: HTMLCanvasElement): Blob {
  const url = canvas.toDataURL("image/jpeg", 0.72);
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/jpeg") || comma < 0) throw new Error("Could not read that video.");
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

/**
 * Sample up to 12 frames across the accepted clip. The model, not this
 * function, decides which frame is the subject.
 */
export async function sampleSceneFrames(file: File, duration: number): Promise<{ frames: Blob[]; times: number[]; aspect: number }> {
  if (!(duration > 0)) throw new Error("Could not read that video.");
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const playable = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const limit = Math.min(duration, playable);
    const long = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, SCENE_SAMPLE_LONG_SIDE / long);
    const width = Math.max(8, Math.round(video.videoWidth * scale));
    const height = Math.max(8, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not read that video.");
    const sampleCount = Math.min(SUBJECT_FRAME_CAP, Math.max(4, Math.round(limit * 2)));
    const frames: Blob[] = [];
    const times: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(((index + 0.5) / sampleCount) * limit, Math.max(limit - 0.001, 0));
      await seekTo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      frames.push(jpegFrame(canvas));
      times.push(time);
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    return { frames, times, aspect: video.videoWidth / video.videoHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One frame of the clip as a JPEG, for the backdrop behind the blocks. */
export async function grabFrame(file: File, time: number, longSide = SCENE_PLATE_LONG_SIDE): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const scale = Math.min(1, longSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(8, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not read that video.");
    await seekTo(video, Math.max(0, time));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.removeAttribute("src");
    video.load();
    return jpegFrame(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asModel(scene: SubjectScene, aspect: number, times: number[], mock = false): SceneModel {
  const parts = layoutFrameScene(scene, aspect);
  const mesh = partBoxesMesh(parts);
  const faces = mesh.indices.length / 3;
  return {
    parts,
    ...mesh,
    sourceFaces: faces,
    reducedFaces: faces,
    time: times[scene.frame] ?? 0,
    frame: scene.frame,
    subject: scene.subject,
    mock,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function pollJob(jobId: string): Promise<JobPayload> {
  const started = Date.now();
  while (Date.now() - started < 3 * 60 * 1000) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = await readJson<JobPayload>(response);
    if (!response.ok) throw new Error(payload.error?.message || "Could not build a 3D blockout from that clip.");
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "canceled" || payload.status === "expired") {
      throw new Error(payload.error?.message || "Could not build a 3D blockout from that clip.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The 3D blockout is taking too long.");
}

function errorMessage(payload: SubjectPayload, fallback: string): string {
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (payload.error && typeof payload.error === "object" && payload.error.message) return payload.error.message;
  return fallback;
}

const COLD_START = new Set(["deployment_not_ready", "timeout"]);

async function postSubject(form: FormData, onStatus?: (message: string) => void): Promise<SubjectPayload> {
  const started = Date.now();
  for (;;) {
    const response = await fetch("/api/reverse-3d/subject", { method: "POST", body: form });
    const payload = await readJson<SubjectPayload>(response);
    const code = payload.error && typeof payload.error === "object" ? payload.error.code : undefined;
    if (!response.ok && code && COLD_START.has(code) && Date.now() - started < 3 * 60 * 1000) {
      onStatus?.("The GPU worker is cold-starting. Waiting for it…");
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      continue;
    }
    if (!response.ok) throw new Error(errorMessage(payload, "Could not build a 3D blockout from that clip."));
    return payload;
  }
}

async function postFrames(frames: Blob[], times: number[], onStatus?: (message: string) => void): Promise<SubjectPayload> {
  const form = new FormData();
  form.set("step", "pick");
  form.set("times", times.join(","));
  frames.forEach((frame, index) => form.append("frame", frame, `frame_${index + 1}.jpg`));
  return postSubject(form, onStatus);
}

/**
 * One Gemini job looks at the frames, picks the subject and marks its parts on the chosen frame.
 * No image-to-3D model runs, so the toy is ready in seconds, well before the video.
 * `onQueued` fires once the job is on the deployment, so the video job can queue behind it.
 * A mock server returns a sample reply on the first response and does not call Comfy.
 */
export async function requestSubjectModel(
  frames: Blob[],
  times: number[],
  aspect: number,
  onStatus?: (message: string) => void,
  onQueued?: () => void,
): Promise<SceneModel> {
  onStatus?.("Marking the subject on the frame…");
  const picked = await postFrames(frames, times, onStatus);
  onQueued?.();
  if (typeof picked.reply === "string") return asModel(parseSubjectScene(picked.reply, frames.length), aspect, times, picked.mock === true);
  if (!picked.jobId) throw new Error("Could not build a 3D blockout from that clip.");
  const job = await pollJob(picked.jobId);
  const textOutput = selectTextOutput(job.outputs ?? []);
  if (!textOutput?.sig) throw new Error("The model did not mark any parts.");
  const textResponse = await fetch(`/api/outputs/${textOutput.id}?sig=${textOutput.sig}`);
  if (!textResponse.ok) throw new Error("The model did not mark any parts.");
  return asModel(parseSubjectScene(await textResponse.text(), frames.length), aspect, times);
}
