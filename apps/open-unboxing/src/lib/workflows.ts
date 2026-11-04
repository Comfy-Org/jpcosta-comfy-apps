import { readFile } from "node:fs/promises";
import path from "node:path";

export function workflowDir(): string {
  return path.join(process.cwd(), "workflows");
}

export async function loadWorkflow(name: string): Promise<Record<string, unknown>> {
  const file = path.join(workflowDir(), name.endsWith(".json") ? name : `${name}.json`);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const { _meta: _drop, ...nodes } = raw;
  return nodes;
}

export function setInput(
  wf: Record<string, Record<string, unknown>>,
  nodeId: string,
  input: string,
  value: unknown,
): void {
  const node = wf[nodeId];
  if (!node) throw new Error(`workflow missing node ${nodeId}`);
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  inputs[input] = value;
  node.inputs = inputs;
}
