// materialRunHealth.ts — PR3 运行健康度纯函数
// 按平台检测 no_keys / all_keys_cooldown / parse_mismatch / ok 四种状态

export type RunHealthKind = 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch' | 'ok';

export interface PlatformHealth {
  platformId: string;
  platformName: string;
  health: RunHealthKind;
  message: string;
}

export interface RunHealthResult {
  overall: RunHealthKind;
  platforms: PlatformHealth[];
  warnings: PlatformHealth[]; // 仅包含非 ok 的平台
}

/**
 * 健康度排序（降序：越靠前越严重）
 */
const HEALTH_SEVERITY: Record<RunHealthKind, number> = {
  no_keys: 4,
  parse_mismatch: 3,
  all_keys_cooldown: 2,
  ok: 1,
};

function severityOf(kind: RunHealthKind): number {
  return HEALTH_SEVERITY[kind];
}

/**
 * 获取最差（最高 severity）的健康状态
 */
function worstOf(...kinds: RunHealthKind[]): RunHealthKind {
  return kinds.reduce((worst, k) => (severityOf(k) > severityOf(worst) ? k : worst), 'ok' as RunHealthKind);
}

export interface PlatformRunInput {
  platformId: string;
  platformName: string;
  /** 该平台配置的 key 总数 */
  keyCount: number;
  /** 当前可用的 key 数（未冷却） */
  availableKeyCount: number;
  /** 本轮采集到的视频数 */
  fetched: number;
}

/**
 * 计算单平台健康度和整体健康度。
 *
 * 规则：
 *  - no_keys:          keyCount === 0（没有配置 key）
 *  - all_keys_cooldown: keyCount > 0 但 availableKeyCount === 0（所有 key 冷却中）
 *  - parse_mismatch:    key 可用（availableKeyCount > 0）但 fetched === 0（解析可能有问题）
 *  - ok:               以上均不满足
 *
 * @param platforms - 各平台本次运行输入
 * @returns 整体 + 逐平台健康度
 */
export function computeRunHealth(platforms: PlatformRunInput[]): RunHealthResult {
  const platformResults: PlatformHealth[] = platforms.map((p) => {
    let health: RunHealthKind;
    let message: string;

    if (p.keyCount === 0) {
      health = 'no_keys';
      message = `平台 ${p.platformName} 未配置任何 Key`;
    } else if (p.availableKeyCount === 0) {
      health = 'all_keys_cooldown';
      message = `平台 ${p.platformName} 所有 Key 均冷却中`;
    } else if (p.fetched === 0) {
      health = 'parse_mismatch';
      message = `平台 ${p.platformName} 请求成功但解析到 0 条视频，请检查解析配置`;
    } else {
      health = 'ok';
      message = `平台 ${p.platformName} 运行正常`;
    }

    return { platformId: p.platformId, platformName: p.platformName, health, message };
  });

  const overall = worstOf(...platformResults.map((r) => r.health));
  const warnings = platformResults.filter((r) => r.health !== 'ok');

  return { overall, platforms: platformResults, warnings };
}
