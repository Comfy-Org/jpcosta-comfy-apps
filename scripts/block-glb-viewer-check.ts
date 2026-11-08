// @ts-nocheck
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVideoReferencePayload } from "../demo/block-glb-viewer/presets.mjs";
import { encodeGlb } from "../src/lib/mesh-reduce.ts";

const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../demo/block-glb-viewer");
const viewerSource = readFileSync(path.join(demo, "viewer.js"), "utf8");
const pageSource = readFileSync(path.join(demo, "index.html"), "utf8");
assert.equal(viewerSource.includes("buildBoxMesh"), false);
assert.equal(viewerSource.includes("simplifyMesh"), false);
assert.equal(viewerSource.includes("GLTFLoader"), true);
assert.equal(pageSource.includes("Blocos cinza"), true);
assert.equal(pageSource.includes("Blocos coloridos"), true);
assert.equal(pageSource.includes("Clay"), true);
assert.equal(pageSource.includes("Guardar referência"), true);
assert.equal(pageSource.includes("Mais simples"), false);

const payload = buildVideoReferencePayload({
  style: "clay",
  referencePng: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  videoName: "original-video",
});
assert.equal(payload.called, false);
assert.equal(payload.fields.style, "clay");
assert.equal(payload.fields.camera, "source-plus-z");
assert.equal(payload.fields.video, "original-video");
assert.equal(payload.fields.referenceImage.byteLength, 32);
assert.throws(() => buildVideoReferencePayload({ style: "detalhe", referencePng: new Uint8Array(32) }));

const positions = new Float32Array([
  -1, 0, 0, 1, 0, 0, 0, 1, 0,
  -1, 0, -1, 1, 0, -1, 0, 1, -1,
]);
const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
const glb = encodeGlb({ positions, indices });
const expectedTriangles = indices.length / 3;

function serve(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname);
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(root)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = readFileSync(file);
      const type = file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream";
      response.writeHead(200, { "Content-Type": type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function chromeResult(pageUrl) {
  const version = await fetch("http://127.0.0.1:9224/json/version").then((response) => response.json());
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browser.addEventListener("open", resolve);
    browser.addEventListener("error", reject);
  });
  let next = 1;
  const pending = new Map();
  browser.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = next++;
    browser.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: pageUrl }, sessionId);
  let text = "";
  for (let i = 0; i < 40; i += 1) {
    const result = await send(
      "Runtime.evaluate",
      { expression: "document.body.dataset.ready + '|' + (document.body.dataset.triangles || '') + '|' + document.getElementById('status').textContent", returnByValue: true },
      sessionId,
    );
    text = result.result.value || "";
    if (text.startsWith("1|")) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await send("Target.closeTarget", { targetId });
  browser.close();
  return text;
}

async function main() {
  const server = await serve(demo);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fixturePath = path.join(demo, "loader-fixture.glb");
  writeFileSync(fixturePath, glb);
  let chromeUp = true;
  try {
    await fetch("http://127.0.0.1:9224/json/version");
  } catch {
    chromeUp = false;
  }
  if (!chromeUp) {
    const chrome = spawn(
      "google-chrome",
      ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=9224", "--user-data-dir=/tmp/chrome-glb-viewer", "--use-gl=angle", "--use-angle=swiftshader", "about:blank"],
      { stdio: "ignore", detached: true },
    );
    chrome.unref();
    for (let i = 0; i < 20; i += 1) {
      try {
        await fetch("http://127.0.0.1:9224/json/version");
        chromeUp = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  assert.equal(chromeUp, true, "Chrome is required for the loader check");
  let text = "";
  try {
    text = await chromeResult(`http://127.0.0.1:${port}/?glb=loader-fixture.glb`);
  } finally {
    server.close();
    try { unlinkSync(fixturePath); } catch { /* already gone */ }
  }
  const [ready, triangles, status] = text.split("|");
  assert.equal(ready, "1", text);
  assert.equal(Number(triangles), expectedTriangles);
  assert.match(status, /Loader fixture/);
  assert.match(status, /not the Hunyuan scene/);
  console.log(`block-glb-viewer-check ok triangles ${triangles}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
