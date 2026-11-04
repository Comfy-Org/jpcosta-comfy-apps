#!/usr/bin/env python3
"""Comfy Cloud API v2 helper. Reads COMFY_API_KEY and COMFY_BASE_URL. Never prints the key."""
from __future__ import annotations

import json
import os
import re
import uuid
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BASE = os.environ.get("COMFY_BASE_URL", "https://cloud.comfy.org").rstrip("/")

_pfx = "comfy" + "ui-"
_KEYISH = re.compile(rf"(?:{re.escape(_pfx)}|sk-)[A-Za-z0-9_\-]{{12,}}", re.I)


def _api_key() -> str:
    k = os.environ.get("COMFY_API_KEY")
    if not k:
        raise SystemExit("COMFY_API_KEY is not set")
    return k


KEY = _api_key()


def redact(s: str) -> str:
    out = s.replace(KEY, "[redacted]") if KEY else s
    out = _KEYISH.sub("[redacted]", out)
    return out[:600]


def _as_text(body: Any) -> str:
    if isinstance(body, (bytes, bytearray)):
        body = body.decode(errors="replace")
    if isinstance(body, (dict, list)):
        try:
            body = json.dumps(body)
        except Exception:
            body = str(body)
    return redact(str(body))


def _headers(json_body: bool = False) -> dict[str, str]:
    h = {"Authorization": f"Bearer {KEY}"}
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def _req(method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None, timeout: int = 120):
    url = path if path.startswith("http") else f"{BASE}{path}"
    hdrs = headers or _headers(json_body=data is not None)
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype or (body[:1] in (b"{", b"[")):
                try:
                    return resp.status, json.loads(body.decode() or "null")
                except json.JSONDecodeError:
                    return resp.status, body
            return resp.status, body
    except urllib.error.HTTPError as e:
        err = e.read()
        try:
            parsed = json.loads(err.decode())
        except Exception:
            parsed = err.decode(errors="replace")[:4000]
        return e.code, parsed


def _guess_content_type(name: str) -> str:
    ext = Path(name).suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
    }.get(ext, "application/octet-stream")


def submit(workflow: dict[str, Any], extra_data: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {
        "workflow": workflow,
        "extra_data": {
            "api_key_comfy_org": KEY,
            **(extra_data or {}),
        },
    }
    headers = _headers(json_body=True)
    headers["Idempotency-Key"] = str(uuid.uuid4())
    status, body = _req("POST", "/api/v2/jobs", data=json.dumps(payload).encode(), headers=headers, timeout=60)
    if status not in (200, 201, 202):
        raise RuntimeError(f"submit failed HTTP {status}: {_as_text(body)}")
    if not isinstance(body, dict) or not body.get("id"):
        raise RuntimeError(f"submit unexpected body: {_as_text(body)}")
    return str(body["id"])


def get_job(job_id: str) -> dict[str, Any]:
    status, body = _req("GET", f"/api/v2/jobs/{job_id}", headers=_headers())
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"status failed HTTP {status}: {_as_text(body)}")
    return body


def job_status(prompt_id: str) -> str:
    return str(get_job(prompt_id).get("status") or "unknown")


def history(prompt_id: str) -> dict[str, Any]:
    return get_job(prompt_id)


def wait(prompt_id: str, timeout: int = 600, interval: float = 3.0) -> dict[str, Any]:
    ok = {"succeeded"}
    bad = {"failed", "canceled", "cancelled", "expired"}
    t0 = time.time()
    last = ""
    while time.time() - t0 < timeout:
        job = get_job(prompt_id)
        st = str(job.get("status") or "unknown")
        if st != last:
            rel = job.get("release_id") or job.get("release_version") or ""
            extra = f" release={rel}" if rel else ""
            print(f"  [{prompt_id[:8]}] {st}{extra}", flush=True)
            last = st
        if st in ok:
            return job
        if st in bad:
            raise RuntimeError(f"job {prompt_id} {st}: {_as_text(job.get('error') if job.get('error') is not None else job)}")
        time.sleep(interval)
    raise TimeoutError(f"job {prompt_id} timed out after {timeout}s (last={last})")


def extract_files(hist: dict[str, Any]) -> list[dict[str, str]]:
    """Collect output assets from a v2 job payload."""
    files: list[dict[str, str]] = []
    outs = hist.get("outputs") if isinstance(hist, dict) else None
    if not isinstance(outs, list):
        return files
    for item in outs:
        if not isinstance(item, dict):
            continue
        aid = item.get("id") or item.get("asset_id")
        if not aid:
            continue
        name = str(item.get("name") or aid)
        files.append(
            {
                "id": str(aid),
                "name": name,
                "filename": name,
                "node_id": str(item.get("node_id") or ""),
                "type": str(item.get("type") or ""),
            }
        )
    return files


def download_asset(asset_id: str, dest: Path | None = None) -> bytes:
    status, body = _req("GET", f"/api/v2/assets/{asset_id}", headers=_headers())
    if status != 200 or not isinstance(body, dict) or not body.get("url"):
        raise RuntimeError(f"asset {asset_id} HTTP {status}: {_as_text(body)}")
    url = str(body["url"])
    with urllib.request.urlopen(url, timeout=180) as resp:
        data = resp.read()
    if dest:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print(f"  saved {dest} ({len(data)} bytes)", flush=True)
    return data


def download_view(asset_id: str, dest: Path | None = None, **_ignored: Any) -> bytes:
    return download_asset(asset_id, dest)


def upload_image(path: Path, overwrite: bool = True) -> str:
    del overwrite
    name = path.name
    data = path.read_bytes()
    content_type = _guess_content_type(name)
    boundary = "----OpenUnboxingBoundary"

    def field(n: str, v: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n"
        ).encode()

    # Field order matters: content_type, file_path, tags BEFORE the file part.
    parts = [
        field("content_type", content_type),
        field("file_path", name),
        field("tags", json.dumps(["input"])),
    ]
    header = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    body = b"".join(parts) + header + data + f"\r\n--{boundary}--\r\n".encode()
    headers = {
        "Authorization": f"Bearer {KEY}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    status, resp = _req("POST", "/api/v2/assets", data=body, headers=headers, timeout=120)
    if status not in (200, 201, 202):
        raise RuntimeError(f"upload failed HTTP {status}: {_as_text(resp)}")
    if isinstance(resp, dict) and resp.get("file_path"):
        return str(resp["file_path"])
    raise RuntimeError(f"upload unexpected: {_as_text(resp)}")


def run_and_save(workflow: dict[str, Any], out_dir: Path, timeout: int = 600) -> list[Path]:
    pid = submit(workflow)
    print(f"submitted {pid}", flush=True)
    job = wait(pid, timeout=timeout)
    files = extract_files(job)
    saved: list[Path] = []
    if not files:
        dump = _as_text(job)[:3000]
        print(f"  no files in job outputs: {dump}", flush=True)
        return saved
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, info in enumerate(files):
        filename = info.get("filename") or info.get("name") or f"out_{i}"
        dest = out_dir / Path(filename).name
        if dest.exists():
            dest = out_dir / f"{i}_{Path(filename).name}"
        try:
            download_asset(info["id"], dest=dest)
            saved.append(dest)
        except Exception as e:
            print(f"  download failed for {filename}: {redact(str(e))}", flush=True)
    return saved
