#!/usr/bin/env python3
"""One real end-to-end unboxing on the Comfy Build serverless endpoint. Saves under demo/.

Cutout runs on the endpoint (core BiRefNet). No local matte fallback.
Finishes with core RIFE ×2 (48 fps, original audio).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comfy_cloud import redact, run_and_save, upload_image

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "demo"
PROD = DEMO / "product"
PRESET = ROOT / "public" / "presets" / "kraft_mailer"
WF = ROOT / "workflows"
OUT = DEMO / "run"


def load_wf(name: str) -> dict:
    raw = json.loads((WF / name).read_text())
    raw.pop("_meta", None)
    return raw


def is_well(r: int, g: int, b: int) -> bool:
    return r > 180 and g < 110 and (r - g) > 90 and b > 90


def nest(empty: Path, product: Path, dest: Path) -> None:
    box = Image.open(empty).convert("RGBA")
    prod = Image.open(product).convert("RGBA")
    w, h = box.size
    pix = box.load()
    minx, miny, maxx, maxy = w, h, 0, 0
    hits = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if is_well(r, g, b):
                hits += 1
                minx = min(minx, x)
                miny = min(miny, y)
                maxx = max(maxx, x)
                maxy = max(maxy, y)
                pix[x, y] = (214, 196, 168, 255)
    if hits < 200:
        minx, miny, maxx, maxy = int(w * 0.28), int(h * 0.54), int(w * 0.74), int(h * 0.81)
    well_w, well_h = maxx - minx, maxy - miny
    pad = 0.12
    max_w = max(8, int(well_w * (1 - pad)))
    max_h = max(8, int(well_h * (1 - pad)))
    prod.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    px = minx + (well_w - prod.width) // 2
    py = miny + (well_h - prod.height) // 2
    box.alpha_composite(prod, (px, py))
    dest.parent.mkdir(parents=True, exist_ok=True)
    box.convert("RGB").save(dest, "PNG")
    print(f"nested well hits={hits} at {(minx, miny, maxx, maxy)} -> {dest}")


def pad_to_916(src: Path, dest: Path) -> None:
    """Letterbox a 3:4 overhead plate into 9:16 without changing camera."""
    im = Image.open(src).convert("RGB")
    w, h = im.size
    target_h = max(h, int(round(w * 16 / 9)))
    if target_h == h:
        im.save(dest, "PNG")
        return
    canvas = Image.new("RGB", (w, target_h), im.getpixel((0, 0)))
    canvas.paste(im, (0, (target_h - h) // 2))
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest, "PNG")
    print(f"pad 9:16 {w}x{h} -> {w}x{target_h} {dest}", flush=True)


def run_step(label: str, fn):
    """At most two attempts per step."""
    last: Exception | None = None
    for attempt in range(2):
        try:
            print(f"{label} (attempt {attempt + 1}/2)", flush=True)
            return fn()
        except Exception as exc:
            last = exc
            print(f"  {label} failed: {redact(str(exc))}", flush=True)
            if attempt == 1:
                raise
    assert last is not None
    raise last


def grab_frame(video: Path, dest: Path, when: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video),
        "-ss",
        when,
        "-frames:v",
        "1",
        "-update",
        "1",
        str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def main() -> int:
    hero = PROD / "01_hero.png"
    lid = PRESET / "lid_on.png"
    empty = PRESET / "empty.png"
    if not hero.exists() or not lid.exists():
        raise SystemExit("Missing demo product or kraft preset plates.")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    cutout = OUT / "cutout.png"
    nested_raw = OUT / "nested_raw.png"
    nested = OUT / "kf1_nested.png"

    def do_cutout() -> None:
        cut_name = upload_image(hero)
        wf = load_wf("product_cutout.json")
        wf["1"]["inputs"]["image"] = cut_name
        wf["6"]["inputs"]["filename_prefix"] = "ou_demo_cut"
        cut_files = run_and_save(wf, OUT / "cutout", timeout=600)
        if not cut_files:
            raise RuntimeError("cutout produced no image")
        shutil.copy(cut_files[0], cutout)

    run_step("1. cutout hero (endpoint BiRefNet)", do_cutout)

    print("2. composite into kraft insert", flush=True)
    nest(empty, cutout, nested_raw)

    def do_edit() -> None:
        src = upload_image(nested_raw)
        pref = upload_image(cutout)
        wf = load_wf("flux3_image_edit.json")
        wf["10"]["inputs"]["image"] = src
        wf["11"]["inputs"]["image"] = pref
        wf["1"]["inputs"]["prompt"] = (
            "TRUE 90-degree top-down overhead photograph, camera locked on the ceiling looking straight down. "
            "The open kraft mailer is a flat rectangle in frame; the inner lid is a flat cardboard plane, not a perspective trapezoid. "
            "No three-quarter view, no tilt, no dutch angle, no zoom. Keep image 1's crop and desk. "
            "Nest the exact sage ceramic pour-over from image 2 into the insert well with a contact shadow. No hands."
        )
        wf["1"]["inputs"]["seed"] = 2026
        wf["2"]["inputs"]["filename_prefix"] = "ou_demo_nested"
        nest_files = run_and_save(wf, OUT / "kf", timeout=420)
        if not nest_files:
            raise RuntimeError("flux3 edit produced no image")
        shutil.copy(nest_files[0], nested)

    run_step("3. FLUX 3 blend edit (nested keyframe)", do_edit)
    shutil.copy(lid, OUT / "kf0_sealed.png")
    kf0_916 = OUT / "kf0_916.png"
    kf1_916 = OUT / "kf1_916.png"
    pad_to_916(OUT / "kf0_sealed.png", kf0_916)
    pad_to_916(nested, kf1_916)

    def do_ltx(first: Path, last: Path, seed: int, prompt: str, tag: str) -> Path:
        a = upload_image(first)
        b = upload_image(last)
        wf = load_wf("ltx25_flf2v.json")
        wf["10"]["inputs"]["image"] = a
        wf["11"]["inputs"]["image"] = b
        wf["20"]["inputs"]["model"] = "LTX-2.5 (Fast)"
        wf["20"]["inputs"]["model.duration"] = "3"
        wf["20"]["inputs"]["model.resolution"] = "720x1280"
        wf["20"]["inputs"]["model.fps"] = "24"
        wf["20"]["inputs"]["model.generate_audio"] = True
        wf["20"]["inputs"]["prompt"] = prompt
        wf["20"]["inputs"]["seed"] = seed
        wf["30"]["inputs"]["filename_prefix"] = f"ou_demo_ltx_{tag}"
        wf["30"]["inputs"]["format"] = "mp4"
        vids = run_and_save(wf, OUT / "video" / tag, timeout=900)
        clip = next((p for p in vids if p.suffix.lower() == ".mp4"), vids[0] if vids else None)
        if not clip:
            raise RuntimeError("LTX produced no video")
        return clip

    LTX_PROMPT = (
        "Locked-off static top-down overhead camera, 90 degrees, no camera movement, no tilt, no zoom, no dolly, no push-in. "
        "The camera is bolted to the ceiling. Both keyframes share identical framing and scale; only hands and the lid move. "
        "Do not orbit, do not lower the camera, do not show a three-quarter table view. "
        "Bare adult hands peel kraft tape and open the mailer lid, revealing the sage ceramic pour-over nested in the insert. "
        "Slow ASMR, paper and tape, no faces, no logos, no music."
    )

    video = run_step(
        "4. LTX 2.5 first-last-frame 3s (sealed → nested)",
        lambda: do_ltx(kf0_916, kf1_916, 2026, LTX_PROMPT, "a"),
    )

    def do_rife() -> Path:
        vname = upload_image(video)
        wf = load_wf("concat_rife.json")
        for extra in ("11", "12", "13", "20"):
            wf.pop(extra, None)
        wf["10"]["inputs"]["file"] = vname
        wf["30"]["inputs"]["video"] = ["10", 0]
        wf["70"]["inputs"]["filename_prefix"] = "ou_demo_rife"
        vids = run_and_save(wf, OUT / "rife", timeout=600)
        out = next((p for p in vids if p.suffix.lower() == ".mp4"), vids[0] if vids else None)
        if not out:
            raise RuntimeError("RIFE produced no video")
        return out

    video = run_step("5. core RIFE ×2 (48 fps, keep audio)", do_rife)
    final = DEMO / "unboxing.mp4"
    shutil.copy(video, final)
    shutil.copy(OUT / "kf0_sealed.png", DEMO / "kf0_sealed.png")
    shutil.copy(nested, DEMO / "kf1_nested.png")
    try:
        grab_frame(final, DEMO / "unboxing_frame.jpg", "0.08")
        grab_frame(final, DEMO / "unboxing_mid.jpg", "1.5")
        grab_frame(final, DEMO / "unboxing_last.jpg", "2.85")
    except Exception as exc:
        print(f"frame grab skipped: {redact(str(exc))}", flush=True)
    print("SAVED", final)
    print("bytes", final.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
