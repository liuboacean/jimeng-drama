import { join } from "node:path";
import { BudgetGuard, estimateShot } from "../core/budget.js";
import { logger } from "../core/logger.js";
import { loadCharacters, saveShots, shotDir } from "../core/project.js";
import { ensureDir, nowIso } from "../core/fsx.js";
import { needsFirstFrame, renderFramePrompt, renderShotPrompt } from "../prompts/style.js";
import type { Provider, TaskResult } from "../providers/types.js";
import { ProviderError, shotToVideoRequest } from "../providers/types.js";
import type { Project, Shot } from "../types.js";
import { extractLastFrame } from "./compose.js";

const log = logger("shots");

export interface RunOptions {
  project: Project;
  shots: Shot[];
  provider: Provider;
  concurrency: number;
  maxRetries: number;
  pollSeconds: number;
  pollTimeoutSeconds: number;
  /** 显式放行超预算 */
  yesOverBudget: boolean;
  dryRun: boolean;
}

export interface RunSummary {
  done: number;
  failed: number;
  skipped: number;
  creditsSpent: number;
  failures: { shotId: string; reason: string }[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntilTerminal(
  provider: Provider,
  submitId: string,
  outDir: string,
  opts: { pollSeconds: number; timeoutSeconds: number },
): Promise<TaskResult> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let last: TaskResult = { state: "querying", submitId };
  while (Date.now() < deadline) {
    await sleep(opts.pollSeconds * 1000);
    const result = await provider.query(submitId, outDir);
    last = result;
    if (result.state !== "querying") return result;
  }
  return last;
}

async function persist(opts: RunOptions, shots: Shot[]): Promise<void> {
  await saveShots(opts.project.slug, shots);
}

/** 单镜执行：首帧 → 视频 → 落盘，每步都落状态 */
async function runOneShot(
  shot: Shot,
  opts: RunOptions,
  budget: BudgetGuard,
  allShots: Shot[],
): Promise<{ ok: boolean; reason?: string }> {
  const { project, provider } = opts;
  const outDir = shotDir(project.slug, shot.shotId);
  await ensureDir(outDir);

  try {
    // 1) 需要首帧但没有 → 先生图
    if (needsFirstFrame(shot.mode) && !shot.firstFrame) {
      const characters = (await loadCharacters(project.slug)).characters;
      const prompt = renderFramePrompt(shot, project, characters);
      budget.assert(3, `${shot.shotId} 首帧图`);

      log.info(`${shot.shotId} 生成首帧图`);
      const ack = await provider.submitImage({
        prompt,
        ratio: project.aspect,
        resolutionType: project.models.imageResolutionType,
        model: project.models.image,
        count: 1,
        outDir,
        session: project.session,
      });
      const res = await pollUntilTerminal(provider, ack.submitId, outDir, {
        pollSeconds: opts.pollSeconds,
        timeoutSeconds: opts.pollTimeoutSeconds,
      });
      if (res.state !== "success" || !res.output) {
        throw new ProviderError(
          `首帧图未成功：${res.failReason ?? res.state}`,
          "FrameFail",
          res.state !== "fail",
        );
      }
      shot.firstFrame = res.output;
      shot.creditsSpent += res.credits ?? 3;
      budget.record(res.credits ?? 3);
      shot.updatedAt = nowIso();
      await persist(opts, allShots);
    }

    // 2) 提交视频
    const characters = (await loadCharacters(project.slug)).characters;
    const prompt = renderShotPrompt(shot, project, characters);
    const estimate = estimateShot(shot);
    budget.assert(estimate, `${shot.shotId} 视频 ${shot.duration}s`);

    const req = shotToVideoRequest({ ...shot, prompt }, {
      model: project.models.video,
      resolution: project.resolution,
      aspect: project.aspect,
      outDir,
      session: project.session,
    });

    log.info(`${shot.shotId} 提交视频（${shot.mode} / ${shot.duration}s）`);
    const ack = await provider.submitVideo(req);
    shot.submitId = ack.submitId;
    shot.status = "submitted";
    shot.updatedAt = nowIso();
    await persist(opts, allShots);

    // 3) 轮询
    const res = await pollUntilTerminal(provider, ack.submitId, outDir, {
      pollSeconds: opts.pollSeconds,
      timeoutSeconds: opts.pollTimeoutSeconds,
    });
    if (res.state === "success" && res.output) {
      shot.status = "done";
      shot.output = res.output;
      shot.failReason = null;
      shot.creditsSpent += res.credits ?? estimate;
      budget.record(res.credits ?? estimate);
      shot.updatedAt = nowIso();
      await persist(opts, allShots);
      log.info(`${shot.shotId} 完成 → ${res.output}`);
      return { ok: true };
    }
    if (res.state === "querying") {
      throw new ProviderError("轮询超时，任务仍在队列中", "PollTimeout", true);
    }
    throw new ProviderError(res.failReason ?? "生成失败", "GenFail", false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof ProviderError ? err.retryable : false;
    shot.retries += 1;
    shot.updatedAt = nowIso();

    if (retryable && shot.retries <= opts.maxRetries) {
      shot.status = "pending";
      shot.failReason = message;
      await persist(opts, allShots);
      const backoff = Math.min(2 ** shot.retries * 5, 60);
      log.warn(`${shot.shotId} 可重试失败（第${shot.retries}次），${backoff}s 后重试：${message}`);
      await sleep(backoff * 1000);
      return runOneShot(shot, opts, budget, allShots);
    }

    shot.status = "failed";
    shot.failReason = message;
    await persist(opts, allShots);
    log.error(`${shot.shotId} 失败：${message}`);
    return { ok: false, reason: message };
  }
}

/** 上一镜完成后抽末帧，喂给下一镜首帧 */
async function chainNextFrame(shot: Shot, opts: RunOptions, allShots: Shot[]): Promise<void> {
  if (shot.status !== "done" || !shot.output) return;
  const next = allShots.find((s) => s.chainedFrom === shot.shotId);
  if (!next || next.firstFrame) return;
  const outPng = join(shotDir(opts.project.slug, next.shotId), "chained-first.png");
  await ensureDir(shotDir(opts.project.slug, next.shotId));
  try {
    await extractLastFrame(shot.output, outPng);
    next.firstFrame = outPng;
    next.updatedAt = nowIso();
    await persist(opts, allShots);
    log.info(`镜头衔接：${shot.shotId} 末帧 → ${next.shotId} 首帧`);
  } catch (err) {
    log.warn(`末帧抽取失败，${next.shotId} 将自行生成首帧：${String(err)}`);
  }
}

export async function runShots(opts: RunOptions): Promise<RunSummary> {
  const { shots, project } = opts;
  const spentSoFar = shots.reduce((s, x) => s + x.creditsSpent, 0);
  const budget = new BudgetGuard(
    opts.yesOverBudget ? Number.POSITIVE_INFINITY : project.budgetCredits,
    spentSoFar,
  );

  const queue = shots.filter((s) => s.status !== "done" && s.status !== "skipped");
  if (queue.length === 0) {
    return { done: 0, failed: 0, skipped: shots.length, creditsSpent: 0, failures: [] };
  }

  if (opts.dryRun) {
    for (const s of queue) {
      log.info(`[dry-run] ${s.shotId} mode=${s.mode} ${s.duration}s 预计 ${estimateShot(s)} 积分`);
    }
    return { done: 0, failed: 0, skipped: 0, creditsSpent: 0, failures: [] };
  }

  const failures: RunSummary["failures"] = [];
  let done = 0;
  let failed = 0;

  const pending = [...queue];
  const byId = new Map(shots.map((s) => [s.shotId, s]));
  /** 已处理完"末帧衔接"的镜头，子镜头必须等它完成后才能启动 */
  const chained = new Set<string>();

  const isExecutable = (s: Shot): boolean => {
    if (!s.chainedFrom) return true;
    const parent = byId.get(s.chainedFrom);
    if (!parent) return true;
    return chained.has(parent.shotId) || parent.status === "failed";
  };

  const takeNext = (): Shot | undefined => {
    const idx = pending.findIndex((s) => isExecutable(s));
    if (idx < 0) return undefined;
    return pending.splice(idx, 1)[0];
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const shot = takeNext();
      if (!shot) return;
      const result = await runOneShot(shot, opts, budget, shots);
      if (result.ok) {
        done += 1;
        await chainNextFrame(shot, opts, shots);
      } else {
        failed += 1;
        failures.push({ shotId: shot.shotId, reason: result.reason ?? "未知" });
      }
      chained.add(shot.shotId);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, queue.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  return {
    done,
    failed,
    skipped: shots.length - queue.length,
    creditsSpent: shots.reduce((s, x) => s + x.creditsSpent, 0) - spentSoFar,
    failures,
  };
}
