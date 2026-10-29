import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** 原子写：先写临时文件再 rename，避免进程中断留下半个 JSON。
 * 临时名带随机后缀，防止同一毫秒内并发写入撞名。 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}
