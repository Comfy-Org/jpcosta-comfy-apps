# Workflow node / input map

Both graphs are Comfy **API format** (numeric node ids, `class_type`, `inputs`). Submit as `workflow` to `POST {COMFY_BASE_URL}/api/v2/jobs` with `Authorization: Bearer` and `Idempotency-Key`. Default base is `https://cloud.comfy.org`; a Comfy Build serverless deployment uses `https://dep-xxxx.run.comfy.app`. Inputs are Cloud v2 assets: `POST /api/v2/assets` returns `{id,file_path}` and that `file_path` is written into `LoadVideo` / `LoadImage`. Partner nodes (FLUX 3) need `extra_data.api_key_comfy_org` set to the same `COMFY_API_KEY`.

The Next.js server patches the nodes in this table before submit. Do not rename these ids without updating `lib/workflow.ts`.

## Shared inputs

| Role | How the app sets it |
| --- | --- |
| Source video | `LoadVideo` node `1` → `inputs.file` = uploaded filename |
| SKU photo 1 | `LoadImage` node `6` → `inputs.image` = uploaded filename |
| Extra SKU photos (2–5) | App inserts `LoadImage` nodes `sku_2`…`sku_5` and wires `Flux3ImageNode` `images.image_3`…`images.image_6` |
| Mask object | CLIPTextEncode node `10` → `inputs.text` |
| Swap prompt | CLIPTextEncode positive + Flux3 `prompt` |
| Seed | `KSampler` + `Flux3ImageNode` |

## `product-swap-ltx.json` — LTX-2.3 is the core video model

Contest bonus path: LTX-2.3 distilled (open weights) + in-outpainting IC-LoRA. FLUX 3 is a keyframe editor, not the video model.

| ID | class_type | Inputs the app patches | Notes |
| --- | --- | --- | --- |
| 1 | `LoadVideo` | `file` | Source clip |
| 2 | `Video Slice` | `duration` | Default 2.5s |
| 3 | `GetVideoComponents` | | Frames + fps |
| 4 | `ImageScale` | `width`, `height` | Default 768×512 |
| 5 | `ImageFromBatch` | | First frame for FLUX 3 |
| 6 | `LoadImage` | `image` | SKU photo 1 |
| 7 | `ImageScale` | | SKU to ≥256px |
| 8 | `Flux3ImageNode` | `prompt`, `seed`, `images.image_*` | Partner node. `image 1` = first frame, `image 2+` = SKUs |
| 9 | `CheckpointLoaderSimple` | | `sam3.1_multiplex_fp16.safetensors` |
| 10 | `CLIPTextEncode` | `text` | Mask object (SAM3 conditioning) |
| 11 | `SAM3_Detect` | `threshold` | Per-frame product masks |
| 12 | `GrowMask` | `expand` | Default 16px |
| 13 | `LTXVInpaintPreprocess` | | Paints mask as IC-LoRA green `#66FF00` |
| 14 | `CheckpointLoaderSimple` | | `ltx-2.3-22b-distilled-fp8.safetensors` |
| 15 | `LoraLoaderModelOnly` | | `ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors` |
| 16 | `GetICLoRAParameters` | | From the IC-LoRA model |
| 17 | `LTXAVTextEncoderLoader` | | Gemma 3 12B fp4 + LTX-2.3 distilled |
| 18 | `LoraLoader` | | Gemma abliterated, `strength_model=0` |
| 19 | `CLIPTextEncode` | `text` | Positive |
| 20 | `CLIPTextEncode` | `text` | Negative |
| 21 | `LTXVConditioning` | `frame_rate` | Default 24 |
| 22 | `EmptyLTXVLatentVideo` | `width`, `height`, `length` | `length` must be `8n+1` (default 25) |
| 23 | `LTXVImgToVideoInplace` | | Pins FLUX 3 keyframe |
| 24 | `LTXVAddGuide` | `strength` | Green-screen clip as IC-LoRA guide |
| 25 | `KSampler` | `seed`, `steps` | Distilled: 8 steps, cfg 1, `euler_ancestral` / `linear_quadratic` |
| 26 | `LTXVCropGuides` | | Strip guide tokens |
| 27 | `VAEDecodeTiled` | | Video VAE from node 14 |
| 28 | `CreateVideo` | `fps` | H.264 |
| 29 | `SaveVideo` | | Output clip |
| 30 | `SaveImage` | | Keyframe still |

## `product-swap-wan-vace.json` — open-weights video inpaint

No LTX. Wan 2.1 VACE 14B (open weights) + CausVid LoRA (6 steps). FLUX 3 still supplies the product keyframe.

**Inpaint control (important):** `control_video` is the source clip with the masked product region filled with neutral grey (0.5) — node `41` composites node `40` (`EmptyImage`, color `0x808080`) through the SAM mask. If you feed the raw frames as `control_video`, VACE copies the original product (the red can) back and ignores the reference. The mask also goes to `control_masks`, and the FLUX 3 keyframe is the `reference_image`.

| ID | class_type | Inputs the app patches | Notes |
| --- | --- | --- | --- |
| 1 | `LoadVideo` | `file` | Source clip |
| 2 | `Video Slice` | `duration` | Default 3s |
| 3 | `GetVideoComponents` | | |
| 4 | `ImageScale` | `width`, `height` | Default 480×480 (VACE-1.3B / 14B 480p) |
| 5 | `ImageFromBatch` | | First frame |
| 6 | `LoadImage` | `image` | SKU photo 1 |
| 7 | `ImageScale` | | |
| 8 | `Flux3ImageNode` | `prompt`, `seed`, `images.image_*` | Partner node |
| 9 | `CheckpointLoaderSimple` | | SAM 3.1 |
| 10 | `CLIPTextEncode` | `text` | Mask object |
| 11 | `SAM3_Detect` | | |
| 12 | `GrowMask` | `expand` | Default 40 (room for a taller SKU than the source product) |
| 13 | `UNETLoader` | | `wan2.1_vace_14B_fp16.safetensors` |
| 14 | `LoraLoaderModelOnly` | | `Wan21_CausVid_14B_T2V_lora_rank32.safetensors` @ 0.5 |
| 15 | `ModelSamplingSD3` | | `shift=5` |
| 16 | `CLIPLoader` | | `umt5_xxl_fp8_e4m3fn_scaled`, type `wan` |
| 17 | `VAELoader` | | `wan_2.1_vae.safetensors` |
| 18 | `CLIPTextEncode` | `text` | Positive |
| 19 | `CLIPTextEncode` | `text` | Negative |
| 20 | `WanVaceToVideo` | `width`, `height`, `length`, `strength` | `control_video` = node 41 (greyed), `control_masks` = node 12, `reference_image` = node 8; strength 1.0 |
| 21 | `KSampler` | `seed`, `steps` | Turbo: 6 steps, cfg 1, `uni_pc` / `simple` |
| 22 | `TrimVideoLatent` | | `trim_amount` from VACE output 3 |
| 23 | `VAEDecode` | | |
| 24 | `ImageCompositeMasked` | | Blend inpaint onto original |
| 25 | `CreateVideo` | `fps` | Default 16 |
| 26 | `SaveVideo` | | Output clip |
| 27 | `SaveImage` | | Keyframe still |
| 40 | `EmptyImage` | `width`, `height` | Neutral grey 0.5; must match node 4's size |
| 41 | `ImageCompositeMasked` | | Greys out the masked region of the frames → VACE `control_video` |

## Open-weights-only variant

Drop node `8` (`Flux3ImageNode`) and point `WanVaceToVideo.reference_image` / `LTXVImgToVideoInplace.image` at node `7` (the SKU photo). Everything else is open weights already on the Comfy Build image / Cloud: SAM 3.1, Wan 2.1 VACE, LTX-2.3, IC-LoRA.
