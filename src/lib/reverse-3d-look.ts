import { AppError } from "@/lib/http";
import type { Workflow } from "@/lib/workflow";

/**
 * The open-source playblast (workflows/reverse-3d/workflow_api.json): Wan 2.1 VACE follows a depth pass of every
 * frame and copies its look from the grey still. The run route fits the graph to each clip here.
 */

/** LoadImage for the grey still VACE copies its look from. */
export const LOOK_NODE = "30";
/** The still with its colour taken out. */
export const LOOK_GREY_NODE = "31";
/** The still scaled to the video size. */
export const LOOK_FIT_NODE = "32";
/** VideoFrameSample: picks the frames that make 16 fps. */
export const SAMPLE_NODE = "12";
/** ImageScale for every frame. */
export const FRAME_FIT_NODE = "17";
/** DepthAnythingV2Preprocessor. */
export const DEPTH_NODE = "40";
/** WanVaceToVideo. */
export const VACE_NODE = "49";

/** Video Slice: the first seconds of the clip. */
export const SLICE_NODE = "11";
/** KSampler, TrimVideoLatent and VAEDecode after VACE. */
const SAMPLER_NODE = "3";
const TRIM_NODE = "58";
const DECODE_NODE = "8";
/** ImageDesaturate+ on the decoded playblast. */
const PLAYBLAST_GREY_NODE = "33";

export const PLAYBLAST_FPS = 16;
/** One VACE pass, and the cap for a free video (an email). */
export const PLAYBLAST_MAX_SECONDS = 10;
/** The cap with the visitor's own key: VACE renders it 10 seconds at a time in one job. */
export const PLAYBLAST_KEY_MAX_SECONDS = 60;
/** Frames in one VACE pass: 10 seconds at 16 fps, as 4n + 1. */
export const PLAYBLAST_CHUNK_FRAMES = PLAYBLAST_FPS * PLAYBLAST_MAX_SECONDS + 1;
/** Longer side of the playblast. VACE's 14B model renders 10 s at this size in about two minutes. */
export const PLAYBLAST_LONG_SIDE = 832;
const PLAYBLAST_MIN_SHORT_SIDE = 256;
/** Wan works on 16-pixel blocks. */
const BLOCK = 16;
/** Wan's video length is 4n + 1 frames. */
const MIN_FRAMES = 17;

export type PlayblastShape = { width: number; height: number; frames: number; seconds: number; chunks: number };

function toBlock(value: number): number {
  return Math.max(BLOCK, Math.round(value / BLOCK) * BLOCK);
}

/** The frame size VACE renders: the clip's shape with its longer side at 832, both sides on 16-pixel blocks. */
export function fitPlayblastFrame(srcWidth: number, srcHeight: number): { width: number; height: number } {
  const w = Number.isFinite(srcWidth) && srcWidth > 0 ? srcWidth : 16;
  const h = Number.isFinite(srcHeight) && srcHeight > 0 ? srcHeight : 9;
  const scale = PLAYBLAST_LONG_SIDE / Math.max(w, h);
  return {
    width: Math.max(PLAYBLAST_MIN_SHORT_SIDE, toBlock(w * scale)),
    height: Math.max(PLAYBLAST_MIN_SHORT_SIDE, toBlock(h * scale)),
  };
}

/** The seconds the playblast covers: the clip's length up to the cap, 10 when the length is unknown. */
export function playblastSeconds(seconds: number | null, maxSeconds = PLAYBLAST_MAX_SECONDS): number {
  const cap = Math.max(1, maxSeconds);
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return Math.min(PLAYBLAST_MAX_SECONDS, cap);
  return Math.min(seconds, cap);
}

/**
 * Frames for the first `seconds` of the clip at 16 fps. Up to 10 seconds it is one VACE pass, as 4n + 1:
 * 161 for 10 seconds, 49 for 3. Longer clips (own key) keep every frame and are rendered in passes of 161.
 */
export function playblastFrameCount(seconds: number | null, maxSeconds = PLAYBLAST_MAX_SECONDS): number {
  const raw = Math.round(playblastSeconds(seconds, maxSeconds) * PLAYBLAST_FPS);
  if (raw > PLAYBLAST_CHUNK_FRAMES) return raw;
  const frames = Math.floor(raw / 4) * 4 + 1;
  return Math.min(PLAYBLAST_CHUNK_FRAMES, Math.max(MIN_FRAMES, frames));
}

/** VACE length for a pass of `count` frames: the next 4n + 1, at least 17. */
function passLength(count: number): number {
  return Math.max(MIN_FRAMES, Math.ceil((count - 1) / 4) * 4 + 1);
}

function node(workflow: Workflow, id: string, classType: string) {
  const found = workflow[id];
  if (!found || found.class_type !== classType) {
    throw new AppError(500, "internal", `Reverse 3D is missing its ${classType} node.`);
  }
  return found;
}

/**
 * Sizes every frame, the depth pass, the still and VACE to the clip, and samples it at 16 fps.
 * `maxSeconds` is 10 for a free video and 60 with the visitor's own key; past 10 seconds VACE runs in passes.
 */
export function applyPlayblastShape(
  workflow: Workflow,
  srcWidth: number,
  srcHeight: number,
  seconds: number | null,
  maxSeconds = PLAYBLAST_MAX_SECONDS,
): PlayblastShape {
  const { width, height } = fitPlayblastFrame(srcWidth, srcHeight);
  const length = playblastSeconds(seconds, maxSeconds);
  const frames = playblastFrameCount(seconds, maxSeconds);
  node(workflow, SLICE_NODE, "Video Slice").inputs.duration = Math.ceil(length * 1000) / 1000;
  node(workflow, SAMPLE_NODE, "VideoFrameSample").inputs.num_frames = frames;
  const fit = node(workflow, FRAME_FIT_NODE, "ImageScale");
  fit.inputs.width = width;
  fit.inputs.height = height;
  node(workflow, DEPTH_NODE, "DepthAnythingV2Preprocessor").inputs.resolution = Math.min(width, height);
  const vace = node(workflow, VACE_NODE, "WanVaceToVideo");
  vace.inputs.width = width;
  vace.inputs.height = height;
  vace.inputs.length = frames;
  const look = workflow[LOOK_FIT_NODE];
  if (look) {
    look.inputs.width = width;
    look.inputs.height = height;
  }
  const chunks = frames > PLAYBLAST_CHUNK_FRAMES ? splitPlayblastPasses(workflow, frames) : 1;
  return { width, height, frames, seconds: length, chunks };
}

/** First id of pass `index`'s nodes. Seven ids each, clear of the graph's own. */
function passId(index: number, offset: number): string {
  return String(1000 + index * 10 + offset);
}

/**
 * Renders `frames` depth frames in VACE passes of up to 161, one after the other in the same job, and joins them
 * before the colour comes out. Each pass gets the same still, prompts and seed, so the look holds across the joins.
 * Returns the pass count.
 */
export function splitPlayblastPasses(workflow: Workflow, frames: number, passFrames = PLAYBLAST_CHUNK_FRAMES): number {
  const vace = node(workflow, VACE_NODE, "WanVaceToVideo");
  const sampler = node(workflow, SAMPLER_NODE, "KSampler");
  const trim = node(workflow, TRIM_NODE, "TrimVideoLatent");
  const decode = node(workflow, DECODE_NODE, "VAEDecode");
  const grey = node(workflow, PLAYBLAST_GREY_NODE, "ImageDesaturate+");
  const count = Math.ceil(frames / passFrames);
  let joined: [string, number] | null = null;
  for (let index = 0; index < count; index += 1) {
    const start = index * passFrames;
    const take = Math.min(passFrames, frames - start);
    const ids = [0, 1, 2, 3, 4, 5, 6].map((offset) => passId(index, offset));
    const [sliceId, vaceId, sampleId, trimId, decodeId, cutId, joinId] = ids;
    workflow[sliceId] = {
      class_type: "ImageFromBatch",
      inputs: { image: [DEPTH_NODE, 0], batch_index: start, length: take },
      _meta: { title: `Depth frames, pass ${index + 1}` },
    };
    workflow[vaceId] = {
      ...vace,
      inputs: { ...vace.inputs, length: passLength(take), control_video: [sliceId, 0] },
      _meta: { title: `VACE, pass ${index + 1}` },
    };
    workflow[sampleId] = {
      ...sampler,
      inputs: { ...sampler.inputs, positive: [vaceId, 0], negative: [vaceId, 1], latent_image: [vaceId, 2] },
      _meta: { title: `Sample, pass ${index + 1}` },
    };
    workflow[trimId] = {
      ...trim,
      inputs: { ...trim.inputs, samples: [sampleId, 0], trim_amount: [vaceId, 3] },
      _meta: { title: `Drop the reference frame, pass ${index + 1}` },
    };
    workflow[decodeId] = { ...decode, inputs: { ...decode.inputs, samples: [trimId, 0] }, _meta: { title: `Decode, pass ${index + 1}` } };
    let out: [string, number] = [decodeId, 0];
    if (passLength(take) !== take) {
      // The last pass is padded up to 4n + 1 frames: keep only the frames that came from the clip.
      workflow[cutId] = {
        class_type: "ImageFromBatch",
        inputs: { image: out, batch_index: 0, length: take },
        _meta: { title: `Clip frames of pass ${index + 1}` },
      };
      out = [cutId, 0];
    }
    if (joined) {
      workflow[joinId] = { class_type: "ImageBatch", inputs: { image1: joined, image2: out }, _meta: { title: `Join pass ${index + 1}` } };
      joined = [joinId, 0];
    } else {
      joined = out;
    }
  }
  for (const id of [VACE_NODE, SAMPLER_NODE, TRIM_NODE, DECODE_NODE]) delete workflow[id];
  grey.inputs.image = joined;
  return count;
}

/** No still came with the run: VACE renders from the depth pass and the prompt alone (every pass, when there are several). */
export function dropLookReference(workflow: Workflow): void {
  const passes = Object.values(workflow).filter((item) => item.class_type === "WanVaceToVideo");
  if (passes.length === 0) throw new AppError(500, "internal", "Reverse 3D is missing its WanVaceToVideo node.");
  delete workflow[LOOK_NODE];
  delete workflow[LOOK_GREY_NODE];
  delete workflow[LOOK_FIT_NODE];
  for (const pass of passes) delete pass.inputs.reference_image;
}
