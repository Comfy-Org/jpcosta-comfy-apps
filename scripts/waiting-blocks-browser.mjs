import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

mkdirSync("/opt/cursor/artifacts", { recursive: true });
const version = await fetch("http://127.0.0.1:9224/json/version").then((r) => r.json());
const browser = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  browser.addEventListener("open", resolve);
  browser.addEventListener("error", reject);
});
let next = 1;
const pending = new Map();
const requests = [];
browser.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
function send(method, params = {}, sessionId) {
  const id = next++;
  browser.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
browser.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Network.requestWillBeSent" && message.params?.request?.url) {
    requests.push(message.params.request.url);
  }
});
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: "file:///opt/cursor/artifacts/avengers-waiting.html" }, sessionId);

async function value(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1200));
  return result.result.value;
}
async function shot(name, canvasOnly = false) {
  await new Promise((r) => setTimeout(r, 120));
  let clip;
  if (canvasOnly) {
    const rect = await value(`(() => { const r = document.getElementById('view').getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height}; })()`);
    clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", { format: "png", clip }, sessionId);
  writeFileSync(`/opt/cursor/artifacts/${name}`, Buffer.from(data, "base64"));
  console.log("shot", name);
}

for (let i = 0; i < 80; i += 1) {
  const ready = await value("document.body && document.body.dataset.ready || ''");
  if (ready === "1") break;
  if (i === 79) throw new Error(await value("document.body ? document.body.innerText.slice(0,300) : 'no body'"));
  await new Promise((r) => setTimeout(r, 150));
}

const samples = [];
for (let i = 0; i < 4; i += 1) {
  samples.push(Number(await value("document.body.dataset.instances")));
  await new Promise((r) => setTimeout(r, 280));
}
console.log("live growth", samples);
if (!(samples[3] > samples[0])) throw new Error("instance count did not grow");

const beforeDrag = await value("document.body.dataset.camera");
const box = await value(`(() => { const r = document.getElementById('view').getBoundingClientRect(); return {x:r.x+r.width*0.55, y:r.y+r.height*0.5}; })()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 140, y: box.y - 30, button: "left" }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 140, y: box.y - 30, button: "left", clickCount: 1 }, sessionId);
await new Promise((r) => setTimeout(r, 200));
const afterDrag = await value("document.body.dataset.camera");
console.log("orbit", beforeDrag, "->", afterDrag, "instances", await value("document.body.dataset.instances"));
if (beforeDrag === afterDrag) throw new Error("orbit did not move the camera");

const beforeZoom = afterDrag;
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -400 }, sessionId);
await new Promise((r) => setTimeout(r, 200));
const afterZoom = await value("document.body.dataset.camera");
console.log("zoom", beforeZoom, "->", afterZoom);
if (beforeZoom === afterZoom) throw new Error("zoom did not change");

const countBeforeReset = Number(await value("document.body.dataset.instances"));
await value("document.getElementById('reset').click()");
await new Promise((r) => setTimeout(r, 150));
const afterReset = await value("[document.body.dataset.camera, document.body.dataset.instances, document.body.dataset.job].join('|')");
console.log("reset", afterReset);
if (!afterReset.startsWith("0.000,0.000,1.000")) throw new Error("reset did not restore the camera");
if (Number(afterReset.split("|")[1]) < countBeforeReset) throw new Error("reset cleared the assembly");

await value("window.__waiting.jump(2200)");
await shot("waiting-early.png");
await shot("waiting-early-canvas.png", true);
const early = await value("[document.body.dataset.instances, document.body.dataset.job, document.body.dataset.assembly, document.getElementById('watch').hidden].join('|')");
console.log("early", early);

await value("window.__waiting.jump(264 * 24 + 2400)");
await shot("waiting-mid.png");
await shot("waiting-mid-canvas.png", true);
console.log("mid", await value("[document.body.dataset.instances, document.body.dataset.blocks, document.body.dataset.job, document.body.dataset.assembly].join('|')"));

await value("window.__waiting.jump(3200)");
const cam = await value("document.body.dataset.camera");
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x - 90, y: box.y + 20, button: "left" }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x - 90, y: box.y + 20, button: "left", clickCount: 1 }, sessionId);
await new Promise((r) => setTimeout(r, 150));
await shot("waiting-orbit.png");
console.log("orbit while building", cam, "->", await value("document.body.dataset.camera"), "job", await value("document.body.dataset.job"));

await value("document.getElementById('reset').click()");
await value("window.__waiting.jump(60000)");
await shot("waiting-assembled-pending.png");
await shot("waiting-assembled-canvas.png", true);
const pendingState = await value("[document.body.dataset.assembly, document.body.dataset.job, document.body.dataset.instances, document.body.dataset.blocks, document.getElementById('watch').hidden, document.getElementById('status-label').textContent].join('|')");
console.log("assembled pending", pendingState);
const text = await value("document.body.innerText");
if (text.includes("%")) throw new Error("visible percent");
if (!text.includes("Gerando vídeo")) throw new Error("missing waiting caption");
if (text.includes("Assistir vídeo")) throw new Error("watch button visible before ready");
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 160, y: box.y - 40, button: "left" }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 160, y: box.y - 40, button: "left", clickCount: 1 }, sessionId);
await new Promise((r) => setTimeout(r, 150));
await shot("waiting-side.png", true);
await value("document.getElementById('reset').click()");

const meshesBefore = await value("document.body.dataset.meshes");
await value("document.getElementById('restart').click(); window.__waiting.jump(400)");
const restarted = await value("[document.body.dataset.instances, document.body.dataset.assembly, document.body.dataset.job, document.body.dataset.meshes].join('|')");
console.log("restart", restarted, "meshes before", meshesBefore);
if (Number(restarted.split("|")[0]) > 40) throw new Error("restart did not rewind the assembly");
if (restarted.split("|")[2] !== "pending") throw new Error("restart marked the job");
if (restarted.split("|")[3] !== "1") throw new Error("restart leaked a mesh");

await value("document.getElementById('simulate').click()");
const readyMid = await value("[document.body.dataset.job, document.body.dataset.assembly, document.getElementById('watch').hidden, document.getElementById('status-label').textContent, document.getElementById('film').hidden, document.body.dataset.playing].join('|')");
console.log("ready mid assembly", readyMid);
if (!readyMid.startsWith("ready|building|false|Vídeo pronto|true|0")) throw new Error("ready interrupted or autoplayed: " + readyMid);
await shot("waiting-ready-mid.png");

await value("window.__waiting.jump(60000)");
const stillReady = await value("[document.body.dataset.assembly, document.body.dataset.job, document.getElementById('film').hidden].join('|')");
console.log("done after ready", stillReady);
if (stillReady !== "done|ready|true") throw new Error("finishing the assembly changed playback");

const beforePlayCamera = await value("document.body.dataset.camera");
await value("document.getElementById('watch').click()");
await new Promise((r) => setTimeout(r, 800));
const playback = await value("[document.getElementById('film').hidden, document.getElementById('film').videoWidth, document.getElementById('film').readyState, document.getElementById('film').currentSrc.split('/').pop(), document.body.dataset.playing, document.body.dataset.camera].join('|')");
console.log("playback", playback);
if (!playback.startsWith("false|1280|")) throw new Error("cached video did not load: " + playback);
if (playback.split("|")[4] !== "1") throw new Error("play flag missing");
await value("document.getElementById('film').scrollIntoView({block:'center'})");
await shot("waiting-video.png");
await value("document.getElementById('view').scrollIntoView({block:'center'})");
const boxAfter = await value(`(() => { const r = document.getElementById('view').getBoundingClientRect(); return {x:r.x+r.width*0.55, y:r.y+r.height*0.5}; })()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: boxAfter.x, y: boxAfter.y, button: "left", clickCount: 1 }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: boxAfter.x + 70, y: boxAfter.y - 16, button: "left" }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: boxAfter.x + 70, y: boxAfter.y - 16, button: "left", clickCount: 1 }, sessionId);
await new Promise((r) => setTimeout(r, 150));
const afterPlayDrag = await value("document.body.dataset.camera");
console.log("drag after ready", beforePlayCamera, "->", afterPlayDrag);
if (beforePlayCamera === afterPlayDrag) throw new Error("ready or playback froze the orbit");

await value("document.getElementById('restart').click(); window.__waiting.jump(0)");
const leaked = await value("[document.body.dataset.meshes, document.querySelectorAll('video').length, document.querySelectorAll('canvas').length, document.body.dataset.instances, document.body.dataset.job].join('|')");
console.log("after second restart", leaked);
if (leaked !== "1|1|1|0|ready") throw new Error("leak or job reset: " + leaked);

const apiCalls = requests.filter((url) => url.includes("/api/") || url.startsWith("http"));
console.log("network", apiCalls);

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
await value("document.getElementById('reset').click(); window.__waiting.jump(60000)");
await new Promise((r) => setTimeout(r, 250));
const narrow = await value(`(() => { const r = document.getElementById('view').getBoundingClientRect(); return [Math.round(r.width), Math.round(document.documentElement.scrollWidth), document.getElementById('status-label').textContent, document.getElementById('watch').hidden].join('|'); })()`);
console.log("narrow", narrow);
if (Number(narrow.split("|")[0]) > 390) throw new Error("canvas wider than the phone");
if (Number(narrow.split("|")[1]) > 410) throw new Error("page overflows the phone");
await shot("waiting-narrow.png");

const earlyPng = await sharp("/opt/cursor/artifacts/waiting-early-canvas.png").resize(480, 270).png().toBuffer();
const midPng = await sharp("/opt/cursor/artifacts/waiting-mid-canvas.png").resize(480, 270).png().toBuffer();
const fullPng = await sharp("/opt/cursor/artifacts/waiting-assembled-canvas.png").resize(480, 270).png().toBuffer();
const tiles = [earlyPng, midPng, fullPng];
const labels = ["Início", "A meio", "Montada, vídeo ainda à espera"];
const composed = [];
for (let i = 0; i < 3; i += 1) {
  const label = Buffer.from(`<svg width="480" height="28"><rect width="480" height="28" fill="#f6f3ee"/><text x="8" y="18" font-family="sans-serif" font-size="14" fill="#241c22">${labels[i]}</text></svg>`);
  composed.push(await sharp({ create: { width: 480, height: 298, channels: 3, background: "#f6f3ee" } }).composite([{ input: tiles[i], top: 0, left: 0 }, { input: label, top: 270, left: 0 }]).png().toBuffer());
}
await sharp({ create: { width: 480 * 3 + 16, height: 298, channels: 3, background: "#f6f3ee" } })
  .composite(composed.map((input, index) => ({ input, left: index * 488, top: 0 })))
  .png()
  .toFile("/opt/cursor/artifacts/waiting-comparison-strip.png");
console.log("strip written");

await send("Target.closeTarget", { targetId });
browser.close();
