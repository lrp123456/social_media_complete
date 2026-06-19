// @ts-api-gateway/services/selectorEffectivenessService.ts
// 选择器有效性追踪服务 — 异步记录每个选择器策略的成功/失败情况
// 用于动态调整选择器优先级、发现失效选择器

import { getRedis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('selector-effectiveness');

// ============================================================
// 类型定义
// ============================================================

/** 选择器策略类型 */
export type SelectorStrategy =
  | 'primary'           // 主选择器
  | 'fallback-css'      // CSS回退
  | 'fallback-text'     // 文本回退
  | 'fallback-role'     // 角色回退
  | 'fallback-placeholder' // 占位符回退
  | 'fallback-xpath'    // XPath回退
  | 'spatial-filter'    // 空间过滤文本
  | 'unfiltered-text'   // 无过滤文本
  | 'scope-scoped'      // 作用域限定
  | 'page-search'       // 全页搜索
  | 'url-intercept';    // URL 监控拦截

/** 选择器使用记录 */
export interface SelectorUsageRecord {
  /** 平台 (douyin/kuaishou/xiaohongshu) */
  platform: string;
  /** 类别 (menus/buttons/regions/textboxes) */
  category: string;
  /** 选择器名称 */
  name: string;
  /** 使用的策略 */
  strategy: SelectorStrategy;
  /** 具体使用的选择器字符串 */
  selector: string;
  /** 是否成功 */
  success: boolean;
  /** 耗时(ms) */
  durationMs: number;
  /** 时间戳 */
  timestamp: number;
  /** 可选：错误信息 */
  error?: string;
  /** 可选：页面URL */
  pageUrl?: string;
  /** 可选：追踪ID */
  traceId?: string;
}

/** 选择器有效性统计 */
export interface SelectorEffectivenessStats {
  platform: string;
  category: string;
  name: string;
  strategy: string;
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastUsedAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
}

// ============================================================
// 内存缓冲区 — 批量写入Redis，减少IO
// ============================================================

const BUFFER_FLUSH_INTERVAL_MS = 30_000; // 30秒刷新一次
const BUFFER_MAX_SIZE = 100;             // 最大缓冲条数
const STATS_TTL_SECONDS = 7 * 24 * 3600; // 统计数据保留7天

let usageBuffer: SelectorUsageRecord[] = [];
let flushTimer: NodeJS.Timeout | null = null;

// ============================================================
// 核心API
// ============================================================

/**
 * 异步记录选择器使用情况（非阻塞，放入缓冲区）
 * 调用方无需await，不影响主流程性能
 */
export function reportSelectorUsage(record: SelectorUsageRecord): void {
  usageBuffer.push(record);

  // 缓冲区满时立即刷新
  if (usageBuffer.length >= BUFFER_MAX_SIZE) {
    flushBuffer().catch(err => {
      logger.warn({ error: err.message }, 'Failed to flush selector usage buffer');
    });
  }

  // 启动定时刷新（如果还没启动）
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushBuffer().catch(err => {
        logger.warn({ error: err.message }, 'Failed to flush selector usage buffer on timer');
      });
    }, BUFFER_FLUSH_INTERVAL_MS);
    // 允许进程退出时不需要等待定时器
    if (flushTimer.unref) {
      flushTimer.unref();
    }
  }
}

/**
 * 批量记录选择器使用情况
 */
export function reportSelectorUsageBatch(records: SelectorUsageRecord[]): void {
  for (const record of records) {
    usageBuffer.push(record);
  }
  if (usageBuffer.length >= BUFFER_MAX_SIZE) {
    flushBuffer().catch(err => {
      logger.warn({ error: err.message }, 'Failed to flush selector usage buffer');
    });
  }
}

/**
 * 查询选择器有效性统计
 * @param platform 平台过滤（可选）
 * @param category 类别过滤（可选）
 * @param name 名称过滤（可选）
 */
export async function getSelectorEffectiveness(
  platform?: string,
  category?: string,
  name?: string,
): Promise<SelectorEffectivenessStats[]> {
  try {
    const redis = getRedis();
    const pattern = buildStatsKeyPattern(platform, category, name);
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, batch] = await redis.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    const stats: SelectorEffectivenessStats[] = [];
    for (const key of keys) {
      const data = await redis.hgetall(key);
      if (data && data.platform) {
        stats.push({
          platform: data.platform,
          category: data.category,
          name: data.name,
          strategy: data.strategy,
          totalAttempts: parseInt(data.totalAttempts || '0', 10),
          successCount: parseInt(data.successCount || '0', 10),
          failureCount: parseInt(data.failureCount || '0', 10),
          successRate: parseFloat(data.successRate || '0'),
          avgDurationMs: parseFloat(data.avgDurationMs || '0'),
          lastUsedAt: parseInt(data.lastUsedAt || '0', 10),
          lastSuccessAt: parseInt(data.lastSuccessAt || '0', 10),
          lastFailureAt: parseInt(data.lastFailureAt || '0', 10),
        });
      }
    }

    return stats.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Failed to get selector effectiveness stats');
    return [];
  }
}

/**
 * 查询失效选择器（成功率低于阈值）
 */
export async function getFailedSelectors(
  threshold: number = 0.3,
  minAttempts: number = 5,
): Promise<SelectorEffectivenessStats[]> {
  const allStats = await getSelectorEffectiveness();
  return allStats.filter(
    s => s.totalAttempts >= minAttempts && s.successRate < threshold,
  );
}

/**
 * 查询每个选择器的最佳策略（成功率最高的）
 */
export async function getBestStrategies(
  platform?: string,
): Promise<Map<string, SelectorEffectivenessStats>> {
  const allStats = await getSelectorEffectiveness(platform);
  const bestMap = new Map<string, SelectorEffectivenessStats>();

  for (const stat of allStats) {
    const key = `${stat.platform}:${stat.category}:${stat.name}`;
    const existing = bestMap.get(key);
    if (!existing || stat.successRate > existing.successRate) {
      bestMap.set(key, stat);
    }
  }

  return bestMap;
}

// ============================================================
// 内部方法
// ============================================================

/**
 * 将缓冲区数据批量写入Redis
 */
async function flushBuffer(): Promise<void> {
  if (usageBuffer.length === 0) return;

  const records = [...usageBuffer];
  usageBuffer = [];

  try {
    const redis = getRedis();
    const pipeline = redis.pipeline();

    for (const record of records) {
      // 更新统计计数器
      const statsKey = buildStatsKey(record.platform, record.category, record.name, record.strategy);

      pipeline.hincrby(statsKey, 'totalAttempts', 1);
      if (record.success) {
        pipeline.hincrby(statsKey, 'successCount', 1);
        pipeline.hset(statsKey, 'lastSuccessAt', record.timestamp);
      } else {
        pipeline.hincrby(statsKey, 'failureCount', 1);
        pipeline.hset(statsKey, 'lastFailureAt', record.timestamp);
      }
      pipeline.hset(statsKey, 'lastUsedAt', record.timestamp);
      pipeline.hset(statsKey, 'platform', record.platform);
      pipeline.hset(statsKey, 'category', record.category);
      pipeline.hset(statsKey, 'name', record.name);
      pipeline.hset(statsKey, 'strategy', record.strategy);
      pipeline.expire(statsKey, STATS_TTL_SECONDS);

      // 记录最近的使用详情（用于调试）
      const detailKey = `selector:detail:${record.platform}:${record.category}:${record.name}`;
      pipeline.lpush(detailKey, JSON.stringify({
        strategy: record.strategy,
        selector: record.selector,
        success: record.success,
        durationMs: record.durationMs,
        timestamp: record.timestamp,
        error: record.error,
        pageUrl: record.pageUrl,
      }));
      pipeline.ltrim(detailKey, 0, 99); // 保留最近100条
      pipeline.expire(detailKey, STATS_TTL_SECONDS);
    }

    await pipeline.exec();
    logger.info({ count: records.length }, 'Flushed selector usage records to Redis');
  } catch (err) {
    logger.warn({ error: (err as Error).message, count: records.length }, 'Failed to flush selector usage to Redis');
    // 失败时放回缓冲区（最多保留BUFFER_MAX_SIZE条）
    usageBuffer = [...records.slice(-BUFFER_MAX_SIZE), ...usageBuffer].slice(-BUFFER_MAX_SIZE);
  }
}

function buildStatsKey(
  platform: string,
  category: string,
  name: string,
  strategy: string,
): string {
  return `selector:stats:${platform}:${category}:${name}:${strategy}`;
}

function buildStatsKeyPattern(
  platform?: string,
  category?: string,
  name?: string,
): string {
  return `selector:stats:${platform || '*'}:${category || '*'}:${name || '*'}:*`;
}

/**
 * 从选择器字符串推断策略类型
 */
export function inferStrategy(selector: string): SelectorStrategy {
  if (selector.startsWith('getByRole')) return 'fallback-role';
  if (selector.startsWith('getByText')) return 'fallback-text';
  if (selector.startsWith('getByPlaceholder')) return 'fallback-placeholder';
  if (selector.startsWith('text=')) return 'fallback-text';
  if (selector.startsWith('xpath=')) return 'fallback-xpath';
  if (selector.startsWith('.') || selector.startsWith('#') || selector.startsWith('[')) return 'fallback-css';
  return 'primary';
}

/**
 * 便捷方法：记录 tryClickBySelector 的结果
 */
export function reportClickResult(
  platform: string,
  category: string,
  name: string,
  strategy: SelectorStrategy,
  selector: string,
  success: boolean,
  durationMs: number,
  error?: string,
): void {
  reportSelectorUsage({
    platform,
    category,
    name,
    strategy,
    selector,
    success,
    durationMs,
    timestamp: Date.now(),
    error,
  });
}

/**
 * 便捷方法：记录 resolveAndClick 的结果
 */
export function reportNavigationResult(
  platform: string,
  submenuKey: string,
  success: boolean,
  durationMs: number,
  strategies: Array<{ strategy: SelectorStrategy; selector: string; success: boolean }>,
): void {
  for (const s of strategies) {
    reportSelectorUsage({
      platform,
      category: 'menus',
      name: submenuKey,
      strategy: s.strategy,
      selector: s.selector,
      success: s.success,
      durationMs,
      timestamp: Date.now(),
    });
  }
}

// ============================================================
// URL 监控有效性追踪 (v2.4+)
// ============================================================

/**
 * 便捷方法：记录 URL 监控拦截结果
 * Redis key: selector:stats:{platform}:urlMonitors:{monitorName}:url-intercept
 */
export function reportUrlMonitorUsage(
  platform: string,
  monitorName: string,
  success: boolean,
  itemsExtracted: number,
  durationMs: number,
  error?: string,
): void {
  reportSelectorUsage({
    platform,
    category: 'urlMonitors',
    name: monitorName,
    strategy: 'url-intercept',
    selector: `url-monitor:${monitorName}`,
    success,
    durationMs,
    timestamp: Date.now(),
    error,
  });
}

/**
 * 查询 URL 监控有效性统计
 */
export async function getUrlMonitorEffectiveness(
  platform?: string,
): Promise<SelectorEffectivenessStats[]> {
  return getSelectorEffectiveness(platform, 'urlMonitors');
}
