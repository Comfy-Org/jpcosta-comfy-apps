import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bundled = await build({
  absWorkingDir: dir,
  entryPoints: ["viewer.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  alias: { three: path.resolve(dir, "../block-glb-viewer/vendor/three.module.js") },
  write: false,
  legalComments: "none",
});
const rgb = readFileSync("/tmp/avengers-25d/main-rgb.png").toString("base64");
const depth = readFileSync("/tmp/avengers-25d/main-depth.png").toString("base64");
const page = readFileSync(path.join(dir, "index.html"), "utf8")
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/u, "")
  .replace(
    '<script type="module" src="./viewer.js"></script>',
    "<script>\nwindow.__WAITING_RGB = \"data:image/png;base64," +
      rgb +
      "\";\nwindow.__WAITING_DEPTH = \"data:image/png;base64," +
      depth +
      "\";\n</script>\n<script>\n" +
      bundled.outputFiles[0].text +
      "\n</script>",
  );
const targets = [
  "/opt/cursor/artifacts/avengers-waiting.html",
  path.join(dir, "avengers-waiting.html"),
];
mkdirSync("/opt/cursor/artifacts", { recursive: true });
for (const target of targets) writeFileSync(target, page);
const videoName = "avengers-kling-cached.mp4";
copyFileSync(path.join(dir, videoName), path.join("/opt/cursor/artifacts", videoName));
console.log("standalone bytes", page.length);
