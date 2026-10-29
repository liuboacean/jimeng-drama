import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ProjectSchema,
  ShotsFileSchema,
  CharactersFileSchema,
  type Project,
  type Shot,
  type CharactersFile,
} from "../types.js";
import { writeJsonAtomic } from "./fsx.js";

export const ROOT = resolve(process.env.DRAMA_ROOT ?? "projects");

export interface ProjectPaths {
  dir: string;
  project: string;
  shots: string;
  characters: string;
  script: string;
  charactersDir: string;
  shotsDir: string;
  audioDir: string;
  outDir: string;
  finalMp4: string;
}

export function pathsFor(slug: string): ProjectPaths {
  const dir = join(ROOT, slug);
  const shotsDir = join(dir, "assets", "shots");
  return {
    dir,
    project: join(dir, "project.json"),
    shots: join(dir, "shots.json"),
    characters: join(dir, "characters.json"),
    script: join(dir, "script.md"),
    charactersDir: join(dir, "assets", "characters"),
    shotsDir,
    audioDir: join(dir, "audio"),
    outDir: join(dir, "out"),
    finalMp4: join(dir, "out", "final.mp4"),
  };
}

export async function loadProject(slug: string): Promise<Project> {
  const p = pathsFor(slug);
  const raw = await readFile(p.project, "utf8");
  return ProjectSchema.parse(JSON.parse(raw));
}

export async function saveProject(project: Project): Promise<void> {
  const p = pathsFor(project.slug);
  await writeJsonAtomic(p.project, project);
}

export async function loadShots(slug: string): Promise<Shot[]> {
  const p = pathsFor(slug);
  const raw = await readFile(p.shots, "utf8");
  return ShotsFileSchema.parse(JSON.parse(raw)).shots;
}

/** 串行化 shots.json 写入：多个 worker 并发落盘时必须排队，否则会互相覆盖 */
let writeChain: Promise<void> = Promise.resolve();

export async function saveShots(slug: string, shots: Shot[]): Promise<void> {
  const p = pathsFor(slug);
  const snapshot = JSON.parse(JSON.stringify({ shots })) as { shots: Shot[] };
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => writeJsonAtomic(p.shots, snapshot));
  return writeChain;
}

export async function loadCharacters(slug: string): Promise<CharactersFile> {
  const p = pathsFor(slug);
  try {
    const raw = await readFile(p.characters, "utf8");
    return CharactersFileSchema.parse(JSON.parse(raw));
  } catch {
    return { characters: [] };
  }
}

export async function saveCharacters(slug: string, data: CharactersFile): Promise<void> {
  const p = pathsFor(slug);
  await writeJsonAtomic(p.characters, data);
}

/** 该镜头的产物目录 */
export function shotDir(slug: string, shotId: string): string {
  return join(pathsFor(slug).shotsDir, shotId);
}
