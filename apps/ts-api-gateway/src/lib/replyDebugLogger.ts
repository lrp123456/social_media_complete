// @ts-api-gateway/lib/replyDebugLogger.ts - 回复流程调试快照工具

import { Page } from 'patchright';
import { prisma } from './prisma';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('reply-debug');

const DEBUG_DIR = path.resolve(process.cwd(), 'data', 'reply_debug');

/** 调试快照 manifest 结构 */
export interface DebugManifest {
  sessionId: string;
  startTime: string;
  target: { text: string; level: number; createTime: number; rootText?: string };
  steps: Array<{
    step: number;
    label: string;
    timestamp: string;
    htmlFile?: string;
    screenshotFile?: string;
    url: string;
    extra?: Record<string, any>;
  }>;
  result?: { success: boolean; totalSteps: number; elapsedMs: number };
}

/** 检查调试模式是否启用（读取 SystemStatus.isDebugMode） */
export async function isDebugModeEnabled(): Promise<boolean> {
  try {
    const status = await prisma.systemStatus.findFirst();
    const enabled = status?.isDebugMode ?? false;
    if (!enabled) {
      // 用户可能刚切换了开关但 DB 还没刷新 / API gateway 缓存了旧值，记录一次帮助排查
      logger.debug({ statusRow: status?.id ?? 'no-row', isDebugMode: enabled }, '[ReplyDebug] Debug mode OFF');
    } else {
      logger.info({ statusRow: status?.id ?? 'no-row' }, '[ReplyDebug] Debug mode ON — snapshots will be saved');
    }
    return enabled;
  } catch (err: any) {
    // ★ Bugfix: 原本 catch {} 静默吞错，导致 DB 读取失败时调试模式静默关闭
    // 现在记 warn，至少能在日志里看到
    logger.warn({ error: err.message, code: err.code }, '[ReplyDebug] Failed to read SystemStatus, defaulting debug OFF');
    return false;
  }
}

/** 创建回复调试会话 ID */
export function createReplySessionId(target: { text: string; createTime: number; level: number }): string {
  const safeText = target.text.slice(0, 20).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return `reply_${safeText}_${target.createTime}_${Date.now()}`;
}

/** 创建初始 manifest */
export function createManifest(
  sessionId: string,
  target: { text: string; level: number; createTime: number; rootText?: string },
): DebugManifest {
  return {
    sessionId,
    startTime: new Date().toISOString(),
    target,
    steps: [],
  };
}

/** 保存调试快照（DOM HTML + 截图） */
export async function saveDebugSnapshot(options: {
  page: Page;
  stepLabel: string;
  sessionId: string;
  stepIndex: number;
  manifest: DebugManifest;
  saveScreenshot?: boolean;
  saveDomHtml?: boolean;
  extra?: Record<string, any>;
}): Promise<void> {
  const { page, stepLabel, sessionId, stepIndex, manifest, saveScreenshot = true, saveDomHtml = true, extra } = options;

  try {
    const sessionDir = path.join(DEBUG_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const timestamp = Date.now();
    const prefix = `${String(stepIndex).padStart(2, '0')}_${stepLabel}_${timestamp}`;
    let htmlFile: string | undefined;
    let screenshotFile: string | undefined;

    if (saveDomHtml) {
      try {
        const html = await page.content();
        htmlFile = `${prefix}.html`;
        fs.writeFileSync(path.join(sessionDir, htmlFile), html, 'utf-8');
      } catch (err: any) {
        logger.warn({ stepLabel, error: err.message }, 'Failed to save DOM HTML');
      }
    }

    if (saveScreenshot) {
      try {
        // 短超时（5s）+ 不等字体加载，避免阻塞回复主流程
        // 之前 30s 默认超时 + 等字体加载 在快手页面会卡死，导致锁长时间不释放
        const screenshotBuffer = await page.screenshot({ 
          fullPage: false, 
          type: 'png',
          timeout: 5000,
          animations: 'disabled',
          caret: 'hide',
        });
        screenshotFile = `${prefix}.png`;
        fs.writeFileSync(path.join(sessionDir, screenshotFile), screenshotBuffer);
      } catch (err: any) {
        logger.warn({ stepLabel, error: err.message }, 'Failed to save screenshot');
      }
    }

    manifest.steps.push({
      step: stepIndex,
      label: stepLabel,
      timestamp: new Date().toISOString(),
      htmlFile,
      screenshotFile,
      url: page.url(),
      extra,
    });

    // 每次更新都写入 manifest.json，防止中途失败丢失信息
    fs.writeFileSync(
      path.join(sessionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    logger.info({ stepLabel, stepIndex, sessionId, htmlFile, screenshotFile }, 'Debug snapshot saved');
  } catch (err: any) {
    logger.warn({ stepLabel, error: err.message }, 'Failed to save debug snapshot');
  }
}

/** 完成调试会话（写入最终结果） */
export function finishManifest(manifest: DebugManifest, success: boolean): void {
  manifest.result = {
    success,
    totalSteps: manifest.steps.length,
    elapsedMs: Date.now() - new Date(manifest.startTime).getTime(),
  };

  try {
    const sessionDir = path.join(DEBUG_DIR, manifest.sessionId);
    fs.writeFileSync(
      path.join(sessionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  } catch {}
}
