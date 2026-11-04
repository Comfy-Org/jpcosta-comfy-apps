# Open Unboxing — report

## Architecture

Open Unboxing is a Next.js 15 App Router studio. The browser never talks to Comfy. `POST /api/jobs` writes uploads under `.data/jobs/{id}/`, returns a job id, and runs the pipeline in-process. `GET /api/jobs/{id}` is the poller. `GET /api/jobs/{id}/output` streams the MP4.

```
product stills ──► BiRefNet (core) ──► scale-fit into preset well
                                          │
preset plates (lid / empty / mask) ───────┤
                                          ▼
                            FLUX 3 or Qwen 2511 blend edits
                            (sealed, nested, lift, rotate, table)
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
            LTX 2.5 Fast FLF pairs                    MiniMax H3 Max R2V
            (first-last, audio on)                    (native stereo ASMR)
                     │
                     ▼
            concat_rife.json (core ConcatenateVideo + RIFE 4.26 ×2)
```

Comfy client: `src/lib/comfy.ts` and `scripts/comfy_cloud.py`. Talks to a Comfy serverless deployment (Comfy Build spec: [`build/comfy-build.yaml`](build/comfy-build.yaml)).

- Base: `COMFY_BASE_URL` (default `https://cloud.comfy.org`)
- Auth: `COMFY_API_KEY` as `Authorization: Bearer` — single key, no other env names. Errors pass through `redact()`.
- Partner nodes: `extra_data.api_key_comfy_org` (same key)
- Upload: `POST /api/v2/assets` (multipart `content_type`, `file_path`, `tags=["input"]`, then `file`) → `{id,file_path}` used as LoadImage input
- Submit: `POST /api/v2/jobs` JSON `{workflow, extra_data}` with `Idempotency-Key`
- Poll: `GET /api/v2/jobs/:id` → `{status, outputs[{id,name,node_id,type}]}`
- Download: `GET /api/v2/assets/:id` → `{url}` signed, fetched **without** the API key

DynamicCombo (LTX `model`, MiniMax `model`) on Cloud’s API format uses **dotted keys**: `"model": "LTX-2.5 (Fast)"` plus `"model.duration"`, `"model.resolution"`, … Nested dicts either fail validation or never reach `execute()`.

## Models

| Step | Graph | Models / nodes |
| --- | --- | --- |
| Preset plates | `flux3_t2i.json` | FLUX 3 Image partner node, 1K, 3:4 |
| Cutout | `product_cutout.json` | Core `LoadBackgroundRemovalModel` `birefnet.safetensors` → `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha` |
| Blend edit | `flux3_image_edit.json` | FLUX 3, refs as `image 1` / `image 2` |
| Open-weights edit | `qwen_image_edit_2511.json` | `qwen_image_edit_2511_fp8mixed` + Lightning 4-step LoRA, denoise 0.35 |
| Animate | `ltx25_flf2v.json` | LTX 2.5 Fast, 720×1280, 3s, 24 fps, audio on; locked-off 90° overhead |
| Concat + RIFE | `concat_rife.json` | Core `ConcatenateVideo` → `GetVideoComponents` → `FrameInterpolationModelLoader` `rife_v4.26.safetensors` → `FrameInterpolate` ×2 → `CreateVideo` 48 fps + audio |
| Alt video | `minimax_h3_r2v.json` | MiniMax H3 Max, 768P, native audio |

Node/input map: [`workflows/NODE_MAP.md`](workflows/NODE_MAP.md).

## How to run

```bash
cp .env.example .env.local   # set COMFY_API_KEY (and COMFY_BASE_URL for your own endpoint)
npm install
npm run dev                  # http://localhost:3000
```

```bash
npm run typecheck
npm run build
npm start
```

The generate request is long-running. Keep the Node process alive. Do not deploy this as a 10s serverless function.

## Sample output

Release **`69e82472-1206-473f-851e-286c5fcb2480`** (Comfy Build v2, core BiRefNet + core RIFE 4.26). Every model step ran on the endpoint. No local ComfyUI, no local matte, no local interpolation.

| Path | What |
| --- | --- |
| [`demo/unboxing.mp4`](demo/unboxing.mp4) | LTX 2.5 Fast FLF + core RIFE ×2, 720×1280, 48 fps, 3.02s, 145 frames, H.264 + AAC stereo, 1222043 bytes |
| [`demo/unboxing_frame.jpg`](demo/unboxing_frame.jpg) | Start (~0.08s): true 90° overhead, sealed kraft, tape, fingertips entering |
| [`demo/unboxing_mid.jpg`](demo/unboxing_mid.jpg) | Mid (~1.5s): still 90° overhead, hands opening the lid, nested pour-over |
| [`demo/unboxing_last.jpg`](demo/unboxing_last.jpg) | End (~2.85s): overhead matching the nested keyframe (small lid-flap perspective in the still) |
| [`demo/kf0_sealed.png`](demo/kf0_sealed.png) | Preset lid plate (true 90°) |
| [`demo/kf1_nested.png`](demo/kf1_nested.png) | FLUX 3 nested keyframe (stricter 90° retry) |
| [`demo/product/`](demo/product/) | Five sage ceramic pour-over stills |
| [`public/presets/`](public/presets/) | Kraft / rigid / tissue plates + insert masks |

Pipeline that produced the committed sample (`scripts/e2e_demo.py`, max 2 attempts per step):

1. Core BiRefNet cutout job `8cc4abdc-053a-40e9-a095-daad9e8f5bfe` succeeded → `cutout.png`. The PNG still carries some studio beige; FLUX is what actually nests the ceramic into cardboard.
2. Magenta-well scale-fit into `public/presets/kraft_mailer/empty.png` (`hits=120904` at `(249, 645, 650, 955)`).
3. FLUX 3 blend job `1b0f96bd-df1f-4b46-ba8c-f19b55c877fd` (seed 2026) succeeded, but the open lid was a perspective trapezoid. Stricter 90° retry job `a30215cf-88ad-49f7-bb8c-4a9f7cf96e81` (seed 2027) produced the committed `kf1_nested.png`.
4. Both plates letterboxed 880×1184 → 880×1564 (9:16, same width, no camera change).
5. LTX 2.5 Fast FLF job `77604fe2-911a-4bee-8c84-a1d3f541db46` (seed 2026) succeeded 720×1280 24 fps 3.04s; start/mid stayed overhead, end drifted toward high 3/4 because of the first nested plate. One allowed retry with a stronger ceiling-bolted lock and the stricter nested plate: job `23338fa7-34b6-4180-8d3a-d60070bb4c34` (seed 2027).
6. Core RIFE ×2: ConcatenateVideo autogrow is **0-indexed** (`video0` required). The first graph used `video1`–`video4`; jobs `3f8bb914-…` and `c258dfba-…` failed validation. Graph + `pipeline.ts` now wire `video0`–`video3`. The one-clip demo path pops ConcatenateVideo and sends LoadVideo straight into GetVideoComponents. Job `1c6a21e7-75bd-469b-ad3b-67505c607f02` succeeded: 48 fps, original AAC kept.

Camera verdict on the committed clip: start and mid are locked 90° overhead. End stays overhead and matches the nested keyframe; the inner lid is a near-flat plane. The open mailer fills more of the frame than the sealed plate because the lid unfolds upward. The one allowed LTX retry was used.

`npm run typecheck` and `npm run build` both succeeded on this tree.

## Open issues

- Generations need a funded `COMFY_API_KEY`. The client does not read any other key.
- The committed demo is **one** LTX pair (sealed → nested) then RIFE ×2. The studio path concatenates four clips then RIFE ×2 via `concat_rife.json`.
- MiniMax H3 Max R2V is wired (dotted DynamicCombo + autogrow refs) but was not run for this sample (budget).
- Magenta chroma-key leaves a pink fringe on some wells; the insert rects in `metadata.json` are the operational crop. BiRefNet on this hero still left studio beige in the cutout, so the raw composite is not a clean nest.
- No deploy, push, or social post was made.
