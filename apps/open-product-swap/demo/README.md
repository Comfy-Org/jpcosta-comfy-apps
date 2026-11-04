# Demo assets

## Inputs

| File | What |
| --- | --- |
| `input/source.mp4` | 3.06s 768×512 clip of a person holding a red “Ridge Cola” can (Ken Burns from the still) |
| `input/source_5s.mp4` | Same clip looped to 5.25s / 84 frames @16fps for the 720p job |
| `input/source_frame.jpg` | First-frame still |
| `input/sku_haven_ginger.jpg` | Studio SKU photo of the replacement bottle |

## Sample output

**Correction (2026-10-21):** the first 720p demo (job `e4fe1ae5-…`) showed the original red can, not the SKU. VACE copied the product from the un-masked control frames. The graph now greys out the masked region (nodes 40/41) before `WanVaceToVideo`.

Live Wan 2.1 VACE swaps on 2026-10-21 (Comfy Build serverless, Cloud API v2).

**720p** — job `e2bd12af-1b89-424c-92fe-6fdab7e9faa5` (regenerated 2026-10-21 with the grey-out VACE control) succeeded at 1280×720, 5.0s, 80 frames. The Haven Ginger bottle is in the hand across the whole clip.

- `output/open_product_swap_wan_720p.mp4` — H.264 1280×720, 4.999s, 80 frames, 1.09 MB
- `output/open_product_swap_keyframe_720p.png` — FLUX 3 keyframe
- `output/job_720p.json` / `output/submit_720p.json` — poll and submit records (no secrets)

**480p (legacy, not faithful)** — job `f4989ed7-c16d-4653-8d75-624282d37d1d`. Made before the fix: it still shows the original red can, because the raw frames were fed as VACE `control_video`. Kept only for comparison.

- `output/open_product_swap_wan.mp4` — H.264 480×480, 1.5s, 24 frames
- `output/open_product_swap_keyframe_00001_.png` — FLUX 3 keyframe
- `output/job.json` / `output/submit.json`

To re-run the short clip:

```bash
export COMFY_API_KEY=your-api-key-here
export COMFY_BASE_URL=https://dep-xxxx.run.comfy.app
npm run build && npm start
node scripts/e2e.mjs
```

720p (landscape, 5s, 81-frame request):

```bash
OPS_WIDTH=1280 OPS_HEIGHT=720 OPS_DURATION=5 OPS_FRAMES=81 \
  OPS_VIDEO=demo/input/source_5s.mp4 \
  OPS_OUT=open_product_swap_wan_720p.mp4 \
  OPS_JOB_JSON=job_720p.json OPS_SUBMIT_JSON=submit_720p.json \
  OPS_FALLBACK_WIDTH=832 OPS_FALLBACK_HEIGHT=480 \
  node scripts/e2e.mjs
```

Outputs land in `demo/output/`.
