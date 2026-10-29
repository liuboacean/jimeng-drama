import type { Project, Shot } from "../types.js";

/**
 * 积分单价估算（M0 实测前为预估值，抓不到官方价目表）
 * 依据：社区实测 图 1 credit/张；5s 视频 10~20 credits/段
 * 校准方式：跑完样片后用 user_credit 前后差值回填
 */
export interface Pricing {
  imagePerShot: number;
  videoPerSecond: number;
  audioPerSecond: number;
}

export const DEFAULT_PRICING: Pricing = {
  imagePerShot: 1,
  videoPerSecond: 3.2, // 5s ≈ 16 credits
  audioPerSecond: 0.2,
};

export function estimateShot(shot: Shot, pricing: Pricing = DEFAULT_PRICING): number {
  let credits = 0;
  if (shot.firstFrame === null || shot.status === "pending") {
    // 需要先出首帧图
    credits += pricing.imagePerShot;
  }
  credits += Math.ceil(shot.duration * pricing.videoPerSecond);
  if (shot.audio !== null) credits += Math.ceil(shot.duration * pricing.audioPerSecond);
  return credits;
}

export function estimateProject(shots: Shot[], pricing: Pricing = DEFAULT_PRICING): number {
  return shots
    .filter((s) => s.status !== "done" && s.status !== "skipped")
    .reduce((sum, s) => sum + estimateShot(s, pricing), 0);
}

export function totalDuration(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + s.duration, 0);
}

export class BudgetGuard {
  private spent: number;
  constructor(
    private readonly cap: number,
    alreadySpent = 0,
  ) {
    this.spent = alreadySpent;
  }

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return this.cap - this.spent;
  }

  /** 提交前守门：预估超预算直接抛错，不静默烧钱 */
  assert(expected: number, label: string): void {
    if (this.spent + expected > this.cap) {
      throw new Error(
        `预算不足：${label} 预计 ${expected} 积分，已用 ${this.spent}/${this.cap}。` +
          `如需继续请调高 project.json 的 budgetCredits，或用 --yes-over-budget 显式放行。`,
      );
    }
  }

  record(credits: number): void {
    this.spent += credits;
  }
}

export function budgetFromProject(project: Project, shots: Shot[]): BudgetGuard {
  const spent = shots.reduce((sum, s) => sum + s.creditsSpent, 0);
  return new BudgetGuard(project.budgetCredits, spent);
}
