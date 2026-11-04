# Workflow node / input map

All graphs under this folder are **API format** (`{ "nodeId": { "class_type", "inputs" } }`), the payload `POST {COMFY_BASE_URL}/api/v2/jobs` expects inside `workflow` (`COMFY_BASE_URL` defaults to `https://cloud.comfy.org`). Partner nodes also need:

```json
"extra_data": { "api_key_comfy_org": "<COMFY_API_KEY>" }
```

DynamicCombo values on Comfy Cloud’s API format use **dotted keys**: `"model": "LTX-2.5 (Fast)"` plus `"model.duration"`, `"model.resolution"`, `"model.fps"`, `"model.generate_audio"`. Autogrow slots also use **flat dotted keys**: `"images.image_1": ["10", 0]`, `"images.image_2": ["11", 0]`. Under a DynamicCombo the prefix stacks: `"model.reference_images.image_1"` (MiniMax H3). Do not nest them as `"images": { "image_1": … }`; Comfy Cloud silently drops the nested object, so `Flux3ImageNode` runs text-only and invents a product instead of using the reference.

Cutout and RIFE use **core** nodes only (no WAS, no Frame-Interpolation pack, no VideoHelperSuite). Models live in the Comfy Build spec [`build/comfy-build.yaml`](../build/comfy-build.yaml): `birefnet.safetensors` under `models/background_removal`, `rife_v4.26.safetensors` under `models/frame_interpolation`.

**JoinImageWithAlpha polarity:** ComfyUI `JoinImageWithAlpha.execute` sets the PNG alpha channel to `1.0 - mask` (`comfy_extras/nodes_compositing.py`). `RemoveBackground` emits a **foreground** mask (subject = 1). Feeding that mask straight in would make the product transparent. `InvertMask` runs first so subject becomes 0, then `1 - 0 = 1` (opaque product) and background `1 - 1 = 0` (transparent).

| File | Cloud nodes | Patch these inputs | Output node |
| --- | --- | --- | --- |
| `flux3_t2i.json` | `Flux3ImageNode` → `SaveImage` | `1.prompt`, `1.aspect_ratio`, `1.resolution`, `1.seed` | `2` |
| `flux3_image_edit.json` | `LoadImage` ×2 → `Flux3ImageNode` → `SaveImage` | `10.image`, `11.image`, `1.prompt`, `1.seed` | `2` |
| `qwen_image_edit_2511.json` | `UNETLoader` `qwen_image_edit_2511_fp8mixed` + Lightning LoRA + `TextEncodeQwenImageEditPlus` + `KSampler` denoise 0.35 | `10.image`, `31.prompt`, `40.denoise`, `40.seed` | `51` |
| `product_cutout.json` | `LoadBackgroundRemovalModel` `birefnet.safetensors` → `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha` → `SaveImage` | `1.image` | `6` |
| `ltx25_flf2v.json` | `LtxApi25ImageToVideo` (Fast, 720×1280, 3s, audio on) → `SaveVideo` | `10.image`, `11.image`, `20.prompt`, `20.seed`, `20.model.duration` | `30` |
| `concat_rife.json` | `LoadVideo` ×4 → `ConcatenateVideo` (`videos.video0`–`video3`, 0-indexed autogrow) → `GetVideoComponents` → `FrameInterpolationModelLoader` `rife_v4.26.safetensors` → `FrameInterpolate` ×2 → `CreateVideo` 48 fps + audio → `SaveVideo` | `10–13.file` | `70` |
| `minimax_h3_r2v.json` | `MinimaxHailuo03ReferenceNode` H3 Max 768P 6s → `SaveVideo` | `10–12.image`, `20.model.prompt`, `20.seed` | `30` |

The Next.js orchestrator (`src/lib/pipeline.ts`) loads these files, patches the inputs above, uploads stills and clips with `POST /api/v2/assets` (LoadImage / LoadVideo get the returned `file_path`), submits `POST /api/v2/jobs` with an `Idempotency-Key`, polls `GET /api/v2/jobs/:id`, then downloads via `GET /api/v2/assets/:id` → signed `url` (fetch the signed URL without the API key). Auth is `Authorization: Bearer`.
