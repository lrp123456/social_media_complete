// materialKeyPool.ts — 多 key 轮询 + 失败冷却切换
import type { KeyPool, KeyCooldownState } from './materialUpdateConfig';

const BODY_ERROR_PATTERNS = [
  /rate\s*limit/i,
  /quota\s*exceeded/i,
  /exceeded.*quota/i,
  /not\s*enough\s*credits/i,
  /too\s*many\s*requests/i,
  /api\s*key\s*invalid/i,
  /unauthorized/i,
];

export class KeyPoolManager {
  private cooldownState: KeyCooldownState;
  private readonly platformId: string;
  private readonly keyPool: KeyPool;

  constructor(platformId: string, keyPool: KeyPool, existingState: KeyCooldownState) {
    this.platformId = platformId;
    this.keyPool = keyPool;
    this.cooldownState = { ...existingState };
  }

  /**
   * 选下一个可用 key（轮询）。
   * 全部冷却中返回 null。
   */
  selectKey(): string | null {
    const now = Date.now();
    const platformState = this.cooldownState[this.platformId] || {};

    for (const key of this.keyPool.keys) {
      const expiry = platformState[key];
      if (!expiry || expiry <= now) {
        return key;
      }
    }
    return null;
  }

  /**
   * 标记某个 key 冷却（now + cooldownMs）。
   */
  markCooldown(key: string): void {
    if (!this.cooldownState[this.platformId]) {
      this.cooldownState[this.platformId] = {};
    }
    this.cooldownState[this.platformId][key] = Date.now() + this.keyPool.cooldownMs;
  }

  /**
   * 获取当前冷却状态快照。
   */
  getCooldownState(): KeyCooldownState {
    return JSON.parse(JSON.stringify(this.cooldownState));
  }

  /**
   * 检测 200 响应体中的限流/额度错误。
   * RapidAPI 常返回 200 + 错误消息。
   */
  isBodyError(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const text = JSON.stringify(body);
    return BODY_ERROR_PATTERNS.some((pattern) => pattern.test(text));
  }

  /**
   * 判断 HTTP 状态码是否应触发 key 冷却。
   */
  static shouldCooldownByStatus(status: number): boolean {
    return status === 401 || status === 429 || status === 403;
  }
}
