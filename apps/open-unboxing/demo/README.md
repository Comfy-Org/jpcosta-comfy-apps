# Demo output

This clip was generated on the **Comfy Build serverless endpoint** (`COMFY_BASE_URL`, Comfy Cloud API v2: Bearer auth, `/api/v2/assets`, `/api/v2/jobs`).

Release: **`69e82472-1206-473f-851e-286c5fcb2480`** (v2, core BiRefNet + core RIFE 4.26). No local ComfyUI, no local matte, no local RIFE.

Product stills in `product/` are unbranded sage ceramic pour-over shots (five angles).

Committed `unboxing.mp4` is the endpoint pipeline (regenerated 2026-10-21 after the FLUX reference fix):

1. Core BiRefNet cutout (job `e983a759-…`)
2. Magenta-well composite into the kraft mailer insert
3. FLUX 3 nested keyframe with the composite as `images.image_1` and the cutout as `images.image_2` (job `5865c944-…`) → `kf1_nested.png`
4. LTX 2.5 Fast FLF 720×1280 3s, sealed → nested (job `1353b8de-…`)
5. Core RIFE ×2 (job `7744d8a6-…`) → 720×1280, **48 fps**, 3.02s, 145 frames, H.264 + AAC stereo, 1121912 bytes

The product in the clip is the sage pour-over from `product/01_hero.png` (smooth glaze, flat saucer), on the same pale oak desk as the sealed plate.

**Correction:** the previous demo passed FLUX references as a nested `"images": {…}` object, which Comfy Cloud ignores. FLUX ran text-only, so the earlier clip showed a prompt-invented look-alike pour-over (ribbed body, dark wood desk) rather than the actual input product. Autogrow inputs must be flat keys (`"images.image_1"`); see `workflows/NODE_MAP.md`.

Keyframes: `kf0_sealed.png`, `kf1_nested.png`. Stills: `unboxing_frame.jpg` (start), `unboxing_mid.jpg` (1.5s), `unboxing_last.jpg` (end).
