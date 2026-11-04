# Comfy API Apps

Sprite sheets, virtual try-on, hand product swap, paparazzi inserts, background removal, an open product-swap video, an overhead unboxing, and a Halloween pumpkin-carve timelapse, each running a real ComfyUI workflow on its own Comfy API deployment. API keys stay on the server.

Live: [jpcosta-comfy-apps.vercel.app](https://jpcosta-comfy-apps.vercel.app/)

## Apps

| App | What you do | Engine | Deployment |
|---|---|---|---|
| Sprite sheet generator | Upload a character. Choose style (pixel, toon, 3D), motion (idle, walk, jump), and an optional animation note. | Nano Banana 2. One 4×2 sheet at 16:9 / 2K. The browser slices it into the preview. | [sprite-generator](https://dep-6e5a0ab1-8131-4ee8-acb7-ae1840160e13.run.comfy.app) |
| Virtual try-on | Upload a person and a garment. Choose slim, regular, or relaxed. | FLUX Virtual Try-On | [virtual-try-on](https://dep-d99a045a-86e9-4251-bbae-0a88940f78d1.run.comfy.app) |
| Hand product swap | Upload a hand photo and a product. Same hand and grip, new product. Resolution is 1K, 2K, or 4K. | Nano Banana Pro (Gemini) | [hand-product-swap](https://dep-9a807afc-d80c-43de-adc4-d0eee9a73655.run.comfy.app) |
| Paparazzi Me | Type a celebrity name and upload your face. The server searches for a paparazzi photo (or you pick one). A scene upload is an optional override. Resolution is 1K, 2K, or 4K. | Nano Banana Pro (Gemini) | [paparazzi-me](https://dep-be6a6286-e47c-4e0f-b9fc-8fad55236367.run.comfy.app) |
| Background removal | Upload a photo. Choose transparent, white, or lilac, then PNG or WebP. | BiRefNet. White, lilac, and WebP are composited in the browser. | [background-removal](https://dep-e45cb437-0991-4689-9f7c-77d5748e3adc.run.comfy.app) |
| Open Product Swap | Upload a short clip of someone holding a product, plus a product photo. Optional product note. Resolution is 480p or 720p. | Wan 2.1 VACE plus FLUX 3. Output is an mp4. | [open-product-swap](https://dep-c6eae195-e598-4f43-8928-00cb4aa3c2d7.run.comfy.app) |
| Open Unboxing | Upload 1–5 product photos and pick a preset box. | BiRefNet cutout, FLUX 3 nested keyframe, LTX 2.5 first-last frame, RIFE ×2. Output is an mp4. | [open-unboxing](https://dep-727f285f-f3d8-4348-8378-eacd314ebb58.run.comfy.app) |
| Pumpkin Carve | Upload one photo. | Recraft vectorize stencil (works with celebrity photos), Seedream 4.5 blank+carve stills, Kling 3.0 first-last-frame hyperlapse (blank→carved, 720p). The SVG is a live stencil only. Output is an mp4. | [pumpkin-carve](https://dep-480af229-63d7-4022-9bdc-2dd20c2ffc9f.run.comfy.app) |

The hosts above are the defaults in `workflows/deployments.json`. Workers are `--min 0 --max 1`, and only 3 deployments can be active at once, so a host may be stopped or still cold-starting. Open Product Swap and Open Unboxing use the work-personal workspace. Pumpkin Carve uses the Comfy team workspace.

## How a run works

1. The browser posts the form to `POST /api/run/[app]`. Images are png, jpg, or webp up to 15 MB. The server applies EXIF rotation and resizes to that app's `maxSide` in `workflows/apps.config.json`. Open Product Swap also takes one MP4, MOV, or WebM up to 4 MB (the whole form must stay under about 4.5 MB). Open Unboxing takes 1–5 product photos; the browser shrinks them so the form stays under 4 MB, and the server uploads the chosen preset's empty and lid-on stills itself. Pumpkin Carve takes one photo (max side 1536). Paparazzi Me can omit the scene file: `GET /api/paparazzi/search?q=` returns signed scene choices, and the run downloads the chosen photo (or the best match for the celebrity name) before upload. A scene file overrides that search. The celebrity name is not sent to the workflow.
2. It uploads each file to that app's deployment with `POST /api/v2/assets`. The multipart fields go in this order: `content_type` (`image/png`, or `video/mp4` / `video/quicktime` / `video/webm`), `file_path`, `tags` (`["input"]` as a JSON string), then `file`. Putting `file` first returns HTTP 422 `invalid_body`.
3. `workflow_api.json` receives the asset id on each LoadImage or LoadVideo, plus the prompt and seed from the controls. Open Unboxing also patches the insert box from the preset.
4. `POST /api/v2/jobs` on the same host, with an `Idempotency-Key`. Sprite sheet generator, Virtual try-on, Hand product swap, and Paparazzi Me send `extra_data.api_key_comfy_org` from `COMFY_API_KEY` (or `COMFY_CLOUD_API_KEY`). Open Product Swap and Open Unboxing send that field from `COMFY_API_KEY_WORK_PERSONAL` only. Pumpkin Carve sends it from `COMFY_API_KEY_TEAM` only. Partner jobs use credits.
5. The browser polls `GET /api/jobs/{app}~{jobId}`. Image apps wait up to 8 minutes. Open Product Swap, Open Unboxing, and Pumpkin Carve wait up to 15 minutes and say when a cold start is likely. The app slug picks the deployment.
6. Downloads go through `GET /api/outputs/{app}~{assetId}?sig=...`. The signature is checked, then the server loads a short-lived URL (about 6 hours) and streams the bytes. Video results play in the page and download as mp4 or webm.

Every call to a deployment sends `Authorization: Bearer` and that deployment's key. A record with `keyEnv` never falls back to `COMFY_API_KEY`.

A stopped deployment (`deployment_stopped`, 422) needs `comfy deploy start` before another run will go through. A cold start (`deployment_not_ready`, 429) means wait, then run again.

## Environment

Server only. Locally that is `.env.local`. On Vercel, project `comfy-api-apps`, Production and Preview.

| Name | Required | Notes |
|---|---|---|
| `COMFY_API_KEY` | yes for the shared apps, unless the alias below is set | Personal Comfy platform key. Preferred name. |
| `COMFY_CLOUD_API_KEY` | alias | Read when `COMFY_API_KEY` is unset. If both are set, `COMFY_API_KEY` wins. This is the key sent for partner nodes on the shared apps. |
| `COMFY_API_KEY_WORK_PERSONAL` | yes for Open Product Swap and Open Unboxing | The only key those two apps use. A missing value is a `missing_key` error. It is not a fallback, and the shared key is not used in its place. |
| `COMFY_API_KEY_TEAM` | yes for Pumpkin Carve | The only key that app uses. A missing value is a `missing_key` error. It is not a fallback, and the shared key is not used in its place. |
| `COMFY_BASE_URL_SPRITE_GENERATOR` | no | Override for that app. Default is in `workflows/deployments.json`. |
| `COMFY_BASE_URL_VIRTUAL_TRY_ON` | no | Same. |
| `COMFY_BASE_URL_HAND_PRODUCT_SWAP` | no | Same. Default host is `https://dep-9a807afc-d80c-43de-adc4-d0eee9a73655.run.comfy.app`. |
| `COMFY_BASE_URL_PAPARAZZI_ME` | no | Same. Default host is `https://dep-be6a6286-e47c-4e0f-b9fc-8fad55236367.run.comfy.app`. |
| `SERPAPI_API_KEY` | no | Paparazzi Me image search. Used when set, ahead of Google CSE and Bing. With no search key, Wikipedia photos are used. |
| `GOOGLE_CSE_API_KEY` | no | Google Programmable Search key. Also set `GOOGLE_CSE_CX`. |
| `GOOGLE_CSE_CX` | no | Google Programmable Search engine id (`searchType=image`). |
| `BING_IMAGE_SEARCH_KEY` | no | Bing Image Search subscription key. Used when the keys above are unset. |
| `COMFY_BASE_URL_BACKGROUND_REMOVAL` | no | Same. |
| `COMFY_BASE_URL_OPEN_PRODUCT_SWAP` | no | Same. Default host is `https://dep-c6eae195-e598-4f43-8928-00cb4aa3c2d7.run.comfy.app`. |
| `COMFY_BASE_URL_OPEN_UNBOXING` | no | Same. Default host is `https://dep-727f285f-f3d8-4348-8378-eacd314ebb58.run.comfy.app`. |
| `COMFY_BASE_URL_PUMPKIN_CARVE` | no | Same. Default host is `https://dep-480af229-63d7-4022-9bdc-2dd20c2ffc9f.run.comfy.app`. |
| `COMFY_MOCK` | no | `1` returns sample images and skips the deployments. Leave unset for live runs. Celebrity search still runs. Video apps return a still in mock mode. |
| `OUTPUT_SIGNING_SECRET` | no | HMAC for download links. If unset, SHA-256 of the key for that output's app (`keyEnv` when the deployment sets one, otherwise `COMFY_API_KEY`, else `COMFY_CLOUD_API_KEY`). |

Copy `.env.example` to `.env.local` and paste the key.

## Local

```bash
npm i
npm run dev
```

```bash
npm run lint
npm run check
npm run build
```

## Layout

```
workflows/deployments.json          deployment id, release id, endpoint, env var, optional keyEnv
workflows/apps.config.json          app → workflow, inputs, prompt templates
workflows/<app>/workflow_api.json   graph submitted to that deployment
workflows/<app>/README.md           node map for the live graph
workflows/open-unboxing/            live graph, plus the upstream multi-step graphs, NODE_MAP, REPORT, build spec
workflows/open-product-swap/        live graph, plus Wan and LTX graphs, NODE_MAP, REPORT, build spec
public/presets/                     unboxing box stills and card thumbnails
demo/open-unboxing/                 committed unboxing clip and stills
demo/open-product-swap/             committed product-swap clip and stills
scripts/open-unboxing/              preset and demo generators (monorepo paths)
scripts/open-product-swap/          e2e script aimed at the studio server
apps/open-unboxing/                 upstream Next.js studio (not the Vercel entry)
apps/open-product-swap/             upstream Next.js studio (not the Vercel entry)
src/app/api/run/[app]               validate, resize, upload, submit
src/app/api/jobs/[id]               poll the deployment named in the id
src/app/api/outputs/[assetId]       stream the output after checking sig
src/                                Next.js App Router UI (carousel)
```

Open Unboxing and Open Product Swap are carousel cards, same as the other apps (`enabled: true` in `workflows/apps.config.json`). The studios under `apps/` are the original long-running Next.js apps. They are not compiled into this build. `npm run dev` at the repo root is the carousel.

## Deploy

`main` on `Comfy-Org/jpcosta-comfy-apps` deploys to the Vercel project `jpcosta-comfy-apps` (team comfyui).

Set `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for Production and Preview, then redeploy. Also set `COMFY_API_KEY_WORK_PERSONAL` or Open Product Swap and Open Unboxing stay offline. Set `COMFY_API_KEY_TEAM` or Pumpkin Carve stays offline. Leave the `COMFY_BASE_URL_*` variables unset unless that environment should call a different host than `workflows/deployments.json`. Leave `COMFY_MOCK` unset for live runs. Set `OUTPUT_SIGNING_SECRET` when download links should stay valid after an API key changes.

The browser resizes image uploads before POST so they stay under the Vercel body limit (2048 px on image apps, smaller when several photos or a video share the form). Video clips are not transcoded. Trim them to 4 MB. The server still checks type, the 15 MB image cap, the 4 MB video cap, the 4.5 MB combined body, EXIF orientation, and each app's `maxSide`. Drag a file onto any upload zone, or click it.
