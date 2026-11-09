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

export const PLAYBLAST_FPS = 16;
export const PLAYBLAST_MAX_SECONDS = 10;
/** Longer side of the playblast. VACE's 14B model renders 10 s at this size in about two minutes. */
export const PLAYBLAST_LONG_SIDE = 832;
const PLAYBLAST_MIN_SHORT_SIDE = 256;
/** Wan works on 16-pixel blocks. */
const BLOCK = 16;
/** Wan's video length is 4n + 1 frames. */
const MIN_FRAMES = 17;
const MAX_FRAMES = PLAYBLAST_FPS * PLAYBLAST_MAX_SECONDS + 1;

export type PlayblastShape = { width: number; height: number; frames: number };

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

/** Frames for the first `seconds` of the clip at 16 fps, as 4n + 1: 161 for 10 seconds, 49 for 3. */
export function playblastFrameCount(seconds: number | null): number {
  const length = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, PLAYBLAST_MAX_SECONDS) : PLAYBLAST_MAX_SECONDS;
  const frames = Math.floor(Math.round(length * PLAYBLAST_FPS) / 4) * 4 + 1;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, frames));
}

function node(workflow: Workflow, id: string, classType: string) {
  const found = workflow[id];
  if (!found || found.class_type !== classType) {
    throw new AppError(500, "internal", `Reverse 3D is missing its ${classType} node.`);
  }
  return found;
}

/** Sizes every frame, the depth pass, the still and VACE to the clip, and samples it at 16 fps. */
export function applyPlayblastShape(
  workflow: Workflow,
  srcWidth: number,
  srcHeight: number,
  seconds: number | null,
): PlayblastShape {
  const { width, height } = fitPlayblastFrame(srcWidth, srcHeight);
  const frames = playblastFrameCount(seconds);
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
  return { width, height, frames };
}

/** No still came with the run: VACE renders from the depth pass and the prompt alone. */
export function dropLookReference(workflow: Workflow): void {
  const vace = node(workflow, VACE_NODE, "WanVaceToVideo");
  delete workflow[LOOK_NODE];
  delete workflow[LOOK_GREY_NODE];
  delete workflow[LOOK_FIT_NODE];
  delete vace.inputs.reference_image;
}
