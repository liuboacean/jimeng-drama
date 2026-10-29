import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, nowIso } from "../core/fsx.js";
import { logger } from "../core/logger.js";
import { pathsFor } from "../core/project.js";
import type { Shot } from "../types.js";

const log = logger("audio");

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

export async function probeDuration(file: string): Promise<number> {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);
  const seconds = Number(r.out.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

const DEFAULT_VOICE = process.env.DRAMA_TTS_VOICE ?? "Tingting";

/** 用 macOS 内置语音合成对白（离线、零成本）。真人有声书可直接放 audio/<shotId>.mp3 覆盖 */
async function synthesize(text: string, outFile: string, voice: string): Promise<void> {
  const aiff = `${outFile}.aiff`;
  const said = await run("say", ["-v", voice, "-o", aiff, text]);
  if (said.code !== 0) {
    throw new Error(`say 合成失败（检查语音 "${voice}" 是否可用）：${said.err.slice(0, 200)}`);
  }
  const converted = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", aiff, "-ar", "48000", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "3", outFile,
  ]);
  if (converted.code !== 0) {
    throw new Error(`音频转码失败：${converted.err.slice(0, 200)}`);
  }
  const { unlink } = await import("node:fs/promises");
  await unlink(aiff).catch(() => undefined);
}

export interface BuildAudioOptions {
  slug: string;
  shots: Shot[];
  voice: string;
  /** 音频比镜头长时，自动把镜头时长拉长到音频长度（上限 30s） */
  fitDuration: boolean;
  dryRun: boolean;
}

export interface BuildAudioResult {
  generated: string[];
  reused: string[];
  missing: string[];
  fitted: string[];
}

export async function buildAudio(opts: BuildAudioOptions): Promise<BuildAudioResult> {
  const paths = pathsFor(opts.slug);
  await ensureDir(paths.audioDir);
  const result: BuildAudioResult = { generated: [], reused: [], missing: [], fitted: [] };

  for (const shot of opts.shots) {
    const target = join(paths.audioDir, `${shot.shotId}.mp3`);

    // 1) 已有人工配音：直接复用（真人配音优先，绝不覆盖）
    if (existsSync(target)) {
      shot.audio = target;
      shot.updatedAt = nowIso();
      const dur = await probeDuration(target);
      if (opts.fitDuration && dur > shot.duration + 0.2) {
        shot.duration = Math.min(30, Math.ceil(dur));
        result.fitted.push(`${shot.shotId} → ${shot.duration}s`);
      }
      result.reused.push(shot.shotId);
      continue;
    }

    // 2) 无对白：不需要音频
    if (!shot.dialogue) {
      continue;
    }

    if (opts.dryRun) {
      result.missing.push(`${shot.shotId}（待合成：${shot.dialogue.slice(0, 16)}…）`);
      continue;
    }

    try {
      await synthesize(shot.dialogue, target, opts.voice);
      shot.audio = target;
      shot.updatedAt = nowIso();
      const dur = await probeDuration(target);
      if (opts.fitDuration && dur > shot.duration + 0.2) {
        shot.duration = Math.min(30, Math.ceil(dur));
        result.fitted.push(`${shot.shotId} → ${shot.duration}s`);
      }
      result.generated.push(shot.shotId);
      log.info(`${shot.shotId} 配音 ${dur.toFixed(2)}s → ${target}`);
    } catch (err) {
      log.error(`${shot.shotId} 配音失败：${err instanceof Error ? err.message : String(err)}`);
      result.missing.push(shot.shotId);
    }
  }

  return result;
}

/** 可用中文语音列表（供 doctor / 配置参考） */
export async function listChineseVoices(): Promise<string[]> {
  const r = await run("say", ["-v", "?"]);
  return r.out
    .split("\n")
    .filter((l) => l.includes("zh_CN"))
    .map((l) => l.split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/**
 * 装配整片音轨：按镜头顺序把配音拼成一条时间线，缺配音的镜头补等长静音。
 * 即梦生成的分镜通常是无声或带自己的环境音，对白必须靠这条轨补上，
 * 否则成片就是一部没有台词的默片。
 */
export async function buildFullAudioTrack(
  slug: string,
  shots: Shot[],
  workDir: string,
): Promise<string | null> {
  const paths = pathsFor(slug);
  const ordered = shots.filter((s) => s.status === "done");
  if (!ordered.some((s) => s.audio)) return null;

  await ensureDir(workDir);
  // 每段严格补齐到镜头时长：TTS 实际长度通常短于镜头配置，
  // 不补的话台词会随时间轴逐段提前，最终全片错位
  const segments: string[] = [];
  for (const [i, shot] of ordered.entries()) {
    const seg = join(workDir, `seg-${i}.m4a`);
    if (shot.audio && existsSync(shot.audio)) {
      const conv = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", shot.audio,
        "-af", "apad",
        "-t", String(shot.duration),
        "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k", seg,
      ]);
      if (conv.code !== 0) {
        log.warn(`配音转码失败 ${shot.shotId}，该段补静音：${conv.err.slice(0, 120)}`);
        const sil = await run("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${shot.duration}`,
          "-c:a", "aac", seg,
        ]);
        if (sil.code !== 0) continue;
      }
    } else {
      const sil = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${shot.duration}`,
        "-c:a", "aac", seg,
      ]);
      if (sil.code !== 0) continue;
    }
    segments.push(seg);
  }

  if (segments.length === 0) return null;

  const listFile = join(workDir, "audio-concat.txt");
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(listFile, segments.map((p) => `file '${p}'`).join("\n") + "\n", "utf8");

  const out = join(paths.audioDir, "full-track.m4a");
  const merged = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:a", "aac", "-b:a", "192k", out,
  ]);
  if (merged.code !== 0) {
    log.error(`整片音轨装配失败：${merged.err.slice(0, 200)}`);
    return null;
  }
  return out;
}
