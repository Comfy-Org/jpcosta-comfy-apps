import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadView, extractFiles, runNamedWorkflow, submitWorkflow, uploadImage, waitForJob } from "./comfy";
import {
  applyLogoToLid,
  fillMagentaWithCardboard,
  maskFromMagenta,
  nestProduct,
  padTo916,
  publicPresetPath,
} from "./composite";
import { jobDir, patchJob } from "./jobs";
import { h3Prompt, LTX_BEATS, ltxPairPrompt, liftPrompt, nestPrompt, rotatePrompt, tablePrompt } from "./prompts";
import { getPreset } from "./presets";
import type { BoxId, EditEngine, PipelineMode } from "./types";
import { loadWorkflow, setInput } from "./workflows";

export type PipelineInput = {
  jobId: string;
  boxId: BoxId;
  mode: PipelineMode;
  editEngine: EditEngine;
  photos: { absPath: string; filename: string }[];
  logoPath?: string;
};

function work(jobId: string, ...parts: string[]): string {
  return path.join(jobDir(jobId), ...parts);
}

async function cutoutPhoto(jobId: string, localPath: string, index: number): Promise<string> {
  const uploaded = await uploadImage(await readFile(localPath), `prod_${index}${path.extname(localPath) || ".png"}`);
  const destDir = work(jobId, "work");
  const { files } = await runNamedWorkflow(
    "product_cutout",
    (wf) => {
      setInput(wf, "1", "image", uploaded);
      setInput(wf, "6", "filename_prefix", `ou_${jobId.slice(0, 8)}_cut_${index}`);
    },
    destDir,
  );
  if (!files[0]) throw new Error(`cutout ${index} produced no image`);
  const dest = work(jobId, "work", `cutout_${index}.png`);
  await copyFile(files[0], dest);
  return dest;
}

async function editKeyframe(opts: {
  jobId: string;
  engine: EditEngine;
  sourcePath: string;
  productPath?: string;
  prompt: string;
  seed: number;
  name: string;
}): Promise<string> {
  const srcName = await uploadImage(await readFile(opts.sourcePath), `${opts.name}_src.png`);
  let productName: string | undefined;
  if (opts.productPath) {
    productName = await uploadImage(await readFile(opts.productPath), `${opts.name}_prod.png`);
  }
  const destDir = work(opts.jobId, "work");
  if (opts.engine === "qwen") {
    const { files } = await runNamedWorkflow(
      "qwen_image_edit_2511",
      (wf) => {
        setInput(wf, "10", "image", srcName);
        setInput(wf, "31", "prompt", opts.prompt);
        setInput(wf, "40", "seed", opts.seed);
        setInput(wf, "51", "filename_prefix", `ou_${opts.name}`);
      },
      destDir,
    );
    if (!files[0]) throw new Error(`qwen edit ${opts.name} produced no image`);
    const dest = work(opts.jobId, "out", `${opts.name}.png`);
    await copyFile(files[0], dest);
    return dest;
  }
  const { files } = await runNamedWorkflow(
    "flux3_image_edit",
    (wf) => {
      setInput(wf, "10", "image", srcName);
      if (productName) setInput(wf, "11", "image", productName);
      const node = wf["1"];
      const inputs = (node.inputs ?? {}) as Record<string, unknown>;
      inputs.prompt = opts.prompt;
      inputs.seed = opts.seed;
      // Autogrow inputs must be flat "images.image_N" keys. A nested `images`
      // object is silently ignored and FLUX runs text-only (it invents a product).
      for (const key of Object.keys(inputs)) {
        if (key === "images" || key.startsWith("images.")) delete inputs[key];
      }
      inputs["images.image_1"] = ["10", 0];
      if (productName) inputs["images.image_2"] = ["11", 0];
      else delete wf["11"];
      node.inputs = inputs;
      setInput(wf, "2", "filename_prefix", `ou_${opts.name}`);
    },
    destDir,
  );
  if (!files[0]) throw new Error(`flux3 edit ${opts.name} produced no image`);
  const dest = work(opts.jobId, "out", `${opts.name}.png`);
  await copyFile(files[0], dest);
  return dest;
}

async function ltxClip(opts: {
  jobId: string;
  first: string;
  last: string;
  prompt: string;
  seed: number;
  name: string;
}): Promise<string> {
  const a = await uploadImage(await readFile(opts.first), `${opts.name}_a.png`);
  const b = await uploadImage(await readFile(opts.last), `${opts.name}_b.png`);
  const destDir = work(opts.jobId, "work");
  const { files } = await runNamedWorkflow(
    "ltx25_flf2v",
    (wf) => {
      setInput(wf, "10", "image", a);
      setInput(wf, "11", "image", b);
      setInput(wf, "20", "prompt", opts.prompt);
      setInput(wf, "20", "seed", opts.seed);
      setInput(wf, "20", "model", "LTX-2.5 (Fast)");
      setInput(wf, "20", "model.duration", "3");
      setInput(wf, "20", "model.resolution", "720x1280");
      setInput(wf, "20", "model.fps", "24");
      setInput(wf, "20", "model.generate_audio", true);
      setInput(wf, "30", "filename_prefix", `ou_${opts.name}`);
    },
    destDir,
  );
  const video = files.find((f) => f.endsWith(".mp4")) ?? files[0];
  if (!video) throw new Error(`ltx ${opts.name} produced no video`);
  const dest = work(opts.jobId, "out", `${opts.name}.mp4`);
  await copyFile(video, dest);
  return dest;
}

async function concatRife(opts: { jobId: string; clips: string[] }): Promise<string> {
  const destDir = work(opts.jobId, "work");
  const names: string[] = [];
  for (const [i, c] of opts.clips.entries()) {
    names.push(await uploadImage(await readFile(c), `clip_${i}.mp4`));
  }
  const { files } = await runNamedWorkflow(
    "concat_rife",
    (wf) => {
      const videos: Record<string, [string, number]> = {};
      for (let i = 0; i < names.length; i++) {
        const id = String(10 + i);
        setInput(wf, id, "file", names[i]);
        videos[`video${i}`] = [id, 0];
      }
      for (let i = names.length; i < 4; i++) {
        delete wf[String(10 + i)];
      }
      const node = wf["20"];
      const inputs = (node.inputs ?? {}) as Record<string, unknown>;
      inputs.videos = videos;
      node.inputs = inputs;
      setInput(wf, "70", "filename_prefix", `ou_${opts.jobId.slice(0, 8)}`);
    },
    destDir,
  );
  const video = files.find((f) => f.endsWith(".mp4")) ?? files[0];
  if (!video) throw new Error("concat_rife produced no video");
  const dest = work(opts.jobId, "out", "unboxing.mp4");
  await copyFile(video, dest);
  return dest;
}

async function h3Video(opts: {
  jobId: string;
  refs: string[];
  prompt: string;
  seed: number;
}): Promise<string> {
  const names: string[] = [];
  for (const [i, p] of opts.refs.entries()) {
    names.push(await uploadImage(await readFile(p), `h3_ref_${i}.png`));
  }
  const wf = (await loadWorkflow("minimax_h3_r2v")) as Record<string, Record<string, unknown>>;
  // Rebuild loaders for however many refs we have (up to 9).
  const loaders: string[] = [];
  for (let i = 0; i < Math.min(names.length, 9); i++) {
    const id = String(10 + i);
    wf[id] = {
      class_type: "LoadImage",
      inputs: { image: names[i] },
    };
    loaders.push(id);
  }
  const images: Record<string, [string, number]> = {};
  loaders.forEach((id, i) => {
    images[`image_${i + 1}`] = [id, 0];
  });
  setInput(wf, "20", "seed", opts.seed);
  setInput(wf, "20", "model", "MiniMax H3 Max");
  setInput(wf, "20", "model.prompt", opts.prompt);
  setInput(wf, "20", "model.resolution", "768P");
  setInput(wf, "20", "model.ratio", "9:16");
  setInput(wf, "20", "model.duration", 6);
  setInput(wf, "20", "model.prompt_expansion_mode", "balanced");
  setInput(wf, "20", "model.reference_detail", "standard");
  // Autogrow slots under a DynamicCombo are flat keys: "model.reference_images.image_N".
  const h3 = (wf["20"].inputs ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(h3)) {
    if (key.startsWith("model.reference_images")) delete h3[key];
  }
  for (const [key, link] of Object.entries(images)) h3[`model.reference_images.${key}`] = link;
  setInput(wf, "30", "filename_prefix", `ou_h3_${opts.jobId.slice(0, 8)}`);
  const promptId = await submitWorkflow(wf);
  await patchJob(opts.jobId, "animate", "MiniMax H3 Max is generating native-audio unboxing.", { }, promptId);
  const hist = await waitForJob(promptId);
  const listed = extractFiles(hist);
  const destDir = work(opts.jobId, "work");
  await mkdir(destDir, { recursive: true });
  const saved: string[] = [];
  for (const [i, file] of listed.entries()) {
    const dest = path.join(destDir, `h3_${i}_${path.basename(file.filename)}`);
    await downloadView(file, dest);
    saved.push(dest);
  }
  const video = saved.find((f) => f.endsWith(".mp4")) ?? saved[0];
  if (!video) throw new Error("H3 produced no video");
  const dest = work(opts.jobId, "out", "unboxing.mp4");
  await copyFile(video, dest);
  return dest;
}

export async function runPipeline(input: PipelineInput): Promise<void> {
  const { jobId } = input;
  try {
    await patchJob(jobId, "uploading", `Uploading ${input.photos.length} product stills.`);
    const preset = getPreset(input.boxId);
    const emptySrc = await publicPresetPath(preset.empty);
    const lidSrc = await publicPresetPath(preset.lidOn);

    await patchJob(jobId, "cutout", "Cutting the product off its studio backdrop.");
    const cutouts: string[] = [];
    // Hero is photo 0; cut all stills so H3 can use identity refs.
    for (let i = 0; i < input.photos.length; i++) {
      cutouts.push(await cutoutPhoto(jobId, input.photos[i].absPath, i));
      await patchJob(jobId, "cutout", `Cutout ${i + 1}/${input.photos.length} ready.`);
    }
    const hero = cutouts[0];

    await patchJob(jobId, "composite", "Fitting the product into the insert well.");
    const magenta = await maskFromMagenta(emptySrc);
    const maskDest = work(jobId, "out", "insert_mask.png");
    await writeFile(maskDest, magenta.maskPng);
    const emptyClean = work(jobId, "work", "empty_clean.png");
    await fillMagentaWithCardboard(emptySrc, emptyClean);
    const nestedRaw = work(jobId, "work", "nested_raw.png");
    await nestProduct({
      emptyPath: emptyClean,
      productCutoutPath: hero,
      dest: nestedRaw,
      insert: magenta.rect,
      logoPath: input.logoPath,
    });

    let lidPlate = lidSrc;
    if (input.logoPath) {
      const lidLogo = work(jobId, "work", "lid_logo.png");
      await applyLogoToLid({ lidPath: lidSrc, logoPath: input.logoPath, dest: lidLogo });
      lidPlate = lidLogo;
    }

    await patchJob(jobId, "keyframes", "Painting 5 overhead keyframes (sealed → table).");
    const kfSealed = work(jobId, "out", "kf0_sealed.png");
    await copyFile(lidPlate, kfSealed);

    const kfNested = await editKeyframe({
      jobId,
      engine: input.editEngine,
      sourcePath: nestedRaw,
      productPath: hero,
      prompt: nestPrompt(),
      seed: 101,
      name: "kf1_nested",
    });
    const kfLift = await editKeyframe({
      jobId,
      engine: input.editEngine,
      sourcePath: kfNested,
      productPath: hero,
      prompt: liftPrompt(),
      seed: 102,
      name: "kf2_lift",
    });
    const kfRotate = await editKeyframe({
      jobId,
      engine: input.editEngine,
      sourcePath: kfLift,
      productPath: hero,
      prompt: rotatePrompt(),
      seed: 103,
      name: "kf3_rotate",
    });
    const kfTable = await editKeyframe({
      jobId,
      engine: input.editEngine,
      sourcePath: kfRotate,
      productPath: hero,
      prompt: tablePrompt(),
      seed: 104,
      name: "kf4_table",
    });

    const keyframes = [kfSealed, kfNested, kfLift, kfRotate, kfTable];
    const padded: string[] = [];
    for (const [i, kf] of keyframes.entries()) {
      const dest = work(jobId, "work", `kf${i}_916.png`);
      await padTo916(kf, dest);
      padded.push(dest);
    }
    await patchJob(jobId, "keyframes", "Five overhead plates ready.", {
      keyframeRelpaths: keyframes.map((f) => path.relative(process.cwd(), f)),
    });

    if (input.mode === "h3") {
      await patchJob(jobId, "animate", "MiniMax H3 reference-to-video with native ASMR audio.");
      const dest = await h3Video({
        jobId,
        refs: [padded[0], padded[1], hero, ...cutouts.slice(1, 3)],
        prompt: h3Prompt(),
        seed: 2026,
      });
      await patchJob(jobId, "done", "Unboxing is ready.", {
        outputRelpath: path.relative(process.cwd(), dest),
      });
      return;
    }

    await patchJob(jobId, "animate", "LTX 2.5 first-last-frame on each beat pair.");
    const clips: string[] = [];
    for (let i = 0; i < padded.length - 1; i++) {
      const clip = await ltxClip({
        jobId,
        first: padded[i],
        last: padded[i + 1],
        prompt: ltxPairPrompt(LTX_BEATS[i], LTX_BEATS[i + 1]),
        seed: 300 + i,
        name: `clip_${i}`,
      });
      clips.push(clip);
      await patchJob(jobId, "animate", `Clip ${i + 1}/4 ready.`);
    }

    await patchJob(jobId, "concat", "Concatenating LTX clips and RIFE ×2 on the endpoint.");
    const dest = await concatRife({ jobId, clips });

    await patchJob(jobId, "done", "Unboxing is ready.", {
      outputRelpath: path.relative(process.cwd(), dest),
      clipRelpaths: clips.map((f) => path.relative(process.cwd(), f)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await patchJob(jobId, "error", message, { error: message });
  }
}
