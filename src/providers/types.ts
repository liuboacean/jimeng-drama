import type { Aspect, Resolution, Shot, ShotMode } from "../types.js";

export interface CreditInfo {
  total: number;
  userId?: string;
  vipLevel?: string;
}

export interface ImageRequest {
  prompt: string;
  ratio: Aspect;
  resolutionType: string;
  model: string;
  count: number;
  /** 产物落盘目录 */
  outDir: string;
  session: number;
}

export interface VideoRequest {
  mode: ShotMode;
  prompt: string;
  duration: number;
  resolution: Resolution;
  /** multimodal2video 支持显式传；image2video + seedance2.5 必须省略 */
  ratio?: Aspect;
  image?: string;
  first?: string;
  last?: string;
  images?: string[];
  audio?: string;
  model: string;
  outDir: string;
  session: number;
}

/** 任务终态。querying 只代表"已受理且未完成"，不是成功 */
export interface TaskResult {
  state: "querying" | "success" | "fail";
  submitId: string;
  output?: string;
  failReason?: string;
  credits?: number;
  raw?: unknown;
}

export interface SubmitAck {
  submitId: string;
  /** 提交阶段就已经失败（如 ExceedConcurrencyLimit / 合规确认） */
  rejected?: { code: string; message: string };
}

export interface Provider {
  readonly name: string;
  credit(): Promise<CreditInfo>;
  submitImage(req: ImageRequest): Promise<SubmitAck>;
  submitVideo(req: VideoRequest): Promise<SubmitAck>;
  query(submitId: string, outDir: string): Promise<TaskResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function shotToVideoRequest(
  shot: Shot,
  opts: { model: string; resolution: Resolution; aspect: Aspect; outDir: string; session: number },
): VideoRequest {
  const req: VideoRequest = {
    mode: shot.mode,
    prompt: shot.prompt,
    duration: shot.duration,
    resolution: opts.resolution,
    model: opts.model,
    outDir: opts.outDir,
    session: opts.session,
  };
  // seedance2.5 在 image2video/frames2video 下禁止显式 ratio，比例随首帧
  const ratioForbidden =
    opts.model === "seedance2.5" && (shot.mode === "image2video" || shot.mode === "frames2video");
  if (!ratioForbidden && shot.mode !== "multiframe2video") req.ratio = opts.aspect;
  if (shot.firstFrame) req.image = shot.firstFrame;
  if (shot.firstFrame) req.first = shot.firstFrame;
  if (shot.lastFrame) req.last = shot.lastFrame;
  if (shot.audio) req.audio = shot.audio;
  if (shot.images.length > 0) req.images = shot.images;
  return req;
}
