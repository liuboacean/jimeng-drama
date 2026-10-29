import { z } from "zod";

export const Aspect = z.enum(["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]);
export type Aspect = z.infer<typeof Aspect>;

export const Resolution = z.enum(["480p", "720p", "1080p"]);
export type Resolution = z.infer<typeof Resolution>;

/** 短剧镜头生成模式：对应即梦 CLI 的四个视频命令 */
export const ShotMode = z.enum([
  "image2video", // 首帧图 + 提示词（主力单镜）
  "frames2video", // 首帧 + 末帧（镜头衔接）
  "multimodal2video", // 图 + 音频（对白镜 / 口型）
  "multiframe2video", // 多图一次成片（空镜过场串烧）
]);
export type ShotMode = z.infer<typeof ShotMode>;

export const ShotStatus = z.enum([
  "pending",
  "submitted",
  "generating",
  "done",
  "failed",
  "skipped",
]);
export type ShotStatus = z.infer<typeof ShotStatus>;

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 外貌锚定描述，必须每次拼进 prompt */
  anchor: z.string(),
  seed: z.number().int().optional(),
  refs: z.array(z.string()).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

export const ShotSchema = z.object({
  shotId: z.string(),
  scene: z.string().default(""),
  mode: ShotMode.default("image2video"),
  duration: z.number().min(1).max(30).default(5),
  prompt: z.string(),
  dialogue: z.string().nullable().default(null),
  cast: z.array(z.string()).default([]),
  firstFrame: z.string().nullable().default(null),
  lastFrame: z.string().nullable().default(null),
  audio: z.string().nullable().default(null),
  images: z.array(z.string()).default([]),
  /** 上一镜 shotId，用于末帧抽帧续接 */
  chainedFrom: z.string().nullable().default(null),
  transitionPrompt: z.string().nullable().default(null),
  status: ShotStatus.default("pending"),
  submitId: z.string().nullable().default(null),
  output: z.string().nullable().default(null),
  creditsSpent: z.number().default(0),
  retries: z.number().default(0),
  failReason: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ProjectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  aspect: Aspect.default("9:16"),
  resolution: Resolution.default("1080p"),
  targetDuration: z.number().positive().default(100),
  /** 全局风格锚定，拼进每条 prompt 头尾 */
  styleBible: z.string().default(""),
  budgetCredits: z.number().nonnegative().default(500),
  provider: z.enum(["dreamina", "mock", "volc"]).default("dreamina"),
  models: z
    .object({
      image: z.string().default("5.0"),
      imageResolutionType: z.string().default("2k"),
      video: z.string().default("seedance2.5"),
    })
    .default({}),
  session: z.number().int().default(0),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ShotsFileSchema = z.object({ shots: z.array(ShotSchema) });
export type ShotsFile = z.infer<typeof ShotsFileSchema>;

export const CharactersFileSchema = z.object({ characters: z.array(CharacterSchema) });
export type CharactersFile = z.infer<typeof CharactersFileSchema>;
