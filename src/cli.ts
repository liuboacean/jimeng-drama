import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { estimateProject, totalDuration, DEFAULT_PRICING } from "./core/budget.js";
import { ensureDir, nowIso, writeJsonAtomic } from "./core/fsx.js";
import { logger } from "./core/logger.js";
import {
  ROOT,
  loadCharacters,
  loadProject,
  loadShots,
  pathsFor,
  saveCharacters,
  saveProject,
  saveShots,
} from "./core/project.js";
import { createProvider } from "./providers/index.js";
import { composeProject, buildSrt, hasFilter } from "./pipeline/compose.js";
import { runShots } from "./pipeline/shots.js";
import { importScript, totalShotDuration } from "./pipeline/bible.js";
import { buildCharacters } from "./pipeline/characters.js";
import { buildAudio, buildFullAudioTrack, listChineseVoices } from "./pipeline/audio.js";
import { Aspect, Resolution, ProjectSchema, ShotMode, type Shot } from "./types.js";
import { mkdir, writeFile } from "node:fs/promises";

const log = logger("cli");

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function str(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === "string" ? v : undefined;
}

function bool(args: Args, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

function num(args: Args, key: string, fallback: number): number {
  const v = str(args, key);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function resolveSlug(args: Args): Promise<string> {
  const explicit = args.positional[1];
  if (explicit) return explicit;
  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
    if (dirs.length === 1 && dirs[0]) return dirs[0];
    if (dirs.length > 1) throw new Error(`存在多个项目，请指定 slug：${dirs.join(", ")}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("存在多个项目")) throw err;
  }
  throw new Error("未找到项目，请先执行：drama init <slug>");
}

const DEMO_SHOTS: Omit<Shot, "updatedAt">[] = [
  {
    shotId: "S01-01",
    scene: "雨夜街头",
    mode: "image2video",
    duration: 5,
    prompt: "雨夜街头，霓虹倒影，女性缓缓抬头看向镜头，雨丝斜落，冷青色调",
    dialogue: "你终于来了。",
    cast: ["c1"],
    firstFrame: null,
    lastFrame: null,
    audio: null,
    images: [],
    chainedFrom: null,
    transitionPrompt: null,
    status: "pending",
    submitId: null,
    output: null,
    creditsSpent: 0,
    retries: 0,
    failReason: null,
  },
  {
    shotId: "S01-02",
    scene: "雨夜街头",
    mode: "image2video",
    duration: 5,
    prompt: "镜头缓慢推近面部，眼神从平静转为压抑",
    dialogue: "我等了你三年。",
    cast: ["c1"],
    firstFrame: null,
    lastFrame: null,
    audio: null,
    images: [],
    chainedFrom: "S01-01",
    transitionPrompt: null,
    status: "pending",
    submitId: null,
    output: null,
    creditsSpent: 0,
    retries: 0,
    failReason: null,
  },
  {
    shotId: "S01-03",
    scene: "雨夜街头",
    mode: "image2video",
    duration: 5,
    prompt: "雨幕拉开，她转身走进霓虹深处，背影渐远，地面水洼倒映灯牌",
    dialogue: null,
    cast: ["c1"],
    firstFrame: null,
    lastFrame: null,
    audio: null,
    images: [],
    chainedFrom: "S01-02",
    transitionPrompt: null,
    status: "pending",
    submitId: null,
    output: null,
    creditsSpent: 0,
    retries: 0,
    failReason: null,
  },
];

async function cmdInit(args: Args): Promise<void> {
  const slug = args.positional[1];
  if (!slug) throw new Error("用法：drama init <slug> [--title=...] [--ratio=9:16] [--budget=500]");
  const paths = pathsFor(slug);
  if (existsSync(paths.project)) log.warn(`项目 ${slug} 已存在，将覆盖配置（不影响已生成素材）`);

  const project = ProjectSchema.parse({
    slug,
    title: str(args, "title") ?? slug,
    aspect: Aspect.catch("9:16").parse(str(args, "ratio") ?? "9:16"),
    resolution: Resolution.catch("1080p").parse(str(args, "resolution") ?? "1080p"),
    targetDuration: num(args, "duration", 100),
    styleBible:
      str(args, "style") ??
      "电影感写实，冷青色调，35mm浅景深，雨夜霓虹，人物面容保持一致，画面稳定",
    budgetCredits: num(args, "budget", 500),
    provider: "dreamina",
    session: 0,
    createdAt: nowIso(),
  });

  await ensureDir(paths.charactersDir);
  await ensureDir(paths.shotsDir);
  await ensureDir(paths.audioDir);
  await ensureDir(paths.outDir);
  await saveProject(project);

  await saveCharacters(slug, {
    characters: [
      {
        id: "c1",
        name: "林夏",
        anchor: "25岁东亚女性，齐肩短发，浅灰色风衣，左眉尾有细疤，神情克制",
        seed: 20261029,
        refs: [],
      },
    ],
  });

  await saveShots(
    slug,
    DEMO_SHOTS.map((s) => ({ ...s, updatedAt: nowIso() })),
  );

  if (!existsSync(paths.script)) {
    await writeFile(
      paths.script,
      `# ${project.title}\n\n## 场景 1 · 雨夜街头\n\n- 林夏（c1）：你终于来了。\n- 林夏（c1）：我等了你三年。\n\n（她转身走进霓虹深处）\n`,
      "utf8",
    );
  }

  log.info(`项目已创建：${paths.dir}`);
  log.info(`  配置：${paths.project}`);
  log.info(`  角色：${paths.characters}`);
  log.info(`  分镜：${paths.shots}（3 个示例镜头）`);
  log.info(`下一步：drama plan ${slug}  看预估花费`);
}

async function cmdStatus(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const shots = await loadShots(slug);
  const spent = shots.reduce((s, x) => s + x.creditsSpent, 0);

  console.log(`\n项目：${project.title}（${project.slug}）`);
  console.log(
    `规格：${project.aspect} / ${project.resolution} / 目标 ${project.targetDuration}s / 实际 ${totalDuration(shots)}s`,
  );
  console.log(`预算：${spent} / ${project.budgetCredits} 积分\n`);
  const head = ["镜头", "模式", "时长", "状态", "积分", "产物"];
  console.log(head.join("\t"));
  for (const s of shots) {
    console.log(
      [s.shotId, s.mode, `${s.duration}s`, s.status, String(s.creditsSpent), s.output ?? "-"].join("\t"),
    );
  }
  const failed = shots.filter((s) => s.status === "failed");
  if (failed.length > 0) {
    console.log("\n失败镜头：");
    for (const s of failed) console.log(`  ${s.shotId}: ${s.failReason ?? "未知"}`);
  }
}

async function cmdPlan(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const shots = await loadShots(slug);
  const pending = shots.filter((s) => s.status !== "done" && s.status !== "skipped");
  const credits = estimateProject(shots);
  const spent = shots.reduce((s, x) => s + x.creditsSpent, 0);

  console.log(`\n待执行 ${pending.length} / ${shots.length} 个镜头`);
  console.log(`预计消耗：${credits} 积分（单价估算：图 ${DEFAULT_PRICING.imagePerShot} / 视频 ${DEFAULT_PRICING.videoPerSecond} 每秒）`);
  console.log(`当前预算：${spent} / ${project.budgetCredits}，剩余 ${project.budgetCredits - spent}\n`);
  for (const s of pending) {
    console.log(`  ${s.shotId}  ${s.mode.padEnd(18)} ${String(s.duration).padStart(2)}s`);
  }
  if (credits > project.budgetCredits - spent) {
    log.warn("预估已超预算，直接 run 会被预算闸拦下。可调高 budgetCredits，或用 --yes-over-budget");
  }
}

async function cmdRun(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const providerName = (str(args, "provider") ?? project.provider) as "dreamina" | "mock";
  const shots = await loadShots(slug);

  const summary = await runShots({
    project,
    shots,
    provider: createProvider(providerName),
    concurrency: num(args, "concurrency", 2),
    maxRetries: num(args, "max-retries", 2),
    pollSeconds: num(args, "poll", 5),
    pollTimeoutSeconds: num(args, "timeout", 900),
    yesOverBudget: bool(args, "yes-over-budget"),
    dryRun: bool(args, "dry-run"),
  });

  console.log(
    `\n完成 ${summary.done} / 失败 ${summary.failed} / 跳过 ${summary.skipped}，消耗 ${summary.creditsSpent} 积分`,
  );
  for (const f of summary.failures) console.log(`  ✗ ${f.shotId}: ${f.reason}`);
}

async function cmdScript(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const dialogueMode = (str(args, "dialogue-mode") ?? "multimodal2video") as ShotMode;
  const result = await importScript(slug, {
    file: str(args, "file"),
    dialogueMode,
    actionDuration: num(args, "action-duration", 4),
    chain: !bool(args, "no-chain"),
  });
  await saveShots(slug, result.shots);

  const total = totalShotDuration(result.shots);
  log.info(`剧本已拆解：${result.shots.length} 个镜头（新建 ${result.added}，保留已完成 ${result.kept}）`);
  log.info(`对白镜模式：${dialogueMode}　预计总时长：${total}s`);
  for (const s of result.shots) {
    const tag = s.dialogue ? "对白" : "空镜";
    console.log(
      `  ${s.shotId}  ${tag}  ${s.mode.padEnd(18)} ${String(s.duration).padStart(2)}s  ${(s.dialogue ?? s.prompt).slice(0, 24)}`,
    );
  }
  if (total < 85 || total > 120) {
    log.warn(`总时长 ${total}s，偏离 100s 目标较多，可调剧本或 --action-duration`);
  }
}

async function cmdChars(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const providerName = (str(args, "provider") ?? project.provider) as "dreamina" | "mock";
  const result = await buildCharacters({
    project,
    provider: createProvider(providerName),
    pollSeconds: num(args, "poll", 5),
    views: num(args, "views", 3),
    force: bool(args, "force"),
    dryRun: bool(args, "dry-run"),
  });
  console.log(`\n定妆图：生成 ${result.built.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}，消耗 ${result.credits} 积分`);
  for (const s of result.skipped) console.log(`  · ${s}`);
  for (const f of result.failed) console.log(`  ✗ ${f.id}: ${f.reason}`);
}

async function cmdAudio(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const shots = await loadShots(slug);
  const result = await buildAudio({
    slug,
    shots,
    voice: str(args, "voice") ?? "Tingting",
    fitDuration: !bool(args, "no-fit"),
    dryRun: bool(args, "dry-run"),
  });
  await saveShots(slug, shots);
  console.log(
    `\n配音：合成 ${result.generated.length}，复用 ${result.reused.length}，缺失 ${result.missing.length}`,
  );
  for (const f of result.fitted) console.log(`  ↕ 镜头时长已适配音频：${f}`);
  for (const m of result.missing) console.log(`  · ${m}`);
  if (result.reused.length > 0) {
    log.info("复用的人工配音来自 audio/<shotId>.mp3，真人录音优先，不会被覆盖");
  }
  void project;
}

async function cmdCompose(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  const project = await loadProject(slug);
  const shots = await loadShots(slug);
  const paths = pathsFor(slug);
  await ensureDir(paths.outDir);

  const usable = shots.filter((s) => s.status === "done" && s.output);
  if (usable.length === 0) throw new Error("没有已完成的镜头，先跑 drama run");

  const srt = buildSrt(usable);
  if (srt) await writeFile(join(paths.audioDir, "subs.srt"), srt, "utf8");

  const bgmArg = str(args, "bgm");
  const bgmDefault = join(paths.audioDir, "bgm.mp3");
  const bgm = bgmArg === "none" ? null : bgmArg ?? (existsSync(bgmDefault) ? bgmDefault : null);
  if (bgm) log.info(`背景音乐：${bgm}`);

  const audioTrack = bool(args, "no-voice")
    ? null
    : await buildFullAudioTrack(slug, usable, join(paths.outDir, "work", "audio"));
  if (audioTrack) log.info(`配音轨：${audioTrack}`);

  const final = await composeProject({
    shots: usable,
    aspect: project.aspect,
    workDir: join(paths.outDir, "work"),
    finalPath: paths.finalMp4,
    burnSubtitles: bool(args, "burn-subs"),
    softSubtitles: !bool(args, "no-subs"),
    bgm,
    bgmVolume: num(args, "bgm-volume", 0.18),
    audioTrack,
  });
  log.info(`成片：${final}`);
}

/** 一条龙：剧本 → 定妆 → 分镜 → 配音 → 成片 */
async function cmdAll(args: Args): Promise<void> {
  const slug = await resolveSlug(args);
  let project = await loadProject(slug);
  const providerName = (str(args, "provider") ?? project.provider) as "dreamina" | "mock";
  const provider = createProvider(providerName);

  if (providerName !== project.provider) {
    project = { ...project, provider: providerName };
    await saveProject(project);
    log.info(`Provider 已切换为 ${providerName}`);
  }

  log.info("① 拆解剧本");
  const imported = await importScript(slug, {
    dialogueMode: (str(args, "dialogue-mode") ?? "multimodal2video") as ShotMode,
    actionDuration: num(args, "action-duration", 4),
    chain: true,
  });
  await saveShots(slug, imported.shots);
  log.info(`   ${imported.shots.length} 个镜头，预计 ${totalShotDuration(imported.shots)}s`);

  if (!bool(args, "skip-chars")) {
    log.info("② 生成角色定妆图");
    const chars = await buildCharacters({
      project,
      provider,
      pollSeconds: num(args, "poll", 5),
      views: num(args, "views", 3),
      force: bool(args, "force-chars"),
      dryRun: bool(args, "dry-run"),
    });
    log.info(`   ${chars.built.length} 个角色完成，${chars.credits} 积分`);
  }

  log.info("③ 合成对白配音");
  const shots = await loadShots(slug);
  const audio = await buildAudio({
    slug,
    shots,
    voice: str(args, "voice") ?? "Tingting",
    fitDuration: true,
    dryRun: bool(args, "dry-run"),
  });
  await saveShots(slug, shots);
  log.info(`   合成 ${audio.generated.length}，复用 ${audio.reused.length}，缺失 ${audio.missing.length}`);

  if (!bool(args, "dry-run")) {
    log.info("④ 逐镜生成");
    const summary = await runShots({
      project,
      shots,
      provider,
      concurrency: num(args, "concurrency", 2),
      maxRetries: num(args, "max-retries", 2),
      pollSeconds: num(args, "poll", 5),
      pollTimeoutSeconds: num(args, "timeout", 900),
      yesOverBudget: bool(args, "yes-over-budget"),
      dryRun: false,
    });
    log.info(`   完成 ${summary.done} / 失败 ${summary.failed}，消耗 ${summary.creditsSpent} 积分`);
    for (const f of summary.failures) log.error(`   ✗ ${f.shotId}: ${f.reason}`);
  }

  log.info("⑤ 拼接成片");
  const paths = pathsFor(slug);
  await ensureDir(paths.outDir);
  const finalShots = await loadShots(slug);
  const usable = finalShots.filter((s) => s.status === "done" && s.output);
  if (usable.length > 0) {
    const srt = buildSrt(usable);
    if (srt) await writeFile(join(paths.audioDir, "subs.srt"), srt, "utf8");
    const bgmDefault = join(paths.audioDir, "bgm.mp3");
    const audioTrack = await buildFullAudioTrack(slug, usable, join(paths.outDir, "work", "audio"));
    if (audioTrack) log.info(`   配音轨：${audioTrack}`);
    const final = await composeProject({
      shots: usable,
      aspect: project.aspect,
      workDir: join(paths.outDir, "work"),
      finalPath: paths.finalMp4,
      burnSubtitles: bool(args, "burn-subs"),
      softSubtitles: !bool(args, "no-subs"),
      bgm: existsSync(bgmDefault) ? bgmDefault : null,
      audioTrack,
    });
    log.info(`成片：${final}`);
  } else {
    log.warn("没有已完成镜头，跳过拼接");
  }
}

async function cmdDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const node = process.version;
  checks.push({ name: "node", ok: Number(node.slice(1).split(".")[0]) >= 20, detail: node });

  const ff = await new Promise<string>((resolve) => {
    const c = spawn("ffmpeg", ["-version"]);
    let out = "";
    c.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    c.on("error", () => resolve(""));
    c.on("close", () => resolve(out.split("\n")[0] ?? ""));
  });
  checks.push({ name: "ffmpeg", ok: ff.length > 0, detail: ff || "未安装" });

  const bin = join(homedir(), ".local", "bin", "dreamina");
  checks.push({
    name: "dreamina CLI",
    ok: existsSync(bin),
    detail: existsSync(bin) ? bin : "未安装（curl -fsSL https://jimeng.jianying.com/cli | bash）",
  });

  let credit = "";
  let vip = "";
  if (existsSync(bin)) {
    const provider = createProvider("dreamina");
    try {
      const info = await provider.credit();
      credit = String(info.total);
      vip = info.vipLevel ?? "";
      checks.push({
        name: "登录态",
        ok: true,
        detail: `积分 ${credit}，会员等级 ${vip || "无（CLI 会拒绝使用）"}`,
      });
    } catch (err) {
      checks.push({ name: "登录态", ok: false, detail: String(err) });
    }
  }

  const subFilter = await hasFilter("subtitles");
  checks.push({
    name: "硬字幕能力",
    ok: true,
    detail: subFilter ? "libass 可用，可烧制硬字幕" : "无 libass → 自动使用内嵌软字幕轨（mov_text）",
  });

  try {
    const voices = await listChineseVoices();
    checks.push({
      name: "中文 TTS",
      ok: voices.length > 0,
      detail: voices.length > 0 ? `${voices.length} 个语音，如 ${voices.slice(0, 3).join(" / ")}` : "无可用中文语音",
    });
  } catch {
    checks.push({ name: "中文 TTS", ok: false, detail: "say 命令不可用（仅 macOS）" });
  }

  console.log("");
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(14)} ${c.detail}`);
  console.log("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  switch (command) {
    case "init":
      return cmdInit(args);
    case "script":
      return cmdScript(args);
    case "chars":
      return cmdChars(args);
    case "audio":
      return cmdAudio(args);
    case "status":
      return cmdStatus(args);
    case "plan":
      return cmdPlan(args);
    case "run":
      return cmdRun(args);
    case "compose":
      return cmdCompose(args);
    case "all":
      return cmdAll(args);
    case "doctor":
      return cmdDoctor();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(`drama —— 即梦短剧生成引擎（9:16 竖屏 / 单集 100s）

用法：
  drama init <slug> [--title=..] [--ratio=9:16] [--budget=500] [--duration=100]
  drama doctor                          环境、登录态、字幕与 TTS 自检
  drama script [slug] [--dialogue-mode=multimodal2video] [--action-duration=4] [--no-chain]
                                        剧本 → 分镜（已完成镜头保留）
  drama chars  [slug] [--views=3] [--force] [--dry-run] [--provider=mock]
                                        角色定妆图（身份锚点，防人物漂移）
  drama audio  [slug] [--voice=Tingting] [--no-fit] [--dry-run]
                                        对白配音（audio/<shotId>.mp3 真人录音优先复用）
  drama plan   [slug]                   预估积分消耗
  drama status [slug]                   镜头状态与花费
  drama run    [slug] [--provider=mock] [--concurrency=2] [--dry-run] [--yes-over-budget]
  drama compose [slug] [--no-subs] [--burn-subs] [--bgm=path] [--bgm-volume=0.18]
  drama all    [slug] [--provider=mock] [--dry-run]     一条龙

离线验证（零积分）：
  drama init demo
  drama all demo --provider=mock
`);
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
