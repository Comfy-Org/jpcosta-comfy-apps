# Open Product Swap

> Upstream studio, preserved under `apps/open-product-swap` in [comfy-api-apps](https://github.com/jpcosta-comfy/comfy-api-apps). The live site is the shared carousel at the repo root (`POST /api/run/open-product-swap`), which submits `workflows/open-product-swap/workflow_api.json`. This package is a separate Next.js app. Run it from this directory. It is not what Vercel builds.



Open-source product swap for video. An open alternative to [Higgsfield Genjutsu Object Swap](https://higgsfield.ai/blog/higgsfield-genjutsu) and Runway Product Swap.

Drop a short clip of a person holding a product, add 1–5 photos of *your* SKU, and the app replaces the held object while keeping hands, motion, and lighting. Batch mode runs **one video × many SKUs**. The ComfyUI graphs live in this repo and run on a **Comfy Build serverless deployment** (or public Comfy Cloud).

Built for the [Comfy Open Source Higgsfield](https://comfy.org/open-source-higgsfield) challenge (closes 30 Oct 2026, 9am PT).

## Why this is better than Higgsfield Genjutsu

| | Higgsfield Genjutsu Object Swap | Open Product Swap |
| --- | --- | --- |
| License | Closed product | **MIT**, graphs included |
| Models | Proprietary | **Open weights** path (SAM 3.1, Wan 2.1 VACE, LTX-2.3) plus optional FLUX 3 keyframe |
| Batch | One clip, one swap | **One clip × many SKUs** in one queue |
| Workflow | Hidden | **Editable API-format JSON** in [`workflows/`](workflows/) |
| Cost | Credits on a closed meter | Your Comfy credits on a serverless GPU (or Cloud) |
| Masking | Implicit | **SAM 3.1** text prompt you can edit (`can`, `bottle`, …) |

Higgsfield is a polished closed demo. This repo is the thing you can fork, inspect, and run.

## Pipeline

```
source video ─┬─ SAM 3.1 ── product mask (grown)
              │
              └─ first frame ─┐
SKU photos (1–5) ─────────────┴─ FLUX 3 Image edit ── product keyframe
                                                      │
                         ┌────────────────────────────┤
                         ▼                            ▼
              LTX-2.3 distilled              Wan 2.1 VACE 14B
              + in-outpainting IC-LoRA       + CausVid 4-step
              (core video model, contest     (open-weights inpaint)
               LTX bonus)
```

- **Masking:** SAM 3.1 multiplex (`SAM3_Detect`) with a text prompt.
- **Keyframe:** FLUX 3 Image (partner node) composites the SKU into the first frame. Hands stay.
- **LTX path (default):** green-screen the masked product (`LTXVInpaintPreprocess`), guide LTX-2.3 distilled with `ltx-2.3-22b-ic-lora-in-outpainting-0.9`.
- **Wan path:** `WanVaceToVideo` with the masked region greyed out (0.5) in `control_video`, the SAM mask as `control_masks`, and the FLUX 3 keyframe as `reference_image`. Without the grey-out, VACE reproduces the original product from the control frames.

Node ids and patch points: [`workflows/NODE_MAP.md`](workflows/NODE_MAP.md).

## Run

You need a [Comfy API key](https://platform.comfy.org/profile/api-keys). The server reads **only** `COMFY_API_KEY` (sent as `Authorization: Bearer` and as `extra_data.api_key_comfy_org` for partner nodes) and `COMFY_BASE_URL` (defaults to `https://cloud.comfy.org`). Comfy Build serverless endpoints reject `X-API-Key`; they speak Cloud API v2 (`/api/v2/assets`, `/api/v2/jobs`).

```bash
git clone <this-repo>
cd open-product-swap
npm install
export COMFY_API_KEY=your-api-key-here
# serverless deployment, or omit to use Cloud:
export COMFY_BASE_URL=https://dep-xxxx.run.comfy.app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Drop a video, add SKU photos, queue.

```bash
npm run typecheck
npm run build
```

Never put the key in a committed `.env`. `.env.example` lists placeholders only.

## Run your own endpoint

[`build/comfy-build.yaml`](build/comfy-build.yaml) is the Comfy Build spec (models + Comfy version). Publish it on [platform.comfy.org](https://platform.comfy.org), then point this app at the deployment URL.

```bash
pip install -U comfy-cli
comfy build push build/
comfy build release create build/ --target linux/nvidia --watch
comfy deploy up build/ --gpu rtx-pro-6000-server --region us --min 0 --max 1
```

Set `COMFY_BASE_URL` to the printed `endpointUrl` (for example `https://dep-xxxx.run.comfy.app`). When you are done:

```bash
comfy deploy stop build/
```

## Demo

Live **Wan 2.1 VACE** product swaps on a Comfy Build serverless GPU (Cloud API v2, 2026-10-21). SAM 3.1 masked the can, FLUX 3 (partner node via `extra_data.api_key_comfy_org`) edited the keyframe, Wan VACE 14B + CausVid inpainted.

| File | What |
| --- | --- |
| [`demo/input/source.mp4`](demo/input/source.mp4) | Original 3s 768×512 source (person holding a can) |
| [`demo/input/source_5s.mp4`](demo/input/source_5s.mp4) | Looped to 5.25s / 84 frames @16fps for the 720p job |
| [`demo/input/sku_haven_ginger.jpg`](demo/input/sku_haven_ginger.jpg) | Replacement SKU |
| [`demo/output/open_product_swap_wan_720p.mp4`](demo/output/open_product_swap_wan_720p.mp4) | **720p demo** — H.264 1280×720, 5.0s, 80 frames. Job `e2bd12af-1b89-424c-92fe-6fdab7e9faa5` (grey-out VACE control; SKU bottle in hand throughout) |
| [`demo/output/open_product_swap_wan.mp4`](demo/output/open_product_swap_wan.mp4) | Short clip — H.264 480×480, 1.5s, 24 frames. Job `f4989ed7-c16d-4653-8d75-624282d37d1d` |
| [`demo/output/open_product_swap_keyframe_720p.png`](demo/output/open_product_swap_keyframe_720p.png) | FLUX 3 keyframe from the 720p run |
| [`demo/output/job_720p.json`](demo/output/job_720p.json) | 720p poll snapshot (`status: success`, no fallback) |

The 720p job used landscape 1280×720 (input is 3:2; ImageScale center-crops to 16:9), `durationSec=5`, `frames=81` (output packed 80 frames @16fps). It finished in about four minutes; 832×480 fallback was not needed.

Re-run short: `node scripts/e2e.mjs`. Re-run 720p: `OPS_WIDTH=1280 OPS_HEIGHT=720 OPS_DURATION=5 OPS_FRAMES=81 OPS_VIDEO=demo/input/source_5s.mp4 OPS_OUT=open_product_swap_wan_720p.mp4 node scripts/e2e.mjs`.

## Stack

- Next.js 15 App Router, TypeScript, Tailwind
- `POST /api/jobs` uploads via `POST /api/v2/assets` (multipart: `content_type`, `file_path`, `tags=["input"]`, then `file`), patches the graph with each asset `file_path`, submits `POST /api/v2/jobs` with `Idempotency-Key`
- `GET /api/jobs/[id]` polls `GET /api/v2/jobs/{id}`
- `GET /api/jobs/[id]/file` resolves `GET /api/v2/assets/{id}` to a signed URL so the browser never sees the API key

## License

[MIT](LICENSE)
