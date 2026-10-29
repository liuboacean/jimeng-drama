import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../core/logger.js";
import type { Aspect, Shot } from "../types.js";

const log = logger("compose");

function dims(aspect: Aspect): { w: number; h: number } {
  switch (aspect) {
    case "9:16":
      return { w: 1080, h: 1920 };
    case "16:9":
      return { w: 1920, h: 1080 };
    case "3:4":
      return { w: 1080, h: 1440 };
    case "4:3":
      return { w: 1440, h: 1080 };
    case "21:9":
      return { w: 1680, h: 720 };
    default:
      return { w: 1080, h: 1080 };
  }
}

function run(bin: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function hasAudio(file: string): Promise<boolean> {
  const r = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    file,
  ]);
  return r.code === 0 && r.out.trim().length > 0;
}

/** 统一规格：同分辨率 / 同 fps / 同音频参数，否则 concat 会音画错位 */
export async function normalizeClip(
  input: string,
  output: string,
  aspect: Aspect,
  fps = 30,
): Promise<void> {
  const { w, h } = dims(aspect);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
  const withAudio = await hasAudio(input);
  const args = withAudio
    ? ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", vf,
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-ar", "48000", "-ac", "2", output]
    : ["-hide_banner", "-loglevel", "error", "-y", "-i", input,
       "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-vf", vf,
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", output];
  const r = await run("ffmpeg", args);
  if (r.code !== 0) throw new Error(`规格统一失败 ${input}: ${r.err.slice(0, 300)}`);
}

export function buildSrt(shots: Shot[]): string {
  const fmt = (s: number): string => {
    const hh = Math.floor(s / 3600).toString().padStart(2, "0");
    const mm = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    const ms = Math.round((s - Math.floor(s)) * 1000).toString().padStart(3, "0");
    return `${hh}:${mm}:${ss},${ms}`;
  };
  let cursor = 0;
  let idx = 1;
  const blocks: string[] = [];
  for (const shot of shots) {
    const start = cursor;
    const end = cursor + shot.duration;
    cursor = end;
    if (!shot.dialogue) continue;
    blocks.push(`${idx}\n${fmt(start)} --> ${fmt(end)}\n${shot.dialogue}\n`);
    idx += 1;
  }
  return blocks.join("\n");
}

let filterCache: Set<string> | null = null;

/** 探测 ffmpeg 是否编译了某个滤镜（字幕依赖 libass，多数精简构建没有） */
export async function hasFilter(name: string): Promise<boolean> {
  if (!filterCache) {
    const r = await run("ffmpeg", ["-hide_banner", "-filters"]);
    filterCache = new Set(
      r.out
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((x): x is string => Boolean(x)),
    );
  }
  return filterCache.has(name);
}

export interface ComposeOptions {
  shots: Shot[];
  aspect: Aspect;
  workDir: string;
  finalPath: string;
  /** 硬字幕烧制，需要 ffmpeg 带 libass */
  burnSubtitles: boolean;
  /** 内嵌字幕轨（mov_text），不需要 libass，播放器可开关 */
  softSubtitles: boolean;
  bgm?: string | null;
  bgmVolume?: number;
  /** 整片配音轨（按镜头时间线装配）。给了就替换掉镜头自带音轨 */
  audioTrack?: string | null;
}

export async function composeProject(opts: ComposeOptions): Promise<string> {
  const usable = opts.shots.filter((s) => s.status === "done" && s.output);
  if (usable.length === 0) throw new Error("没有已完成的镜头可拼接");

  await mkdir(opts.workDir, { recursive: true });
  const normalized: string[] = [];
  for (const shot of usable) {
    const out = join(opts.workDir, `${shot.shotId}.norm.mp4`);
    log.info(`统一规格 ${shot.shotId}`);
    await normalizeClip(shot.output as string, out, opts.aspect);
    normalized.push(out);
  }

  const listFile = join(opts.workDir, "concat.txt");
  await writeFile(listFile, normalized.map((p) => `file '${p}'`).join("\n") + "\n", "utf8");

  const wantBurn = opts.burnSubtitles;
  const canBurn = wantBurn && (await hasFilter("subtitles"));
  if (wantBurn && !canBurn) {
    log.warn(
      "当前 ffmpeg 未编译 libass，无法烧制硬字幕，自动改为内嵌软字幕轨。" +
        "需硬字幕请换带 --enable-libass 的 ffmpeg。",
    );
  }
  const wantSoft = !canBurn && (opts.softSubtitles || wantBurn);

  const srt = buildSrt(usable);
  const srtPath = join(opts.workDir, "subs.srt");
  if (srt.length > 0 && (wantBurn || opts.softSubtitles)) {
    await writeFile(srtPath, srt, "utf8");
  }

  const merged = join(opts.workDir, "merged.mp4");
  const concat = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-c", "copy", merged,
  ]);
  if (concat.code !== 0) throw new Error(`拼接失败: ${concat.err.slice(0, 300)}`);

  // 硬字幕
  if (canBurn && srt.length > 0) {
    // force_style 内的逗号必须转义，否则会被 filtergraph 当成滤镜分隔符
    const style = "FontSize=18\\,Alignment=2\\,MarginV=60";
    const vf = `subtitles=filename='${srtPath}':force_style='${style}'`;
    const burn = await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", merged,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy", opts.finalPath,
    ]);
    if (burn.code !== 0) {
      log.warn(`硬字幕烧制失败，回落无字幕: ${burn.err.slice(0, 200)}`);
      const fallback = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", merged, "-c", "copy", opts.finalPath]);
      if (fallback.code !== 0) throw new Error(`成片导出失败: ${fallback.err.slice(0, 300)}`);
    }
  } else {
    // 软字幕 + 配音轨：mov_text 内嵌进 MP4，不依赖 libass
    const hasSubs = wantSoft && srt.length > 0;
    // 有 BGM 才需要中间文件，否则直接写目标路径，省一次整片拷贝
    const target = opts.bgm ? join(opts.workDir, "staged.mp4") : opts.finalPath;

    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-i", merged];
    let nextIdx = 1;
    let audioIdx = 0;
    if (opts.audioTrack) {
      args.push("-i", opts.audioTrack);
      audioIdx = nextIdx;
      nextIdx += 1;
    }
    let subsIdx = -1;
    if (hasSubs) {
      args.push("-i", srtPath);
      subsIdx = nextIdx;
      nextIdx += 1;
    }

    // 显式 -map，不用默认流选择：默认选择会静默丢字幕轨
    args.push("-map", "0:v", "-map", `${audioIdx}:a`);
    if (subsIdx >= 0) args.push("-map", `${subsIdx}:s`);
    args.push("-c:v", "copy");
    if (opts.audioTrack) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
    else args.push("-c:a", "copy");
    if (subsIdx >= 0) args.push("-c:s", "mov_text", "-metadata:s:s:0", "language=chi");
    args.push(target);

    const mux = await run("ffmpeg", args);
    if (mux.code !== 0) {
      log.warn(`音轨/字幕封装失败，回落为纯画面成片: ${mux.err.slice(0, 200)}`);
      const copy = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", merged, "-map", "0", "-c", "copy", target]);
      if (copy.code !== 0) throw new Error(`成片导出失败: ${copy.err.slice(0, 300)}`);
    }
  }

  if (canBurn && opts.bgm) {
    const withBgm = join(opts.workDir, "with-bgm.mp4");
    await mixBgm(opts.finalPath, opts.bgm, withBgm, opts.bgmVolume ?? 0.18);
    const { rename } = await import("node:fs/promises");
    await rename(withBgm, opts.finalPath);
  }

  return opts.finalPath;
}

/** 背景音乐混音：BGM 压低音量、循环铺满、随主片长截断 */
async function mixBgm(
  videoPath: string,
  bgmPath: string,
  outPath: string,
  volume: number,
): Promise<void> {
  const r = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath, "-stream_loop", "-1", "-i", bgmPath,
    "-filter_complex",
    `[1:a]volume=${volume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
    "-map", "0:v", "-map", "[aout]", "-map", "0:s?",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-c:s", "copy",
    "-shortest", outPath,
  ]);
  if (r.code !== 0) throw new Error(`BGM 混音失败: ${r.err.slice(0, 300)}`);
}

/** 抽取末帧，供下一镜首帧续接 */
export async function extractLastFrame(videoPath: string, outPng: string): Promise<void> {
  const r = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-sseof", "-0.2", "-i", videoPath,
    "-vsync", "0", "-q:v", "2", "-frames:v", "1", "-update", "1", outPng,
  ]);
  if (r.code !== 0) throw new Error(`末帧抽取失败: ${r.err.slice(0, 300)}`);
}
