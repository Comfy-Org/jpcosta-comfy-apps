"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOX_PRESETS } from "@/lib/presets";
import type { BoxId, EditEngine, JobRecord, PipelineMode } from "@/lib/types";

type LocalPhoto = { id: string; file: File; url: string };

const STAGES: { id: JobRecord["stage"]; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "uploading", label: "Upload to Comfy Cloud" },
  { id: "cutout", label: "Product cutout" },
  { id: "composite", label: "Scale-fit into the insert" },
  { id: "keyframes", label: "Overhead keyframes" },
  { id: "animate", label: "Animate pairs" },
  { id: "concat", label: "Concat + finish" },
  { id: "done", label: "Ready" },
];

export function Studio() {
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [boxId, setBoxId] = useState<BoxId>("kraft_mailer");
  const [mode, setMode] = useState<PipelineMode>("ltx");
  const [engine, setEngine] = useState<EditEngine>("flux3");
  const [logo, setLogo] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setPhotos((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        next.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, url: URL.createObjectURL(file) });
      }
      return next;
    });
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.id !== id);
    });
  };

  const canGo = photos.length >= 5 && !busy;

  async function generate() {
    setError(null);
    setBusy(true);
    const body = new FormData();
    body.set("boxId", boxId);
    body.set("mode", mode);
    body.set("editEngine", engine);
    for (const p of photos) body.append("photos", p.file, p.file.name);
    if (logo) body.set("logo", logo, logo.name);
    try {
      const res = await fetch("/api/jobs", { method: "POST", body });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || "Could not start the job.");
      const started: JobRecord = {
        id: data.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        stage: "queued",
        mode,
        editEngine: engine,
        boxId,
        photoCount: photos.length,
        hasLogo: Boolean(logo),
        events: [],
      };
      setJob(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!job || job.stage === "done" || job.stage === "error") {
      if (job?.stage === "done" || job?.stage === "error") setBusy(false);
      return;
    }
    const t = window.setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`);
      if (!res.ok) return;
      const next = (await res.json()) as JobRecord;
      setJob(next);
      if (next.stage === "done" || next.stage === "error") {
        setBusy(false);
        window.clearInterval(t);
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [job]);

  const selected = useMemo(() => BOX_PRESETS.find((b) => b.id === boxId)!, [boxId]);
  const lastEvent = job?.events.at(-1)?.message;

  return (
    <div className="grid">
      <section className="card">
        <p className="kicker">01 · Product stills</p>
        <div
          className={`drop${over ? " over" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
        >
          <h3>Drop five or more product-only photos</h3>
          <p>Multiple angles, product only — no lifestyle, no packaging in the stills.</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {photos.length > 0 && (
          <div className="thumbs">
            {photos.map((p) => (
              <div className="thumb" key={p.id}>
                <img src={p.url} alt={p.file.name} />
                <button type="button" onClick={() => removePhoto(p.id)} aria-label="Remove">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="logo-slot">{photos.length} / 5 minimum</p>

        <p className="kicker" style={{ marginTop: 22 }}>
          02 · Unbranded box
        </p>
        <div className="boxes">
          {BOX_PRESETS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`box${boxId === b.id ? " sel" : ""}`}
              onClick={() => setBoxId(b.id)}
            >
              <img
                src={b.lidOn}
                alt=""
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              <figcaption>
                <strong>{b.name}</strong>
                <span>{b.blurb}</span>
              </figcaption>
            </button>
          ))}
        </div>

        <p className="kicker" style={{ marginTop: 22 }}>
          03 · Pipeline
        </p>
        <div className="row">
          <button type="button" className={`chip${mode === "ltx" ? " on" : ""}`} onClick={() => setMode("ltx")}>
            LTX 2.5 FLF + concat
          </button>
          <button type="button" className={`chip${mode === "h3" ? " on" : ""}`} onClick={() => setMode("h3")}>
            MiniMax H3 + ASMR audio
          </button>
        </div>
        <div className="row">
          <button type="button" className={`chip${engine === "flux3" ? " on" : ""}`} onClick={() => setEngine("flux3")}>
            FLUX 3 edit
          </button>
          <button type="button" className={`chip${engine === "qwen" ? " on" : ""}`} onClick={() => setEngine("qwen")}>
            Qwen Edit 2511 (open weights)
          </button>
        </div>

        <label className="logo-slot">
          Optional logo sticker
          <input
            ref={logoRef}
            type="file"
            accept="image/*"
            onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
          />
          {logo ? <span>{logo.name}</span> : <span>PNG with alpha, small</span>}
        </label>

        <button className="go" type="button" disabled={!canGo} onClick={() => void generate()}>
          {busy ? "Generating on Comfy Cloud…" : "Generate unboxing"}
        </button>
        {photos.length > 0 && photos.length < 5 && (
          <div className="err">Add {5 - photos.length} more product still{5 - photos.length === 1 ? "" : "s"}.</div>
        )}
        {error && <div className="err">{error}</div>}
        {job?.stage === "error" && job.error && <div className="err">{job.error}</div>}
      </section>

      <aside className="card stage">
        <p className="kicker">Stage</p>
        {job?.stage === "done" ? (
          <video
            className="hero"
            src={`/api/jobs/${job.id}/output`}
            controls
            autoPlay
            loop
            playsInline
          />
        ) : (
          <img className="hero" src={selected.lidOn} alt={selected.name} />
        )}

        {job && (
          <div className="progress">
            <ol>
              {STAGES.map((s) => {
                const idx = STAGES.findIndex((x) => x.id === job.stage);
                const mine = STAGES.findIndex((x) => x.id === s.id);
                const cls = job.stage === "error" && s.id === job.stage ? "now" : mine < idx ? "ok" : mine === idx ? "now" : "";
                return (
                  <li key={s.id} className={cls}>
                    <span>{mine < idx ? "●" : mine === idx ? "○" : "·"}</span>
                    {s.label}
                  </li>
                );
              })}
            </ol>
            {lastEvent && <p className="logo-slot">{lastEvent}</p>}
          </div>
        )}

        {job?.stage === "done" && (
          <div className="film">
            {["kf0_sealed.png", "kf1_nested.png", "kf2_lift.png", "kf3_rotate.png", "kf4_table.png"].map((n) => (
              <img key={n} src={`/api/jobs/${job.id}/keyframes/${n}`} alt={n} />
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
