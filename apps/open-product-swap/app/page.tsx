"use client";

import { DropZone } from "@/components/DropZone";
import type { ClientJob, SkuDraft } from "@/lib/client-types";
import type { ComfyOutputFile, PipelineId } from "@/lib/types";
import { PIPELINES } from "@/lib/types";
const DEFAULT_PROMPT =
  "A person holds the replacement product. Photorealistic, original lighting, hands and motion unchanged.";
const DEFAULT_MASK_OBJECT =
  "product in the person's hand, bottle, can, box, cup, phone";
import { useCallback, useEffect, useMemo, useState } from "react";

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileUrl(file: ComfyOutputFile) {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || "",
    type: file.type || "output",
  });
  if (file.id) params.set("id", file.id);
  return `/api/jobs/x/file?${params.toString()}`;
}

function isVideoFile(file: ComfyOutputFile) {
  const name = file.filename || "";
  const kind = `${file.type || ""} ${file.format || ""}`;
  return (
    /\.(mp4|webm|mov|mkv)$/i.test(name) ||
    name.includes("video/") ||
    /video/i.test(kind)
  );
}

export default function HomePage() {
  const [video, setVideo] = useState<{ file: File; url: string } | null>(null);
  const [skus, setSkus] = useState<SkuDraft[]>([
    { id: uid("sku"), name: "SKU 01", photos: [] },
  ]);
  const [pipeline, setPipeline] = useState<PipelineId>("ltx");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maskObject, setMaskObject] = useState(DEFAULT_MASK_OBJECT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [cloud, setCloud] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { cloud?: string | null; hasKey?: boolean; base?: string }) => {
        if (d.cloud) setCloud(d.cloud);
        else if (d.hasKey && d.base) {
          try {
            setCloud(new URL(d.base).host);
          } catch {
            setCloud("ok");
          }
        } else setCloud(null);
      })
      .catch(() => setCloud(null));
  }, []);

  useEffect(() => {
    const pending = jobs.filter((j) => j.status === "queued" || j.status === "running");
    if (!pending.length) return;
    const timer = window.setInterval(async () => {
      for (const job of pending) {
        try {
          const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
          const data = await res.json();
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id
                ? {
                    ...j,
                    status: data.status ?? j.status,
                    progress: data.progress,
                    message: data.message,
                    error: data.error,
                    outputs: data.outputs ?? j.outputs,
                  }
                : j,
            ),
          );
        } catch {
          /* keep polling */
        }
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  const addSku = () => {
    if (skus.length >= 8) return;
    setSkus((prev) => [
      ...prev,
      { id: uid("sku"), name: `SKU ${String(prev.length + 1).padStart(2, "0")}`, photos: [] },
    ]);
  };

  const onVideo = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;
    setVideo((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file) };
    });
  }, []);

  const ready = Boolean(video) && skus.some((s) => s.photos.length > 0);

  const queue = async () => {
    if (!video) return;
    const filled = skus.filter((s) => s.photos.length > 0);
    if (!filled.length) {
      setError("Add at least one SKU photo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("video", video.file, video.file.name);
      form.append("pipeline", pipeline);
      form.append("prompt", prompt);
      form.append("maskObject", maskObject);
      form.append(
        "skus",
        JSON.stringify(filled.map((s) => ({ id: s.id, name: s.name }))),
      );
      for (const sku of filled) {
        for (const photo of sku.photos) {
          form.append(`sku_${sku.id}`, photo.file, photo.file.name);
        }
      }
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submit failed");
      const created = (data.jobs as ClientJob[]).map((j) => ({
        ...j,
        status: "queued" as const,
        outputs: [],
      }));
      setJobs((prev) => [...created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  const pipelineMeta = useMemo(
    () => PIPELINES.find((p) => p.id === pipeline)!,
    [pipeline],
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-[color:var(--paper)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-gold text-sm font-bold text-gold-ink">
              ⊘
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Open Product Swap</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                MIT · Comfy Build · Open weights path
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-3 text-xs text-muted sm:flex">
            <span className="rounded-full border border-line bg-panel px-2 py-1">
              Higgsfield Genjutsu, opened
            </span>
            {cloud ? (
              <span className="font-mono">cloud {cloud}</span>
            ) : (
              <span className="font-mono">set COMFY_API_KEY</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-5">
          <div className="panel p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-blue">
                  Node 1 · Source
                </div>
                <h2 className="text-lg font-semibold">Person holding a product</h2>
              </div>
              {video ? (
                <button
                  className="text-xs text-muted underline"
                  onClick={() => {
                    URL.revokeObjectURL(video.url);
                    setVideo(null);
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {video ? (
              <video
                src={video.url}
                controls
                className="aspect-video w-full rounded-xl bg-black object-contain"
              />
            ) : (
              <DropZone
                accept="video/mp4,video/webm,video/quicktime"
                label="Drop a short clip here"
                hint="MP4 or WebM · a few seconds of someone holding the current product"
                accent="blue"
                onFiles={onVideo}
              />
            )}
          </div>

          <div className="panel p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-rust">
                  Node 6 · Batch SKUs
                </div>
                <h2 className="text-lg font-semibold">Your products</h2>
              </div>
              <button
                onClick={addSku}
                className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium hover:bg-paper-2"
              >
                Add SKU
              </button>
            </div>
            <p className="mb-4 text-sm text-muted">
              One source clip × many SKUs. Each SKU takes 1–5 photos. Queue runs a job per SKU.
            </p>
            <div className="space-y-3">
              {skus.map((sku) => (
                <article key={sku.id} className="rounded-xl border border-line bg-white p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      value={sku.name}
                      onChange={(e) =>
                        setSkus((prev) =>
                          prev.map((s) => (s.id === sku.id ? { ...s, name: e.target.value } : s)),
                        )
                      }
                      className="w-full rounded-md border border-line bg-panel px-2 py-1 text-sm"
                    />
                    {skus.length > 1 ? (
                      <button
                        className="text-xs text-muted"
                        onClick={() => setSkus((prev) => prev.filter((s) => s.id !== sku.id))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {sku.photos.map((photo) => (
                      <div key={photo.id} className="relative">
                        <img
                          src={photo.url}
                          alt=""
                          className="h-20 w-20 rounded-lg object-cover"
                        />
                        <button
                          className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink text-[10px] text-white"
                          onClick={() =>
                            setSkus((prev) =>
                              prev.map((s) =>
                                s.id === sku.id
                                  ? {
                                      ...s,
                                      photos: s.photos.filter((p) => p.id !== photo.id),
                                    }
                                  : s,
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {sku.photos.length < 5 ? (
                      <div className="h-20 w-36">
                        <DropZone
                          accept="image/png,image/jpeg,image/webp"
                          multiple
                          compact
                          accent="rust"
                          label="Drop photos"
                          hint={`${sku.photos.length}/5`}
                          onFiles={(files) => {
                            setSkus((prev) =>
                              prev.map((s) => {
                                if (s.id !== sku.id) return s;
                                const room = 5 - s.photos.length;
                                const next = files.slice(0, room).map((file) => ({
                                  id: uid("img"),
                                  file,
                                  url: URL.createObjectURL(file),
                                }));
                                return { ...s, photos: [...s.photos, ...next] };
                              }),
                            );
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Graph · editable in /workflows
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {PIPELINES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPipeline(p.id)}
                  className={`rounded-xl border p-3 text-left transition ${
                    pipeline === p.id
                      ? "border-gold bg-[#fff8df]"
                      : "border-line bg-white hover:bg-paper-2"
                  }`}
                >
                  <div className="text-sm font-semibold">{p.label}</div>
                  <div className="mt-1 text-xs text-muted">{p.blurb}</div>
                </button>
              ))}
            </div>
            <label className="mt-4 block text-xs font-medium text-muted">Mask object</label>
            <input
              value={maskObject}
              onChange={(e) => setMaskObject(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            />
            <label className="mt-3 block text-xs font-medium text-muted">Swap prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            />
          </div>
        </section>

        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <div className="panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Queue
            </div>
            <p className="mt-2 text-sm text-muted">
              {pipelineMeta.label}. Hands, motion and lighting stay from the source clip.
            </p>
            <button
              disabled={!ready || busy}
              onClick={queue}
              className="mt-4 w-full rounded-xl bg-gold px-4 py-3 text-sm font-semibold text-gold-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Uploading to Comfy Cloud…" : "Queue swap"}
            </button>
            {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
            <p className="mt-3 font-mono text-[11px] text-muted">
              SAM3 mask → FLUX 3 keyframe → {pipeline === "ltx" ? "LTX-2.3" : "Wan VACE"}
            </p>
          </div>

          <div className="panel p-5">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Jobs
            </div>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted">Nothing queued yet.</p>
            ) : (
              <ul className="space-y-3">
                {jobs.map((job) => (
                  <li key={job.id} className="rounded-xl border border-line bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{job.skuName}</div>
                      <StatusPill status={job.status} />
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-muted">{job.id}</div>
                    {job.message ? (
                      <div className="mt-1 text-xs text-muted">{job.message}</div>
                    ) : null}
                    {job.error ? (
                      <div className="mt-1 text-xs text-danger">{job.error}</div>
                    ) : null}
                    {job.outputs.length ? (
                      <div className="mt-2 space-y-2">
                        {job.outputs.map((file) =>
                          isVideoFile(file) ? (
                            <video
                              key={file.id || file.filename}
                              src={fileUrl(file)}
                              controls
                              className="w-full rounded-lg bg-black"
                            />
                          ) : (
                            <img
                              key={file.id || file.filename}
                              src={fileUrl(file)}
                              alt={file.filename}
                              className="w-full rounded-lg"
                            />
                          ),
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function StatusPill({ status }: { status: ClientJob["status"] }) {
  const map: Record<string, string> = {
    queued: "bg-paper-2 text-muted",
    running: "bg-[#fff1c2] text-ink",
    success: "bg-green/15 text-green",
    error: "bg-danger/10 text-danger",
    cancelled: "bg-paper-2 text-muted",
    lost: "bg-danger/10 text-danger",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${map[status]}`}>
      {status}
    </span>
  );
}
