import { parseSubjectChoice, SUBJECT_FRAME_CAP } from "@/lib/subject-pipeline";
import { loadVideoElement, seekTo } from "@/lib/video-client";

export const SCENE_SAMPLE_LONG_SIDE = 512;

export type SceneModel = {
  positions: Float32Array;
  indices: Uint32Array;
  sourceFaces: number;
  reducedFaces: number;
  time: number;
  subject: string;
};

type SubjectPayload = {
  mock?: boolean;
  step?: string;
  jobId?: string;
  frame?: number;
  subject?: string;
  time?: number;
  sourceFaces?: number;
  reducedFaces?: number;
  positions?: number[];
  indices?: number[];
  error?: { message?: string };
};

type JobPayload = {
  status?: string;
  error?: { message?: string } | null;
  outputs?: { id: string; name: string; sig?: string }[];
};

/**
 * Sample up to 12 frames across the accepted clip. The model, not this
 * function, decides which frame is the subject.
 */
export async function sampleSceneFrames(file: File, duration: number): Promise<{ frames: Blob[]; times: number[] }> {
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not read that video.");
    const sampleCount = Math.min(SUBJECT_FRAME_CAP, Math.max(4, Math.round(limit * 2)));
    const frames: Blob[] = [];
    const times: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(((index + 0.5) / sampleCount) * limit, Math.max(limit - 0.001, 0));
      await seekTo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not read that video."))), "image/jpeg", 0.72);
      });
      frames.push(blob);
      times.push(time);
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    return { frames, times };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asModel(payload: SubjectPayload, fallbackTime: number): SceneModel {
  if (!payload.positions || !payload.indices || !payload.subject) {
    throw new Error("Could not build a 3D subject from that clip.");
  }
  return {
    positions: new Float32Array(payload.positions),
    indices: new Uint32Array(payload.indices),
    sourceFaces: payload.sourceFaces ?? 0,
    reducedFaces: payload.reducedFaces ?? 0,
    time: payload.time ?? fallbackTime,
    subject: payload.subject,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function pollJob(jobId: string): Promise<JobPayload> {
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = await readJson<JobPayload>(response);
    if (!response.ok) throw new Error(payload.error?.message || "Could not build a 3D subject from that clip.");
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "canceled" || payload.status === "expired") {
      throw new Error(payload.error?.message || "Could not build a 3D subject from that clip.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("The 3D subject is taking too long.");
}

async function postFrames(step: "pick" | "mesh", frames: Blob[], times: number[]): Promise<SubjectPayload> {
  const form = new FormData();
  form.set("step", step);
  form.set("times", times.join(","));
  frames.forEach((frame, index) => form.append("frame", frame, `frame_${index + 1}.jpg`));
  const response = await fetch("/api/reverse-3d/subject", { method: "POST", body: form });
  const payload = await readJson<SubjectPayload>(response);
  if (!response.ok) throw new Error(payload.error?.message || "Could not build a 3D subject from that clip.");
  return payload;
}

/**
 * Ask the subject workflow which frame to keep, then load the reduced mesh.
 * A mock server returns the mesh inline and does not call Comfy.
 */
export async function requestSubjectModel(frames: Blob[], times: number[]): Promise<SceneModel> {
  const picked = await postFrames("pick", frames, times);
  if (picked.positions) return asModel(picked, times[picked.frame ?? 0] ?? 0);
  if (!picked.jobId) throw new Error("Could not build a 3D subject from that clip.");
  const choiceJob = await pollJob(picked.jobId);
  const textOutput = choiceJob.outputs?.[0];
  if (!textOutput?.sig) throw new Error("The model did not choose a frame.");
  const textResponse = await fetch(`/api/outputs/${textOutput.id}?sig=${textOutput.sig}`);
  if (!textResponse.ok) throw new Error("The model did not choose a frame.");
  const choice = parseSubjectChoice(await textResponse.text(), frames.length);
  const meshJob = await postFrames("mesh", [frames[choice.frame]], [times[choice.frame] ?? 0]);
  if (meshJob.positions) {
    return asModel({ ...meshJob, subject: choice.subject, time: times[choice.frame] ?? 0 }, times[choice.frame] ?? 0);
  }
  if (!meshJob.jobId) throw new Error("Could not build a 3D subject from that clip.");
  const done = await pollJob(meshJob.jobId);
  const output = done.outputs?.find((item) => /\.glb$/i.test(item.name)) ?? done.outputs?.[0];
  if (!output?.sig) throw new Error("Could not build a 3D subject from that clip.");
  const reducedResponse = await fetch(`/api/reverse-3d/subject?output=${encodeURIComponent(output.id)}&sig=${output.sig}`);
  const reduced = await readJson<SubjectPayload>(reducedResponse);
  if (!reducedResponse.ok) throw new Error(reduced.error?.message || "Could not build a 3D subject from that clip.");
  return asModel({ ...reduced, subject: choice.subject, time: times[choice.frame] ?? 0 }, times[choice.frame] ?? 0);
}
