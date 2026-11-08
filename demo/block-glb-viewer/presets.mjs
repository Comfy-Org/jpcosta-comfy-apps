/** Finish choices for a future video reference. This does not call a generator. */

export const PRESETS = ["blocos-cinza", "blocos-coloridos", "clay"];

export const PRESET_LABELS = {
  "blocos-cinza": "Blocos cinza",
  "blocos-coloridos": "Blocos coloridos",
  clay: "Clay",
};

/**
 * What a later video job would receive. The original video stays the motion guide.
 * Nothing here is sent.
 */
export function buildVideoReferencePayload({ style, referencePng, videoName = "original-video" }) {
  if (!PRESETS.includes(style)) throw new Error("Estilo desconhecido.");
  const bytes = referencePng instanceof Uint8Array ? referencePng : new Uint8Array(referencePng);
  if (bytes.byteLength < 32) throw new Error("A referência está vazia.");
  return {
    called: false,
    fields: {
      style,
      camera: "source-plus-z",
      referenceImage: bytes,
      video: videoName,
    },
  };
}
