// materialUpdateService.ts — 核心编排：读配置 → 并发 curl → 解析 → 去重 → 下发 Python Worker
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { getConfig } from '@social-media/shared-config';
import { logger } from '../lib/logger';
import {
  getMaterialUpdateConfig,
  saveKeyCooldownState,
  type MaterialUpdateConfig,
  type Platform,
} from './materialUpdateConfig';
import { parseVideoList, type ParsedVideo } from './materialParser';
import { KeyPoolManager } from './materialKeyPool';

// 运行态
interface RunState {
  running: boolean;
  lastRunAt: number | null;
  lastResult: Record<string, { fetched: number; newCandidates: number; errors: string[] }>;
}

const runState: RunState = {
  running: false,
  lastRunAt: null,
  lastResult: {},
};

export function isRunning(): boolean {
  return runState.running;
}

export function getRunState(): RunState {
  return { ...runState };
}

/**
 * 注入占位符到字符串（URL 编码 key 值）。
 */
function injectPlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    result = result.replace(regex, encodeURIComponent(value));
  }
  return result;
}

/**
 * 对单个平台执行采集。
 */
async function fetchPlatform(
  platform: Platform,
  config: MaterialUpdateConfig,
  cooldownState: ReturnType<KeyPoolManager['getCooldownState']>,
): Promise<{ videos: ParsedVideo[]; newCooldownState: ReturnType<KeyPoolManager['getCooldownState']> }> {
  const keyMgr = new KeyPoolManager(platform.id, platform.keyPool, cooldownState);
  const allVideos: ParsedVideo[] = [];

  const maxPages = platform.request.maxPages || 1;

  for (let page = 1; page <= maxPages; page++) {
    const key = keyMgr.selectKey();
    if (!key) {
      logger.warn(`[materialUpdate] 平台 ${platform.id} 所有 key 已冷却，跳过剩余分页`);
      break;
    }

    const vars: Record<string, string> = {
      [platform.keyPool.placeholder]: key,
      PAGE: String(page),
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
      const response = await axios({
        method: platform.request.method,
        url,
        headers,
        params,
        data: platform.request.body ? JSON.parse(platform.request.body) : undefined,
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
 */
async function dispatchToPython(
  candidateId: string,
  videoUrl: string,
  platformId: string,
  config: MaterialUpdateConfig,
): Promise<void> {
  const appConfig = getConfig();
  const payload = {
    task_id: candidateId,
    task_type: 'material_update',
    candidate_id: candidateId,
    video_url: videoUrl,
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
    logger.info(`[materialUpdate] 候选 ${candidateId} 已下发 Python Worker`);
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
 * 执行一次全量采集（cron 和手动触发共享此入口）。
 */
export async function runMaterialUpdate(): Promise<void> {
  if (runState.running) {
    logger.warn('[materialUpdate] 已在运行中，跳过本次触发');
    return;
  }

  runState.running = true;
  runState.lastRunAt = Date.now();
  runState.lastResult = {};

  // 每次执行时读取最新配置（不在模块顶层缓存）
  const config = getMaterialUpdateConfig();
  const enabledPlatforms = config.platforms.filter((p) => p.enabled);

  logger.info(`[materialUpdate] 开始采集，${enabledPlatforms.length} 个启用平台`);

  // 合并所有平台的冷却状态
  let mergedCooldownState = { ...config.keyCooldownState };

  // 并发采集各平台
  const platformResults = await Promise.allSettled(
    enabledPlatforms.map(async (platform) => {
      const result = await fetchPlatform(platform, config, mergedCooldownState);
      // 合并冷却状态
      mergedCooldownState = result.newCooldownState;
      return { platform, videos: result.videos };
    }),
  );

  // 持久化冷却状态
  saveKeyCooldownState(mergedCooldownState);

  // 去重 upsert + 下发新候选
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
            playCount: video.playCount || null,
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

        // 仅新候选或重新处理的候选才下发
        if (!existing || isReprocess) {
          if (candidate.videoUrl) {
            await prisma.hotVideoCandidate.update({
              where: { id: candidate.id },
              data: { status: 'processing' },
            });
            await dispatchToPython(candidate.id, candidate.videoUrl!, platform.id, config);
            newCount++;
          }
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

  runState.running = false;
  logger.info(`[materialUpdate] 采集完成: ${JSON.stringify(runState.lastResult)}`);
}

/**
 * 测试单个平台配置（回显解析结果，不下发不写库）。
 */
export async function testPlatform(platform: Platform): Promise<{ videos: ParsedVideo[]; rawResponse: unknown }> {
  const config = getMaterialUpdateConfig();
  const emptyCooldown: ReturnType<KeyPoolManager['getCooldownState']> = {};
  const result = await fetchPlatform(platform, config, emptyCooldown);
  return { videos: result.videos, rawResponse: null };
}
