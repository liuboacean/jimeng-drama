import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Aspect } from "../types.js";
import type { CreditInfo, ImageRequest, Provider, SubmitAck, TaskResult, VideoRequest } from "./types.js";

interface MockRecord {
  submitId: string;
  kind: "image" | "video";
  prompt: string;
  duration: number;
  aspect: Aspect;
}

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

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(0, 400)}`));
    });
  });
}

/**
 * 离线 Provider：不花一分积分，用 ffmpeg 合成占位素材，把整条流水线跑通。
 * 用于联调、回归、以及会员门槛未解决时验证编排逻辑。
 */
export class MockProvider implements Provider {
  readonly name = "mock";

  async credit(): Promise<CreditInfo> {
    return { total: 9999, vipLevel: "mock" };
  }

  async submitImage(req: ImageRequest): Promise<SubmitAck> {
    const submitId = `mock_${randomUUID().slice(0, 8)}`;
    await this.writeRecord(req.outDir, {
      submitId,
      kind: "image",
      prompt: req.prompt,
      duration: 0,
      aspect: req.ratio,
    });
    return { submitId };
  }

  async submitVideo(req: VideoRequest): Promise<SubmitAck> {
    const submitId = `mock_${randomUUID().slice(0, 8)}`;
    await this.writeRecord(req.outDir, {
      submitId,
      kind: "video",
      prompt: req.prompt,
      duration: req.duration,
      aspect: req.ratio ?? "9:16",
    });
    return { submitId };
  }

  async query(submitId: string, outDir: string): Promise<TaskResult> {
    let record: MockRecord;
    try {
      record = JSON.parse(await readFile(this.recordPath(outDir, submitId), "utf8")) as MockRecord;
    } catch {
      return { state: "fail", submitId, failReason: "mock 任务记录缺失" };
    }
    const { w, h } = dims(record.aspect);

    if (record.kind === "image") {
      const out = join(outDir, `${submitId}.png`);
      await ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${w}x${h}`, "-frames:v", "1", out]);
      return { state: "success", submitId, output: out, credits: 0 };
    }

    const out = join(outDir, `${submitId}.mp4`);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=${w}x${h}:d=${record.duration}:r=30`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      String(record.duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      out,
    ]);
    return { state: "success", submitId, output: out, credits: 0 };
  }

  private recordPath(outDir: string, submitId: string): string {
    return join(outDir, `.mock-${submitId}.json`);
  }

  private async writeRecord(outDir: string, record: MockRecord): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    await writeFile(this.recordPath(outDir, record.submitId), JSON.stringify(record), "utf8");
  }
}
