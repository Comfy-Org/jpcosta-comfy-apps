import type { BoxPreset } from "./types";

export const BOX_PRESETS: BoxPreset[] = [
  {
    id: "kraft_mailer",
    name: "Kraft mailer",
    blurb: "Unbranded brown fiber mailer, gummed kraft tape. The default e-comm unbox.",
    innerMm: { w: 140, h: 90, d: 50 },
    lidOn: "/presets/kraft_mailer/lid_on.png",
    empty: "/presets/kraft_mailer/empty.png",
    mask: "/presets/kraft_mailer/insert_mask.png",
    insert: { x: 0.2761, y: 0.5397, w: 0.4693, h: 0.272 },
  },
  {
    id: "rigid_luxury",
    name: "Rigid luxury",
    blurb: "Matte ivory set-up box, champagne insert. No foil, no monogram.",
    innerMm: { w: 120, h: 120, d: 40 },
    lidOn: "/presets/rigid_luxury/lid_on.png",
    empty: "/presets/rigid_luxury/empty.png",
    mask: "/presets/rigid_luxury/insert_mask.png",
    insert: { x: 0.3182, y: 0.5304, w: 0.3443, h: 0.2736 },
  },
  {
    id: "tissue_wrap",
    name: "Tissue wrap",
    blurb: "Cream folding carton under plain white tissue and kraft twine.",
    innerMm: { w: 130, h: 100, d: 45 },
    lidOn: "/presets/tissue_wrap/lid_on.png",
    empty: "/presets/tissue_wrap/empty.png",
    mask: "/presets/tissue_wrap/insert_mask.png",
    insert: { x: 0.3682, y: 0.4248, w: 0.2648, h: 0.2939 },
  },
];

export function getPreset(id: string): BoxPreset {
  const found = BOX_PRESETS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Unknown box preset: ${id}`);
  }
  return found;
}
