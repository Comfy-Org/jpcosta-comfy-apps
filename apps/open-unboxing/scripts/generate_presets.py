#!/usr/bin/env python3
"""Generate Open Unboxing preset box images + demo product shots via Comfy Cloud FLUX 3."""
from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comfy_cloud import run_and_save, submit, wait, history, extract_files, download_view

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "presets"
DEMO_PROD = ROOT / "demo" / "product"
OUT.mkdir(parents=True, exist_ok=True)
DEMO_PROD.mkdir(parents=True, exist_ok=True)

DESK = (
    "true 90-degree top-down overhead photograph from a camera rigidly mounted above a table, "
    "no tilt, no dutch angle, no perspective, looking straight down. "
    "Pale natural oak desk, even soft daylight, photorealistic product photography, "
    "no people, no faces, no logos, no brand marks, no barcodes, no text, no watermarks."
)

JOBS: list[tuple[str, Path, str, int]] = []

# --- boxes ---
JOBS.append((
    "kraft_lid",
    OUT / "kraft_mailer" / "lid_on.png",
    DESK + " Centered in frame: a sealed unbranded brown kraft paper mailer shipping box, "
    "matte kraft fiber texture, kraft gummed paper tape sealing the lid seam, "
    "modest rectangular mailer, nothing else on the desk.",
    11011,
))
JOBS.append((
    "kraft_empty",
    OUT / "kraft_mailer" / "empty.png",
    DESK + " Centered: the SAME unbranded brown kraft paper mailer, now OPEN, lid folded back "
    "and lying flat above the box. Inside the box is a cream cardboard insert tray. "
    "The rectangular inner well of the insert is filled with a perfectly flat SOLID MAGENTA "
    "(#FF00FF) rectangle — magenta exists ONLY in that inner well, everything else is natural kraft "
    "and cream cardboard. Empty, no product, no tissue.",
    11012,
))
JOBS.append((
    "luxury_lid",
    OUT / "rigid_luxury" / "lid_on.png",
    DESK + " Centered: a sealed unbranded rigid luxury gift box, matte warm-ivory paper wrap, "
    "soft-touch finish, a thin recessed lid with a barely-there shadow gap, no ribbon, no foil stamp, "
    "no monogram. Premium rigid set-up box, closed.",
    12011,
))
JOBS.append((
    "luxury_empty",
    OUT / "rigid_luxury" / "empty.png",
    DESK + " Centered: the SAME unbranded rigid ivory luxury gift box, LID LIFTED OFF and set just "
    "above the base (lid resting behind the base, still in frame). Inside: a plush champagne-beige "
    "paperboard insert. The rectangular inner well is filled with a perfectly flat SOLID MAGENTA "
    "(#FF00FF) rectangle — magenta ONLY in the well. Empty, no product.",
    12012,
))
JOBS.append((
    "tissue_lid",
    OUT / "tissue_wrap" / "lid_on.png",
    DESK + " Centered: an unbranded cream folding carton wrapped in unbranded white tissue paper "
    "with a simple kraft twine bow on top, fully closed gift wrap, no logos, no patterned paper, "
    "soft paper wrinkles, ready to be unwrapped.",
    13011,
))
JOBS.append((
    "tissue_empty",
    OUT / "tissue_wrap" / "empty.png",
    DESK + " Centered: the SAME cream folding carton, tissue paper unfolded and pulled aside to the "
    "top of frame, box OPEN. Inside: a white card insert. The rectangular inner well is filled with "
    "a perfectly flat SOLID MAGENTA (#FF00FF) rectangle — magenta ONLY in the well. Empty, no product.",
    13012,
))

# --- demo product: unbranded sage ceramic pour-over dripper, 5 angles ---
PRODUCT = (
    "studio product photograph of a single unbranded matte sage-green ceramic pour-over coffee dripper "
    "with a conical body, three-hole base, and a small handle, no logos, no text, no brand. "
    "Soft even lighting, photoreal, isolated on seamless warm off-white sweep, product only."
)
JOBS.append(("prod_hero", DEMO_PROD / "01_hero.png", PRODUCT + " Three-quarter view, slight top angle.", 21001))
JOBS.append(("prod_top", DEMO_PROD / "02_top.png", PRODUCT + " Directly overhead, looking into the cone.", 21002))
JOBS.append(("prod_side", DEMO_PROD / "03_side.png", PRODUCT + " Strict side profile, handle to the right.", 21003))
JOBS.append(("prod_front", DEMO_PROD / "04_front.png", PRODUCT + " Front elevation, handle facing camera.", 21004))
JOBS.append(("prod_detail", DEMO_PROD / "05_detail.png", PRODUCT + " Closer three-quarter, showing the drip holes in the base.", 21005))


def flux3_t2i(prompt: str, seed: int, prefix: str, aspect: str = "3:4", resolution: str = "1K") -> dict:
    return {
        "1": {
            "class_type": "Flux3ImageNode",
            "inputs": {
                "prompt": prompt,
                "aspect_ratio": aspect,
                "resolution": resolution,
                "grounding": False,
                "safety_tolerance": 4,
                "seed": seed,
            },
            "_meta": {"title": "FLUX 3 Image"},
        },
        "2": {
            "class_type": "SaveImage",
            "inputs": {"images": ["1", 0], "filename_prefix": prefix},
            "_meta": {"title": "Save Image"},
        },
    }


def run_one(name: str, dest: Path, prompt: str, seed: int) -> tuple[str, Path | None, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 10000:
        return name, dest, "cached"
    try:
        saved = run_and_save(flux3_t2i(prompt, seed, f"ou_{name}"), dest.parent, timeout=420)
        if not saved:
            return name, None, "no-output"
        # rename first image to dest
        src = saved[0]
        if src != dest:
            dest.write_bytes(src.read_bytes())
        return name, dest, "ok"
    except Exception as e:
        return name, None, f"{type(e).__name__}: {e}"


def main() -> int:
    print(f"generating {len(JOBS)} images", flush=True)
    results = []
    # 3 at a time to respect concurrency
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = [ex.submit(run_one, *job) for job in JOBS]
        for fut in as_completed(futs):
            name, path, status = fut.result()
            print(f"DONE {name}: {status} {path}", flush=True)
            results.append((name, path, status))
    failed = [r for r in results if r[2] not in ("ok", "cached")]
    print(json.dumps({"ok": len(results) - len(failed), "failed": [(n, s) for n, _, s in failed]}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
