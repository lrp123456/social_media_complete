// materialUpdateService.ts — 核心编排：读配置 → 并发 curl → 解析 → 去重 → 视频下载 → 下发 Python Worker
import path from 'path';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { getConfig } from '@social-media/shared-config';
import { logger } from '../lib/logger';
import {
  getMaterialUpdateConfig,
  saveKeyCooldownState,
  type MaterialUpdateConfig,
  type Platform,
  type StyleDef,
} from './materialUpdateConfig';
import { parseVideoList, type ParsedVideo } from './materialParser';
import { KeyPoolManager } from './materialKeyPool';
import {
  injectPlaceholders,
  injectBodyPlaceholders,
  resolveQuery,
  runStyleSelection,
} from './materialUpdateInjection';
import { downloadVideo } from './videoStorageService';
import { computeRunHealth, type RunHealthKind, type PlatformRunInput } from './materialRunHealth';

// === PR3: Warning 类型 ===
export interface RunWarning {
  kind: 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch';
  platformId: string;
  platformName: string;
  message: string;
}

// 运行态
interface RunState {
  running: boolean;
  lastRunAt: number | null;
  lastResult: Record<string, { fetched: number; newCandidates: number; errors: string[] }>;
  runHealth: RunHealthKind;
  warnings: RunWarning[];
}

const runState: RunState = {
  running: false,
  lastRunAt: null,
  lastResult: {},
  runHealth: 'ok',
  warnings: [],
};

export function isRunning(): boolean {
  return runState.running;
}

export function getRunState(): RunState {
  return { ...runState };
}

/**
 * 对单个平台执行采集。
 *
 * 接受可选的 style 和 count，用于注入 {{QUERY}} 和 {{COUNT}} 占位符。
 * body 处理：先通过 injectBodyPlaceholders 注入占位符，再 JSON.parse。
 */
async function fetchPlatform(
  platform: Platform,
  config: MaterialUpdateConfig,
  cooldownState: ReturnType<KeyPoolManager['getCooldownState']>,
  style?: StyleDef | null,
  count: number = 50,
): Promise<{ videos: ParsedVideo[]; newCooldownState: ReturnType<KeyPoolManager['getCooldownState']> }> {
  const keyMgr = new KeyPoolManager(platform.id, platform.keyPool, cooldownState);
  const allVideos: ParsedVideo[] = [];

  const maxPages = platform.request.maxPages || 1;

  // 构造占位符变量（含 QUERY / COUNT）
  const query = style ? resolveQuery(style, platform.id) : '';

  for (let page = 1; page <= maxPages; page++) {
    const key = keyMgr.selectKey();
    if (!key) {
      logger.warn(`[materialUpdate] 平台 ${platform.id} 所有 key 已冷却，跳过剩余分页`);
      break;
    }

    const vars: Record<string, string> = {
      [platform.keyPool.placeholder]: key,
      PAGE: String(page),
      QUERY: query,
      COUNT: String(count),
    };

    const url = injectPlaceholders(platform.request.url, vars);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.request.headers)) {
      headers[k] = injectPlaceholders(v, vars);
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.request.params)) {
      params[k] = injectPlaceholders(v, vars);
    }

    try {
      // body：先注入占位符再 JSON.parse（§5.2）
      let data: unknown = undefined;
      if (platform.request.body) {
        const injectedBody = injectBodyPlaceholders(platform.request.body, vars);
        data = JSON.parse(injectedBody);
      }

      const response = await axios({
        method: platform.request.method,
        url,
        headers,
        params,
        data,
        timeout: platform.request.timeoutMs || 30000,
        validateStatus: () => true, // 不抛异常，手动检查状态码
      });

      // HTTP 状态码检测
      if (KeyPoolManager.shouldCooldownByStatus(response.status)) {
        logger.warn(`[materialUpdate] 平台 ${platform.id} key=${key.slice(0, 8)}... HTTP ${response.status}，冷却`);
        keyMgr.markCooldown(key);
        continue; // 尝试下一个 key
      }

      // 响应体错误检测
      if (keyMgr.isBodyError(response.data)) {
        logger.warn(`[materialUpdate] 平台 ${platform.id} key=${key.slice(0, 8)}... 响应体限流错误，冷却`);
        keyMgr.markCooldown(key);
        continue;
      }

      // 解析
      const videos = parseVideoList(response.data, platform.parse);
      allVideos.push(...videos);
      logger.info(`[materialUpdate] 平台 ${platform.id} 第 ${page} 页: ${videos.length} 条`);
    } catch (err) {
      logger.error(`[materialUpdate] 平台 ${platform.id} 第 ${page} 页请求失败: ${err}`);
    }
  }

  return { videos: allVideos, newCooldownState: keyMgr.getCooldownState() };
}

/**
 * 下发候选视频到 Python Worker。
 * @param localPath - 视频本地绝对路径（若已下载），null 表示用 video_url
 */
async function dispatchToPython(
  candidateId: string,
  videoUrl: string,
  localPath: string | null,
  platformId: string,
  config: MaterialUpdateConfig,
): Promise<void> {
  const appConfig = getConfig();
  const payload: Record<string, unknown> = {
    task_id: candidateId,
    task_type: 'material_update',
    candidate_id: candidateId,
    video_url: videoUrl,
    local_path: localPath, // 优先读本地，回退 video_url
    platform: platformId,
    oss_urls: [],
    frame_interval_ms: config.processing.frameIntervalMs,
    evaluate_prompt: config.processing.evaluatePrompt,
    styles: config.processing.styles,
    min_rating: config.processing.minRating,
  };

  try {
    await axios.post(
      `${appConfig.PYTHON_WORKER_URL}/api/v1/tasks/material-update`,
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    logger.info(`[materialUpdate] 候选 ${candidateId} 已下发 Python Worker${localPath ? ` (local_path=${localPath})` : ' (video_url 回退)'}`);
  } catch (err) {
    logger.error(`[materialUpdate] 候选 ${candidateId} 下发失败: ${err}`);
    // 标记为 pending 以便后续重试
    await prisma.hotVideoCandidate.update({
      where: { id: candidateId },
      data: { status: 'pending' },
    });
  }
}

/**
 * 对一轮采集结果执行去重 upsert + 视频下载 + 下发 Python Worker。
 * 注意：不再写入 playCount（DB 列保留兼容历史）。
 *
 * PR2: 在 dispatchToPython 之前先下载视频。
 * - 下载成功 → storageStatus='pending_downloaded' + storagePath 写入
 * - 下载失败 → storageStatus='failed' + failReason，候选直接 rejected，不下发 Python
 * - storage.enabled=false → 跳过下载，仍用 video_url 下发（向后兼容）
 */
async function processPlatformResults(
  platformResults: Array<PromiseSettledResult<{ platform: Platform; videos: ParsedVideo[] }>>,
  config: MaterialUpdateConfig,
): Promise<void> {
  for (const settled of platformResults) {
    if (settled.status !== 'fulfilled') continue;
    const { platform, videos } = settled.value;
    const errors: string[] = [];
    let newCount = 0;

    for (const video of videos) {
      if (!video.videoId) continue;

      try {
        // upsert：已存在且 status !== 'rejected' 跳过；rejected 允许重新处理
        const existing = await prisma.hotVideoCandidate.findUnique({
          where: { uq_hot_video_platform_video: { platform: platform.id, videoId: video.videoId } },
        });

        if (existing && existing.status !== 'rejected') {
          continue; // 已存在且非 rejected，跳过
        }

        const isReprocess = existing?.status === 'rejected';

        const candidate = await prisma.hotVideoCandidate.upsert({
          where: { uq_hot_video_platform_video: { platform: platform.id, videoId: video.videoId } },
          create: {
            platform: platform.id,
            videoId: video.videoId,
            title: video.title || null,
            author: video.author || null,
            // playCount 不再写入（DB 列保留兼容历史）
            cover: video.cover || null,
            videoUrl: video.videoUrl || null,
            publishTime: video.publishTime ? new Date(video.publishTime) : null,
            rawJson: (video as any).rawJson || null,
            status: video.videoUrl ? 'pending' : 'no_url',
          },
          update: isReprocess
            ? { status: video.videoUrl ? 'pending' : 'no_url', style: null, fetchedAt: new Date() }
            : {},
        });

        // 仅新候选或重新处理的候选才处理
        if (!existing || isReprocess) {
          if (!candidate.videoUrl) continue;

          // PR2: 视频下载（仅 storage.enabled=true 时执行）
          let localPath: string | null = null;
          if (config.storage.enabled) {
            try {
              const relativePath = await downloadVideo(
                candidate.videoUrl,
                config.storage.rootPath,
                platform.id,
                video.videoId,
              );
              localPath = path.resolve(config.storage.rootPath, relativePath);

              await prisma.hotVideoCandidate.update({
                where: { id: candidate.id },
                data: {
                  storagePath: relativePath,
                  storageStatus: 'pending_downloaded',
                },
              });
              logger.info(`[materialUpdate] 候选 ${candidate.id} 视频下载成功: ${relativePath}`);
            } catch (downloadErr) {
              // 下载失败 → 标记 failed + rejected，不下发 Python
              logger.error(`[materialUpdate] 候选 ${candidate.id} 视频下载失败: ${downloadErr}`);
              await prisma.hotVideoCandidate.update({
                where: { id: candidate.id },
                data: {
                  status: 'rejected',
                  storageStatus: 'failed',
                  failReason: String(downloadErr),
                },
              });
              errors.push(`下载失败: ${downloadErr}`);
              continue; // 不再下发 Python
            }
          }

          // 标记 processing 并下发 Python Worker
          await prisma.hotVideoCandidate.update({
            where: { id: candidate.id },
            data: { status: 'processing' },
          });

          await dispatchToPython(candidate.id, candidate.videoUrl, localPath, platform.id, config);
          newCount++;
        }
      } catch (err) {
        errors.push(String(err));
      }
    }

    runState.lastResult[platform.id] = {
      fetched: videos.length,
      newCandidates: newCount,
      errors,
    };
  }
}

/**
 * 执行一轮采集（针对单个风格）。
 *
 * 1. 并发采集各平台（每个平台用初始冷却状态独立执行，无竞态）
 * 2. 收集所有结果后统一合并冷却状态
 * 3. 去重 upsert + 下发 Python Worker
 */
async function runSingleRound(
  config: MaterialUpdateConfig,
  style: StyleDef | null,
  count: number,
): Promise<void> {
  const enabledPlatforms = config.platforms.filter((p) => p.enabled);
  if (enabledPlatforms.length === 0) {
    logger.info('[materialUpdate] 没有启用的平台，跳过本轮');
    return;
  }

  const styleLabel = style ? style.dir : '无风格';
  logger.info(`[materialUpdate] 开始风格「${styleLabel}」采集，${enabledPlatforms.length} 个启用平台`);

  // 并发修复：每个平台用初始冷却状态独立执行，不共享可变引用（§5.5）
  const initialCooldownState = { ...config.keyCooldownState };

  const platformResults = await Promise.allSettled(
    enabledPlatforms.map(async (platform) => {
      const result = await fetchPlatform(platform, config, initialCooldownState, style, count);
      return { platform, videos: result.videos, cooldownState: result.newCooldownState };
    }),
  );

  // 收集所有结果后统一合并冷却状态
  const finalCooldownState = (platformResults
    .filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{ platform: Platform; videos: ParsedVideo[]; cooldownState: ReturnType<KeyPoolManager['getCooldownState']> }>>)
    .reduce((acc, r) => ({ ...acc, ...r.value.cooldownState }), { ...initialCooldownState });

  saveKeyCooldownState(finalCooldownState);

  // 去重 upsert + 下发
  await processPlatformResults(platformResults, config);
}

/**
 * 执行一次全量采集（cron 和手动触发共享此入口）。
 *
 * @param options.styleDir - 可选，指定要采集的风格目录
 * @param options.count - 可选，{{COUNT}} 取值（默认 50）
 */
export async function runMaterialUpdate(options?: { styleDir?: string; count?: number }): Promise<void> {
  if (runState.running) {
    logger.warn('[materialUpdate] 已在运行中，跳过本次触发');
    return;
  }

  runState.running = true;
  runState.lastRunAt = Date.now();
  runState.lastResult = {};

  // 每次执行时读取最新配置（不在模块顶层缓存）
  const config = getMaterialUpdateConfig();
  const styles = runStyleSelection(config.processing.styles, options?.styleDir);
  const count = options?.count ?? 50;

  if (styles.length > 0) {
    for (const style of styles) {
      await runSingleRound(config, style, count);
    }
  } else {
    // 无风格（用户未配置任何风格），仍执行一次（不注入 {{QUERY}}）
    await runSingleRound(config, null, count);
  }

  // PR3: 计算运行健康度
  const healthInputs: PlatformRunInput[] = config.platforms
    .filter((p) => p.enabled)
    .map((p) => {
      const state = config.keyCooldownState[p.id] || {};
      const availableCount = p.keyPool.keys.filter((k) => !(state[k] && state[k] > Date.now())).length;
      return {
        platformId: p.id,
        platformName: p.name,
        keyCount: p.keyPool.keys.length,
        availableKeyCount: availableCount,
        fetched: runState.lastResult[p.id]?.fetched ?? 0,
      };
    });

  const health = computeRunHealth(healthInputs);
  runState.warnings = health.warnings.map((w) => ({
    kind: w.health as RunWarning['kind'],
    platformId: w.platformId,
    platformName: w.platformName,
    message: w.message,
  }));
  runState.runHealth = health.overall;

  runState.running = false;
  logger.info(`[materialUpdate] 采集完成: runHealth=${health.overall}, warnings=${health.warnings.length}`);
}

/**
 * 测试单个平台配置（回显解析结果，不下发不写库）。
 */
export async function testPlatform(platform: Platform): Promise<{ videos: ParsedVideo[]; rawResponse: unknown }> {
  const config = getMaterialUpdateConfig();
  const emptyCooldown: ReturnType<KeyPoolManager['getCooldownState']> = {};
  const result = await fetchPlatform(platform, config, emptyCooldown, null, 50);
  return { videos: result.videos, rawResponse: null };
}
