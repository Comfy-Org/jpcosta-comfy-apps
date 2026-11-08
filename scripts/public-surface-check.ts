import assert from "node:assert/strict";
import { buildCatalog, buildPublicCatalog } from "../src/lib/catalog";
import { getApp, listAppIds } from "../src/lib/config";
import { saveMockJob } from "../src/lib/mock";
import { decidePublicRequest, isPublicApp } from "../src/lib/public-surface";
import { REVERSE_3D_RENDERS_VIDEO } from "../src/lib/reverse-3d-switch";
import { signAssetId } from "../src/lib/signing";

const jobUuid = "11111111-1111-4111-8111-111111111111";

assert.deepEqual(
  buildPublicCatalog().map((app) => app.id),
  ["reverse-3d"],
);
assert.ok(buildCatalog().every((app) => listAppIds().includes(app.id)));
assert.ok(buildCatalog().length > buildPublicCatalog().length);
assert.equal(isPublicApp("reverse-3d"), true);
for (const id of listAppIds()) {
  if (id === "reverse-3d") continue;
  assert.equal(isPublicApp(id), false, id);
}

assert.deepEqual(decidePublicRequest("GET", "/"), { action: "redirect", location: "/reverse-3d" });
assert.deepEqual(decidePublicRequest("GET", "/reverse-3d/"), { action: "allow" });
assert.equal(decidePublicRequest("HEAD", "/reverse-3d").action, "allow");
assert.equal(decidePublicRequest("POST", "/reverse-3d").action, "deny");
assert.equal(decidePublicRequest("GET", "/sprite-generator").action, "deny");
assert.equal(decidePublicRequest("POST", "/api/run/reverse-3d").action, "allow");
assert.equal(decidePublicRequest("GET", "/api/run/reverse-3d").action, "deny");
assert.equal(decidePublicRequest("POST", "/api/reverse-3d/subject").action, "allow");
assert.equal(decidePublicRequest("GET", "/api/reverse-3d/subject").action, "allow");
assert.equal(decidePublicRequest("PUT", "/api/reverse-3d/subject").action, "deny");
for (const id of listAppIds()) {
  if (isPublicApp(id)) continue;
  assert.equal(decidePublicRequest("POST", `/api/run/${id}`).action, "deny", id);
  assert.equal(decidePublicRequest("GET", `/api/jobs/${id}~${jobUuid}`).action, "deny", id);
  assert.equal(decidePublicRequest("GET", `/api/outputs/${id}~${jobUuid}`).action, "deny", id);
}
assert.equal(decidePublicRequest("GET", `/api/jobs/reverse-3d~${jobUuid}`).action, "allow");
assert.equal(decidePublicRequest("GET", "/api/jobs/reverse-3d~nope").action, "deny");
assert.equal(decidePublicRequest("GET", `/api/jobs/reverse-3d~${jobUuid}/extra`).action, "deny");
assert.equal(decidePublicRequest("GET", `/api/outputs/reverse-3d~${jobUuid}`).action, "allow");
assert.equal(decidePublicRequest("GET", "/api/paparazzi/search").action, "deny");
assert.equal(decidePublicRequest("GET", "/api/paparazzi/scene").action, "deny");
assert.equal(decidePublicRequest("GET", "/presets/kraft_mailer/thumb.jpg").action, "deny");
assert.equal(decidePublicRequest("GET", "/icons/tryon-hanger.png").action, "deny");
assert.equal(decidePublicRequest("GET", "/comfy-logo.svg").action, "deny");
assert.equal(decidePublicRequest("GET", "/_next/static/chunks/app.js").action, "allow");
assert.equal(decidePublicRequest("GET", "/favicon.ico").action, "allow");
assert.equal(decidePublicRequest("GET", "/api/jobs/mock_11111111-1111-4111-8111-111111111111").action, "allow");
assert.equal(decidePublicRequest("GET", "/reverse-3d/../sprite-generator").action, "deny");

async function main() {
const runRoute = await import("../src/app/api/run/[app]/route");
const deniedRun = await runRoute.POST(new Request("http://localhost/api/run/sprite-generator", { method: "POST" }), {
  params: Promise.resolve({ app: "sprite-generator" }),
});
assert.equal(deniedRun.status, 404);
const disabledRun = await runRoute.POST(new Request("http://localhost/api/run/product-relight", { method: "POST" }), {
  params: Promise.resolve({ app: "product-relight" }),
});
assert.equal(disabledRun.status, 404);
const publicRun = await runRoute.POST(new Request("http://localhost/api/run/reverse-3d", { method: "POST" }), {
  params: Promise.resolve({ app: "reverse-3d" }),
});
// While the video is switched off, a real run is refused before the form is read.
assert.equal(publicRun.status, REVERSE_3D_RENDERS_VIDEO ? 400 : 503);

const jobsRoute = await import("../src/app/api/jobs/[id]/route");
const deniedJob = await jobsRoute.GET(new Request(`http://localhost/api/jobs/pumpkin-carve~${jobUuid}`), {
  params: Promise.resolve({ id: `pumpkin-carve~${jobUuid}` }),
});
assert.equal(deniedJob.status, 404);

const outputsRoute = await import("../src/app/api/outputs/[assetId]/route");
const otherOut = `open-unboxing~${jobUuid}`;
const signedOther = await outputsRoute.GET(
  new Request(`http://localhost/api/outputs/${otherOut}?sig=${signAssetId(otherOut)}`),
  { params: Promise.resolve({ assetId: otherOut }) },
);
assert.equal(signedOther.status, 404);
const publicOut = `reverse-3d~${jobUuid}`;
const unsignedPublic = await outputsRoute.GET(new Request(`http://localhost/api/outputs/${publicOut}`), {
  params: Promise.resolve({ assetId: publicOut }),
});
assert.equal(unsignedPublic.status, 404);

const searchRoute = await import("../src/app/api/paparazzi/search/route");
assert.equal((await searchRoute.GET(new Request("http://localhost/api/paparazzi/search?q=Zendaya"))).status, 404);
const sceneRoute = await import("../src/app/api/paparazzi/scene/route");
assert.equal((await sceneRoute.GET(new Request("http://localhost/api/paparazzi/scene?token=nope"))).status, 404);

const relight = getApp("product-relight");
const reverse = getApp("reverse-3d");
if (!relight || !reverse) throw new Error("missing app config");
const hidden = await saveMockJob(relight, "product-relight", { preset: "studio" }, { image: Buffer.from("x") });
const kept = await saveMockJob(reverse, "reverse-3d", { seed: 1 }, {});
const previousMock = process.env.COMFY_MOCK;
process.env.COMFY_MOCK = "1";
try {
  const hiddenJob = await jobsRoute.GET(new Request(`http://localhost/api/jobs/${hidden.id}`), {
    params: Promise.resolve({ id: hidden.id }),
  });
  assert.equal(hiddenJob.status, 404);
  const hiddenOutput = await outputsRoute.GET(
    new Request(`http://localhost/api/outputs/${hidden.outputId}?sig=${signAssetId(hidden.outputId)}`),
    { params: Promise.resolve({ assetId: hidden.outputId }) },
  );
  assert.equal(hiddenOutput.status, 404);
  const keptJob = await jobsRoute.GET(new Request(`http://localhost/api/jobs/${kept.id}`), {
    params: Promise.resolve({ id: kept.id }),
  });
  assert.equal(keptJob.status, 200);
  const keptOutput = await outputsRoute.GET(
    new Request(`http://localhost/api/outputs/${kept.outputId}?sig=${signAssetId(kept.outputId)}`),
    { params: Promise.resolve({ assetId: kept.outputId }) },
  );
  assert.equal(keptOutput.status, 200);
} finally {
  if (previousMock === undefined) delete process.env.COMFY_MOCK;
  else process.env.COMFY_MOCK = previousMock;
}

console.log("public-surface-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
