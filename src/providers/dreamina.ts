import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../core/logger.js";
import type {
  CreditInfo,
  ImageRequest,
  Provider,
  SubmitAck,
  TaskResult,
  VideoRequest,
} from "./types.js";
import { ProviderError } from "./types.js";

const log = logger("dreamina");

function resolveBin(): string {
  if (process.env.DREAMINA_BIN) return process.env.DREAMINA_BIN;
  const local = join(homedir(), ".local", "bin", "dreamina");
  if (existsSync(local)) return local;
  return "dreamina";
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs = 300_000): Promise<RunOut> {
  return new Promise((resolve, reject) => {
    const bin = resolveBin();
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ProviderError(`dreamina ${args[0]} 超时 ${timeoutMs}ms`, "TIMEOUT", true));
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ProviderError(`无法执行 dreamina：${err.message}`, "BIN_NOT_FOUND", false));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 尽力从混杂输出里抽出 JSON 对象 */
function pickJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* 落到下面的逐个对象扫描 */
  }
  for (const line of trimmed.split("\n").reverse()) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** 已知的不可重试业务错误 */
const FATAL_CODES = [
  "AigcComplianceConfirmationRequired",
  "ExceedConcurrencyLimit",
  "NotMember",
  "PermissionDenied",
];

function classify(text: string): { code: string; retryable: boolean } {
  for (const code of FATAL_CODES) {
    if (text.includes(code)) {
      return { code, retryable: code === "ExceedConcurrencyLimit" };
    }
  }
  if (text.includes("仅限会员") || text.includes("没有 dreamina_cli 使用权限")) {
    return { code: "NotMember", retryable: false };
  }
  if (text.includes("未检测到有效登录态")) return { code: "NotLoggedIn", retryable: false };
  return { code: "Unknown", retryable: true };
}

async function newestFile(dir: string, exts: string[]): Promise<string | undefined> {
  try {
    const entries = await readdir(dir);
    const candidates: { path: string; mtime: number }[] = [];
    for (const name of entries) {
      if (!exts.some((e) => name.toLowerCase().endsWith(e))) continue;
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isFile()) candidates.push({ path: full, mtime: st.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.path;
  } catch {
    return undefined;
  }
}

export class DreaminaProvider implements Provider {
  readonly name = "dreamina";

  async credit(): Promise<CreditInfo> {
    const out = await run(["user_credit"], 30_000);
    const obj = pickJson(out.stdout);
    if (!obj) {
      throw new ProviderError(`user_credit 解析失败：${out.stdout.slice(0, 200)}`, "PARSE", false);
    }
    return {
      total: Number(obj["total_credit"] ?? 0),
      userId: typeof obj["user_id"] === "string" ? obj["user_id"] : undefined,
      vipLevel: typeof obj["vip_level"] === "string" ? obj["vip_level"] : undefined,
    };
  }

  async submitImage(req: ImageRequest): Promise<SubmitAck> {
    const args = [
      "text2image",
      `--prompt=${req.prompt}`,
      `--ratio=${req.ratio}`,
      `--resolution_type=${req.resolutionType}`,
      `--model_version=${req.model}`,
      `--generate_num=${req.count}`,
      `--session=${req.session}`,
      "--poll=0",
    ];
    return this.submit(args, "text2image");
  }

  async submitVideo(req: VideoRequest): Promise<SubmitAck> {
    const base = [`--session=${req.session}`, "--poll=0"];
    let args: string[];
    switch (req.mode) {
      case "frames2video":
        if (!req.first || !req.last) {
          throw new ProviderError("frames2video 需要首帧与末帧", "BAD_INPUT", false);
        }
        args = [
          "frames2video",
          `--first=${req.first}`,
          `--last=${req.last}`,
          `--prompt=${req.prompt}`,
          `--duration=${req.duration}`,
          `--video_resolution=${req.resolution}`,
          `--model_version=${req.model}`,
          ...base,
        ];
        if (req.ratio) args.push(`--ratio=${req.ratio}`);
        break;

      case "multimodal2video": {
        args = ["multimodal2video", `--prompt=${req.prompt}`];
        if (req.image) args.push(`--image=${req.image}`);
        for (const img of req.images ?? []) args.push(`--image=${img}`);
        if (req.audio) args.push(`--audio=${req.audio}`);
        args.push(
          `--duration=${req.duration}`,
          `--video_resolution=${req.resolution}`,
          `--model_version=${req.model}`,
          ...base,
        );
        if (req.ratio) args.push(`--ratio=${req.ratio}`);
        break;
      }

      case "multiframe2video": {
        const explicit: string[] = req.images ?? [];
        const images: string[] = explicit.length > 0 ? explicit : req.image ? [req.image] : [];
        if (images.length < 2) {
          throw new ProviderError("multiframe2video 需要至少 2 张图", "BAD_INPUT", false);
        }
        args = ["multiframe2video", `--images=${images.join(",")}`];
        if (images.length === 2) args.push(`--prompt=${req.prompt}`);
        else args.push(`--transition-prompt=${req.prompt}`);
        args.push(`--video_resolution=${req.resolution}`, ...base);
        break;
      }

      case "image2video":
      default:
        if (!req.image) {
          throw new ProviderError("image2video 需要首帧图", "BAD_INPUT", false);
        }
        args = [
          "image2video",
          `--image=${req.image}`,
          `--prompt=${req.prompt}`,
          `--duration=${req.duration}`,
          `--video_resolution=${req.resolution}`,
          `--model_version=${req.model}`,
          ...base,
        ];
        if (req.ratio) args.push(`--ratio=${req.ratio}`);
        break;
    }
    return this.submit(args, req.mode);
  }

  private async submit(args: string[], label: string): Promise<SubmitAck> {
    log.debug(`submit ${label}: ${args.join(" ")}`);
    const out = await run(args, 600_000);
    const merged = `${out.stdout}\n${out.stderr}`;
    const obj = pickJson(out.stdout);
    const submitId = pickString(obj, ["submit_id", "submitId", "task_id"]);

    if (!submitId) {
      const verdict = classify(merged);
      throw new ProviderError(
        `${label} 提交未拿到 submit_id：${merged.trim().slice(0, 300)}`,
        verdict.code,
        false,
      );
    }
    const genStatus = pickString(obj, ["gen_status", "status"]);
    if (genStatus === "fail") {
      const reason = pickString(obj, ["fail_reason", "message"]) ?? "未知失败原因";
      return { submitId, rejected: { code: "GenFail", message: reason } };
    }
    return { submitId };
  }

  async query(submitId: string, outDir: string): Promise<TaskResult> {
    const out = await run(["query_result", `--submit_id=${submitId}`, `--download_dir=${outDir}`], 600_000);
    const merged = `${out.stdout}\n${out.stderr}`;
    const obj = pickJson(out.stdout);
    const status = pickString(obj, ["gen_status", "status"]) ?? "";

    if (status === "success") {
      // CLI 正常会打印落盘路径；拿不到就扫目录里最新的媒体文件
      const fromJson = pickString(obj, ["download_path", "output_path", "local_path", "file_path"]);
      const output = fromJson ?? (await newestFile(outDir, [".mp4", ".png", ".jpg", ".jpeg", ".webp"]));
      // 真实扣费以返回的 credit_count 为准，不要用预估值
      const charged = Number(obj?.["credit_count"] ?? 0);
      return {
        state: "success",
        submitId,
        output,
        credits: Number.isFinite(charged) && charged > 0 ? charged : undefined,
        raw: obj ?? merged,
      };
    }
    if (status === "fail") {
      return {
        state: "fail",
        submitId,
        failReason: pickString(obj, ["fail_reason", "message"]) ?? "生成失败",
        raw: obj ?? merged,
      };
    }
    if (!status && merged.includes("未检测到有效登录态")) {
      throw new ProviderError("登录态失效，请重新 dreamina login", "NotLoggedIn", false);
    }
    return { state: "querying", submitId, raw: obj ?? merged };
  }
}
