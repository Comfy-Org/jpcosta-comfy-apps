# Open Product Swap — report

## Architecture

Next.js 15 App Router (TypeScript, Tailwind) talks to **`COMFY_BASE_URL`**: a Comfy Build serverless deployment (`https://dep-xxxx.run.comfy.app`) or public Comfy Cloud (`https://cloud.comfy.org`, the default). Auth is the single env var `COMFY_API_KEY`, sent as `Authorization: Bearer` and as `extra_data.api_key_comfy_org`. Serverless rejects `X-API-Key`. Nothing runs a local ComfyUI.

```
browser
  │  FormData: video + 1–5 SKU photos per SKU, batch list
  ▼
POST /api/jobs
  │  1. POST /api/v2/assets (multipart: content_type, file_path, tags=["input"], file)
  │  2. load workflows/product-swap-{ltx|wan-vace}.json
  │  3. patch LoadVideo/LoadImage with asset file_path, prompts, seed
  │  4. POST /api/v2/jobs {workflow, extra_data:{api_key_comfy_org}} + Idempotency-Key
  ▼
GET /api/jobs/[id]  →  GET /api/v2/jobs/{id}
GET /api/jobs/[id]/file  →  GET /api/v2/assets/{id} → signed url (key not forwarded)
```

Batch mode: one source clip is uploaded once; the server submits **one Comfy job per SKU**.

The graphs are API-format JSON in [`workflows/`](workflows/). Node/input map: [`workflows/NODE_MAP.md`](workflows/NODE_MAP.md).

## Models

| Stage | Model | Weights | Role |
| --- | --- | --- | --- |
| Mask | SAM 3.1 multiplex `sam3.1_multiplex_fp16.safetensors` | Open | Text-prompted product mask (`SAM3_Detect`) |
| Keyframe | FLUX 3 Image (`Flux3ImageNode`) | Partner | Swap SKU into the first frame; hands stay |
| Video (default) | **LTX-2.3 22B distilled** + `ltx-2.3-22b-ic-lora-in-outpainting-0.9` | Open | Core video model (contest LTX bonus) |
| Video (alt) | Wan 2.1 VACE 14B + CausVid LoRA | Open | Masked video inpaint / ref2v |

Open-weights-only variant: skip `Flux3ImageNode` and use the SKU photo as `reference_image` / first-frame guide. Documented in `NODE_MAP.md`.

## How to run

```bash
npm install
export COMFY_API_KEY=your-api-key-here   # https://platform.comfy.org/profile/api-keys
export COMFY_BASE_URL=https://dep-xxxx.run.comfy.app   # or omit for Cloud
npm run dev                        # http://localhost:3000
npm run typecheck
npm run build
```

Do not commit the key. `.env.example` lists placeholders only. Publish the spec in [`build/comfy-build.yaml`](build/comfy-build.yaml) with `comfy-cli` (see README “Run your own endpoint”).

## Sample output path

Two live Wan VACE runs on 2026-10-21 against the Comfy Build serverless endpoint (`COMFY_BASE_URL`, Cloud API v2, Bearer). Auth: Bearer only. Assets uploaded with `tags=["input"]` before the file part. FLUX 3 partner node kept (`extra_data`). CausVid 4-step.

**Superseded 2026-10-21:** this run showed the original red can, not the SKU (raw frames as VACE `control_video`). The current 720p demo is job `e2bd12af-1b89-424c-92fe-6fdab7e9faa5`, made with the greyed-out control; see `demo/README.md`.

**720p (original, superseded).** Job `e4fe1ae5-d813-49fd-9300-0071d7494a65`. Looped `demo/input/source.mp4` (3.06s 768×512) into `demo/input/source_5s.mp4` (5.25s, 84 frames @16fps). Submitted 1280×720, `durationSec=5`, `frames=81`. Succeeded in ~4 minutes (SAM3_Detect → ModelSamplingSD3 → KSampler 4/4). No OOM, no 832×480 fallback.

| Path | Result |
| --- | --- |
| `demo/input/source_5s.mp4` | Looped source used for 720p |
| `demo/output/submit_720p.json` | `{ jobs: [{ id: e4fe1ae5-…, pipeline: wan-vace }] }` |
| `demo/output/job_720p.json` | `status: success`, `used: { width: 1280, height: 720, fallback: false }` |
| `demo/output/open_product_swap_wan_720p.mp4` | **H.264 1280×720, 4.999s, 80 frames, 920 KB** |
| `demo/output/open_product_swap_keyframe_720p.png` | FLUX 3 keyframe still |

**480p (kept).** Job `f4989ed7-c16d-4653-8d75-624282d37d1d`. 480×480, 1.5s, 24 frames. `demo/output/open_product_swap_wan.mp4` (114 KB).

## Open issues

1. **Partner keyframe.** FLUX 3 Image is a partner node. It needs `extra_data.api_key_comfy_org` (wired) and partner billing. The LTX/Wan video graphs stay open-weights if that node is bypassed (`skipPartner=1`).
2. **Mask quality.** `SAM3_Detect` is text-prompted; busy hands can leak. A points editor is not in the web UI yet (the graph accepts the prompt from the form).
3. **Duration / resolution.** Defaults are short (LTX 25 frames at 768×512, Wan 480²) to keep jobs cheap. Longer clips need `8n+1` frames on LTX and more GPU time.
4. **SaveVideo format widget.** `SaveVideo.format` is a dynamic combo; `auto` matches the official templates. If a worker rejects it, switch to `VHS_VideoCombine`.
5. **No browser MCP in this session.** UI was verified by production build + `/api/health` + `/api/jobs` against a running server, not a headed browser.
