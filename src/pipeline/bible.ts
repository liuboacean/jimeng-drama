import { readFile } from "node:fs/promises";
import { nowIso } from "../core/fsx.js";
import { loadCharacters, pathsFor } from "../core/project.js";
import type { Character, Shot, ShotMode } from "../types.js";

/** 中文对白语速：约 4.5 字/秒（含停顿） */
const CHARS_PER_SECOND = 4.5;

interface DraftLine {
  scene: string;
  kind: "dialogue" | "action";
  speaker?: string;
  text: string;
}

/**
 * 极简剧本文法（无需 LLM，确定性可复现）：
 *   ## 场景名            → 场景
 *   林夏：台词            → 对白镜
 *   [动作] 描述 / 纯描述行 → 空镜
 */
export function parseScript(markdown: string): DraftLine[] {
  const lines: DraftLine[] = [];
  let scene = "场景 1";
  let sceneIndex = 1;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("# ") || line.startsWith("```")) continue;

    if (line.startsWith("##")) {
      scene = line.replace(/^#+\s*/, "").trim() || `场景 ${sceneIndex}`;
      sceneIndex += 1;
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      // 列表项同样按对白/动作判定
      push(line.slice(2).trim());
      continue;
    }
    push(line);
  }

  function push(text: string): void {
    const stripped = text.replace(/^\[动作\]\s*/, "").replace(/^【动作】\s*/, "");
    const isAction = stripped !== text || /^[（(]/.test(stripped);
    if (isAction) {
      lines.push({ scene, kind: "action", text: stripped.replace(/^[（(]|[）)]$/g, "").trim() });
      return;
    }
    const match = /^([^：:]{1,12})[：:]\s*(.+)$/.exec(stripped);
    if (match?.[1] && match[2]) {
      lines.push({ scene, kind: "dialogue", speaker: match[1].trim(), text: match[2].trim() });
    } else {
      lines.push({ scene, kind: "action", text: stripped });
    }
  }

  return lines.filter((l) => l.text.length > 0);
}

function estimateDialogueDuration(text: string): number {
  const spoken = text.replace(/[，。！？、；：""''（）\s]/g, "");
  const seconds = spoken.length / CHARS_PER_SECOND;
  return Math.min(15, Math.max(3, Math.ceil(seconds + 1)));
}

export interface BuildShotsOptions {
  dialogueMode: ShotMode;
  actionDuration: number;
  /** 是否用上一镜末帧续接下一镜首帧 */
  chain: boolean;
}

export function buildShotsFromScript(
  lines: DraftLine[],
  characters: Character[],
  opts: BuildShotsOptions,
): Shot[] {
  const shots: Shot[] = [];
  let sceneCounter = 0;
  let currentScene = "";
  let perSceneIndex = 0;

  for (const line of lines) {
    if (line.scene !== currentScene) {
      currentScene = line.scene;
      sceneCounter += 1;
      perSceneIndex = 0;
    }
    perSceneIndex += 1;

    const prev = shots[shots.length - 1];
    const shotId = `S${String(sceneCounter).padStart(2, "0")}-${String(perSceneIndex).padStart(2, "0")}`;

    const cast = characters
      .filter((c) => line.speaker === c.name || line.text.includes(c.name))
      .map((c) => c.id);

    const isDialogue = line.kind === "dialogue";
    const shot: Shot = {
      shotId,
      scene: line.scene,
      mode: isDialogue ? opts.dialogueMode : "image2video",
      duration: isDialogue ? estimateDialogueDuration(line.text) : opts.actionDuration,
      prompt: isDialogue ? `${line.speaker ?? "人物"}开口说话：${line.text}` : line.text,
      dialogue: isDialogue ? line.text : null,
      cast,
      firstFrame: null,
      lastFrame: null,
      audio: null,
      images: [],
      chainedFrom: opts.chain && prev ? prev.shotId : null,
      transitionPrompt: null,
      status: "pending",
      submitId: null,
      output: null,
      creditsSpent: 0,
      retries: 0,
      failReason: null,
      updatedAt: nowIso(),
    };
    shots.push(shot);
  }

  return shots;
}

export interface ScriptImportResult {
  shots: Shot[];
  kept: number;
  added: number;
}

/** 导入剧本：已完成的镜头按 shotId 保留，不被覆盖 */
export async function importScript(
  slug: string,
  opts: BuildShotsOptions & { file?: string },
): Promise<ScriptImportResult> {
  const paths = pathsFor(slug);
  const markdown = await readFile(opts.file ?? paths.script, "utf8");
  const lines = parseScript(markdown);
  const characters = (await loadCharacters(slug)).characters;
  const drafts = buildShotsFromScript(lines, characters, opts);

  let existing: Shot[] = [];
  try {
    const raw = await readFile(paths.shots, "utf8");
    const parsed = JSON.parse(raw) as { shots?: Shot[] };
    existing = parsed.shots ?? [];
  } catch {
    existing = [];
  }
  const doneById = new Map(existing.filter((s) => s.status === "done").map((s) => [s.shotId, s]));

  let kept = 0;
  const merged = drafts.map((d) => {
    const done = doneById.get(d.shotId);
    if (done) {
      kept += 1;
      return done;
    }
    return d;
  });

  return { shots: merged, kept, added: merged.length - kept };
}

export function totalShotDuration(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + s.duration, 0);
}
