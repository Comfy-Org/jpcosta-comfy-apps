import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { listVisibleAppIds } from "../src/lib/config";
import { decidePublicRequest, isPublicApp } from "../src/lib/public-surface";

// The studio lists every enabled app, Unrender among them.
const catalog = buildCatalog();
assert.deepEqual(
  catalog.map((app) => app.id),
  listVisibleAppIds(),
);
const unrender = catalog.find((app) => app.id === "reverse-3d");
assert.equal(unrender?.name, "Unrender");
assert.ok(catalog.length > 1);

for (const id of listVisibleAppIds()) assert.equal(isPublicApp(id), true, id);
assert.equal(isPublicApp("../secret"), false);

// The studio is the home page; Unrender's old pages land on it.
assert.deepEqual(decidePublicRequest("GET", "/"), { action: "allow" });
assert.deepEqual(decidePublicRequest("GET", "/unrender"), { action: "redirect", location: "/" });
assert.deepEqual(decidePublicRequest("GET", "/unrender/"), { action: "redirect", location: "/" });
assert.deepEqual(decidePublicRequest("GET", "/reverse-3d"), { action: "redirect", location: "/" });
assert.deepEqual(decidePublicRequest("POST", "/api/run/sprite-generator"), { action: "allow" });

console.log("public-surface-check ok");
