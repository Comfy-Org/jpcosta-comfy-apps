import assert from "node:assert/strict";
import { clientFailureMessage, fetchBlobRetrying, type BlobResponse } from "../src/lib/client-fetch";

async function main() {
  const failed = new TypeError("Failed to fetch");
  assert.equal(
    clientFailureMessage("download", failed),
    "Could not download the finished video (Failed to fetch). Retry the download. This job already finished.",
  );
  assert.match(clientFailureMessage("status", failed), /already submitted/);
  assert.match(clientFailureMessage("submit", failed), /Try again/);
  assert.equal(clientFailureMessage("download", new Error("Job failed: Kling rejected the clip.")), "Job failed: Kling rejected the clip.");
  assert.equal(clientFailureMessage("status", new DOMException("Aborted", "AbortError")), "Aborted");

  const payload = new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]);
  let calls = 0;
  const fetchImpl = async (): Promise<BlobResponse> => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(payload.byteLength), "content-type": "video/mp4" }),
        blob: async () => {
          throw new TypeError("Failed to fetch");
        },
        text: async () => "",
      };
    }
    return new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.byteLength), "content-type": "video/mp4" },
    });
  };
  const read = await fetchBlobRetrying("/api/outputs/reverse-3d~job?sig=test", undefined, fetchImpl, 3, async () => {});
  assert.equal(calls, 2);
  assert.equal(read.blob?.size, payload.byteLength);

  let shortCalls = 0;
  const shortThenFull = async (): Promise<BlobResponse> => {
    shortCalls += 1;
    if (shortCalls === 1) {
      return new Response(payload.slice(0, 3), {
        status: 200,
        headers: { "content-length": String(payload.byteLength), "content-type": "video/mp4" },
      });
    }
    return new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.byteLength), "content-type": "video/mp4" },
    });
  };
  const recovered = await fetchBlobRetrying("/api/outputs/same", undefined, shortThenFull, 3, async () => {});
  assert.equal(shortCalls, 2);
  assert.equal(recovered.blob?.size, payload.byteLength);

  let httpCalls = 0;
  const httpError = async (): Promise<BlobResponse> => {
    httpCalls += 1;
    return new Response(JSON.stringify({ error: { message: "Output not found." } }), { status: 404 });
  };
  const missing = await fetchBlobRetrying("/api/outputs/missing", undefined, httpError, 3, async () => {});
  assert.equal(httpCalls, 1);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.blob, null);

  const controller = new AbortController();
  controller.abort();
  let abortCalls = 0;
  await assert.rejects(
    () =>
      fetchBlobRetrying(
        "/api/outputs/abort",
        { signal: controller.signal },
        async () => {
          abortCalls += 1;
          throw new TypeError("Failed to fetch");
        },
        3,
        async () => {},
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCalls, 0);
  console.log("client-fetch-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
