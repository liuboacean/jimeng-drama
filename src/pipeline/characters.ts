import { join } from "node:path";
import { ensureDir, nowIso } from "../core/fsx.js";
import { logger } from "../core/logger.js";
import { loadCharacters, pathsFor, saveCharacters } from "../core/project.js";
import type { Provider, TaskResult } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { Character, Project } from "../types.js";

const log = logger("chars");

const VIEWS = [
  { key: "front", label: "正面半身，面部清晰正对镜头" },
  { key: "side", label: "三分之二侧面，面部轮廓清晰" },
  { key: "full", label: "全身正面站姿，完整服装" },
] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll(
  provider: Provider,
  submitId: string,
  outDir: string,
  pollSeconds: number,
): Promise<TaskResult> {
  const deadline = Date.now() + 600_000;
  let last: TaskResult = { state: "querying", submitId };
  while (Date.now() < deadline) {
    await sleep(pollSeconds * 1000);
    last = await provider.query(submitId, outDir);
    if (last.state !== "querying") return last;
  }
  return last;
}

export interface BuildCharactersOptions {
  project: Project;
  provider: Provider;
  pollSeconds: number;
  views: number;
  /** 已有 refs 的角色是否重建 */
  force: boolean;
  dryRun: boolean;
}

export interface BuildCharactersResult {
  built: string[];
  skipped: string[];
  failed: { id: string; reason: string }[];
  credits: number;
}

/**
 * 角色圣经：为每个角色出一组定妆图。
 * 这组图是后续所有镜头的身份锚点 —— 短剧角色不漂移，全靠它 + 固定 seed。
 */
export async function buildCharacters(
  opts: BuildCharactersOptions,
): Promise<BuildCharactersResult> {
  const { project, provider } = opts;
  const paths = pathsFor(project.slug);
  const file = await loadCharacters(project.slug);
  await ensureDir(paths.charactersDir);

  const result: BuildCharactersResult = { built: [], skipped: [], failed: [], credits: 0 };
  const viewList = VIEWS.slice(0, Math.max(1, Math.min(opts.views, VIEWS.length)));

  for (const character of file.characters) {
    if (!opts.force && character.refs.length > 0) {
      result.skipped.push(`${character.id}:${character.name}（已有 ${character.refs.length} 张定妆图）`);
      continue;
    }
    if (opts.dryRun) {
      log.info(`[dry-run] ${character.name} 将生成 ${viewList.length} 张定妆图`);
      result.skipped.push(character.id);
      continue;
    }

    const refs: string[] = [];
    try {
      for (const view of viewList) {
        const prompt = [
          `角色定妆照，${character.name}`,
          character.anchor,
          view.label,
          "纯色背景，均匀柔光，无文字无水印，写实摄影风格",
        ].join("；");

        const ack = await provider.submitImage({
          prompt,
          ratio: project.aspect,
          resolutionType: project.models.imageResolutionType,
          model: project.models.image,
          count: 1,
          outDir: paths.charactersDir,
          session: project.session,
        });
        const res = await poll(provider, ack.submitId, paths.charactersDir, opts.pollSeconds);
        if (res.state !== "success" || !res.output) {
          throw new ProviderError(
            `定妆图 ${view.key} 失败：${res.failReason ?? res.state}`,
            "CharViewFail",
            false,
          );
        }
        // 统一命名，便于人工替换
        const target = join(paths.charactersDir, `${character.id}-${view.key}.png`);
        if (res.output !== target) {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(res.output, target);
        }
        refs.push(target);
        result.credits += res.credits ?? 3;
        log.info(`${character.name} 定妆图 ${view.key} → ${target}`);
      }

      const updated: Character = { ...character, refs, seed: character.seed ?? Date.now() % 1_000_000 };
      const next = file.characters.map((c) => (c.id === character.id ? updated : c));
      file.characters = next;
      await saveCharacters(project.slug, file);
      result.built.push(`${character.id}:${character.name}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`${character.name} 定妆失败：${reason}`);
      result.failed.push({ id: character.id, reason });
    }
  }

  return result;
}

/** 手放定妆图到 assets/characters/<id>-front.png 也会被自动识别 */
export async function syncManualRefs(slug: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const paths = pathsFor(slug);
  const file = await loadCharacters(slug);
  let changed = 0;
  let names: string[] = [];
  try {
    names = await readdir(paths.charactersDir);
  } catch {
    return 0;
  }
  for (const c of file.characters) {
    const found = names
      .filter((n) => n.startsWith(`${c.id}-`) && /\.(png|jpg|jpeg|webp)$/i.test(n))
      .map((n) => join(paths.charactersDir, n))
      .sort();
    if (found.length > 0 && found.join("|") !== c.refs.join("|")) {
      c.refs = found;
      changed += 1;
    }
  }
  if (changed > 0) await saveCharacters(slug, file);
  return changed;
}

export { nowIso };
