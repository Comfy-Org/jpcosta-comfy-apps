import { AppError } from "@/lib/http";
import type { Workflow } from "@/lib/workflow";

/** LoadImage for the grey still Kling copies its look from (`@Image1`). */
export const LOOK_NODE = "30";
/** Kling4EditVideoNode. */
export const KLING_NODE = "20";
export const LOOK_INPUT = "model.reference_images.image_1";

/** Used only when the still could not be drawn: the same look in words, with no `@Image1`. */
export const PROMPT_WITHOUT_LOOK =
  "Restyle @Video1 as a rough Blender solid-viewport blocking playblast. " +
  "Everything is untextured matte light-grey under flat studio light with soft grey shadows and a plain pale-grey sky. " +
  "Every person stays a person, as a simple low-detail grey mannequin made of smooth primitive shapes: plain head with no face, no eyes, no nose, no mouth and no hair on every frame, simple torso, capsule limbs, rounded hands and feet, no clothing details. " +
  "Every animal stays that animal as a simple grey shape. Every bicycle, car or object stays that same object as a simplified grey stand-in, never turned into a person. " +
  "Buildings are a few large plain boxes, the ground a flat plane. No color, no textures, no text. " +
  "Keep the exact camera move, framing, people, positions, motion and timing of @Video1. Do not add or remove anyone.";

/** No still came with the run: Kling gets no reference image and a prompt that does not name one. */
export function dropLookReference(workflow: Workflow): void {
  const kling = workflow[KLING_NODE];
  if (!kling || kling.class_type !== "Kling4EditVideoNode") {
    throw new AppError(500, "internal", "Reverse 3D is missing its Kling node.");
  }
  delete workflow[LOOK_NODE];
  delete kling.inputs[LOOK_INPUT];
  kling.inputs["model.prompt"] = PROMPT_WITHOUT_LOOK;
}
