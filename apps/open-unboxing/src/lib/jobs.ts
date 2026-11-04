import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BoxId, EditEngine, JobEvent, JobRecord, JobStage, PipelineMode } from "./types";

const DATA = path.join(process.cwd(), ".data", "jobs");

export function jobDir(id: string): string {
  return path.join(DATA, id);
}

function recordPath(id: string): string {
  return path.join(jobDir(id), "job.json");
}

export async function createJob(input: {
  boxId: BoxId;
  mode: PipelineMode;
  editEngine: EditEngine;
  photoCount: number;
  hasLogo: boolean;
}): Promise<JobRecord> {
  const id = randomUUID();
  const now = Date.now();
  const rec: JobRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    stage: "queued",
    mode: input.mode,
    editEngine: input.editEngine,
    boxId: input.boxId,
    photoCount: input.photoCount,
    hasLogo: input.hasLogo,
    events: [{ t: now, stage: "queued", message: "Job accepted." }],
  };
  await mkdir(path.join(jobDir(id), "inputs"), { recursive: true });
  await mkdir(path.join(jobDir(id), "work"), { recursive: true });
  await mkdir(path.join(jobDir(id), "out"), { recursive: true });
  await writeFile(recordPath(id), JSON.stringify(rec, null, 2));
  return rec;
}

export async function readJob(id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(recordPath(id), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export async function patchJob(
  id: string,
  stage: JobStage,
  message: string,
  extra: Partial<JobRecord> = {},
  promptId?: string,
): Promise<JobRecord> {
  const rec = await readJob(id);
  if (!rec) throw new Error(`unknown job ${id}`);
  const event: JobEvent = { t: Date.now(), stage, message, promptId };
  rec.stage = stage;
  rec.updatedAt = event.t;
  rec.events.push(event);
  if (extra.error) rec.error = extra.error;
  if (extra.outputRelpath) rec.outputRelpath = extra.outputRelpath;
  if (extra.keyframeRelpaths) rec.keyframeRelpaths = extra.keyframeRelpaths;
  if (extra.clipRelpaths) rec.clipRelpaths = extra.clipRelpaths;
  await writeFile(recordPath(id), JSON.stringify(rec, null, 2));
  return rec;
}
