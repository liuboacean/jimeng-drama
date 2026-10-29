import type { Character, Project, Shot } from "../types.js";

const NEGATIVE_HINT = "画面稳定，人物面容保持一致，无变形，无多手多指，无文字水印";

/** 把风格圣经 + 角色锚定 + 镜头描述拼成最终 prompt */
export function renderShotPrompt(shot: Shot, project: Project, characters: Character[]): string {
  const parts: string[] = [];
  if (project.styleBible) parts.push(project.styleBible);

  const cast = shot.cast
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => Boolean(c));
  for (const c of cast) parts.push(`${c.name}：${c.anchor}`);

  parts.push(shot.prompt);
  parts.push(NEGATIVE_HINT);
  return parts.join("；");
}

/** 首帧图提示词：竖构图 + 角色锚定，必须直接生成目标比例（seedance2.5 会跟随首帧） */
export function renderFramePrompt(shot: Shot, project: Project, characters: Character[]): string {
  const parts: string[] = [];
  if (project.styleBible) parts.push(project.styleBible);

  const cast = shot.cast
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => Boolean(c));
  for (const c of cast) parts.push(`${c.name}：${c.anchor}`);

  parts.push(shot.prompt);
  parts.push("单人构图，人物面部清晰完整，画面无文字");
  parts.push(NEGATIVE_HINT);
  return parts.join("；");
}

export function needsFirstFrame(mode: Shot["mode"]): boolean {
  return mode === "image2video" || mode === "frames2video" || mode === "multimodal2video";
}
