import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bundled = await build({
  absWorkingDir: dir,
  entryPoints: ["viewer.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  alias: { three: path.join(dir, "vendor/three.module.js") },
  write: false,
  legalComments: "none",
});
const page = readFileSync(path.join(dir, "index.html"), "utf8")
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/u, "")
  .replace(
    '<script type="module" src="./viewer.js"></script>',
    "<script>\nwindow.__EMBEDDED_GLB = " +
      JSON.stringify(readFileSync("/tmp/whole-scene/avengers-whole-scene-hunyuan-original.glb").toString("base64")) +
      ";\nwindow.__EMBEDDED_REF = " +
      JSON.stringify(readFileSync("/tmp/whole-scene/avengers-scene-blockout-reference.jpg").toString("base64")) +
      ";\n</script>\n<script>\n" +
      bundled.outputFiles[0].text +
      "\n</script>",
  );
const targets = [
  "/opt/cursor/artifacts/avengers-block-detail.html",
  path.join(dir, "avengers-block-detail.html"),
];
for (const target of targets) writeFileSync(target, page);
console.log("standalone bytes", page.length);
