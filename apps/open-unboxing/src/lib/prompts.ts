/** Locked-camera overhead language shared across keyframe edits and video models. */

export const OVERHEAD =
  "Locked-off static top-down overhead camera, 90 degrees, no camera movement, no tilt, no zoom, no dolly, no cut. Only hands move. Both plates are strict 90-degree overhead. Pale oak desk, even daylight.";

export const NO_BRAND =
  "No logos, no text, no barcodes, no watermarks, no faces, no torsos. Bare adult hands only when the beat requires them.";

export function nestPrompt(): string {
  return `${OVERHEAD} Using image 1 as the plate, nest the exact product from image 2 into the insert well so it looks physically present: correct contact shadows, a slight paperboard or tissue tuck, matching light. Do not change camera, crop, or the unbranded box. No hands in this frame. ${NO_BRAND}`;
}

export function liftPrompt(): string {
  return `${OVERHEAD} Using image 1 as the open box with the product nested, add two bare adult hands entering from the bottom of frame, fingers lifting the product a few centimetres out of the well. Keep the box, desk, and product identity identical. ${NO_BRAND}`;
}

export function rotatePrompt(): string {
  return `${OVERHEAD} Using image 1 as the lift beat, the same two hands now hold the product above the open box and rotate it about 40 degrees so a new facet faces the camera. Product identity locked. ${NO_BRAND}`;
}

export function tablePrompt(): string {
  return `${OVERHEAD} Using image 1 as the rotate beat, the hands set the product on the oak desk to the right of the open box. Empty well visible. Hands just releasing, or already leaving the bottom of frame. ${NO_BRAND}`;
}

export function ltxPairPrompt(fromBeat: string, toBeat: string): string {
  return `${OVERHEAD} One continuous real-time shot. The camera is locked off: no pan, tilt, zoom, or push-in. Only hands move. Motion carries the scene from "${fromBeat}" to "${toBeat}". Slow ASMR pacing, no jump cuts, no morphing logos. Audio: close-mic paper, tape, ceramic, quiet room tone. No music, no voiceover. ${NO_BRAND}`;
}

export const LTX_BEATS = [
  "sealed unbranded box, no hands",
  "lid open, product nested in the insert, no hands",
  "hands lifting the product from the well",
  "hands rotating the product above the box",
  "product resting on the desk beside the open box",
] as const;

export function h3Prompt(): string {
  return `${OVERHEAD} 9:16, one continuous shot. Image 1 is the sealed unbranded box. Image 2 is the open box with the product nested. Image 3 is the product identity — match shape, glaze, and color exactly. Sequence: sealed box, tape peel, lid opens onto the nested product, two hands lift and slowly rotate it, set it on the desk beside the open box. Native ASMR audio: kraft, tape, ceramic tap, room tone. No music, no voiceover, no logos.`;
}
