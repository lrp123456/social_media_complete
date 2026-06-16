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
  target: { text: string; level: number; createTime: number; rootText?: string; rootUsername?: string; rootReplyCount?: number; username?: string };
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
    return status?.isDebugMode ?? false;
  } catch {
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
  target: { text: string; level: number; createTime: number; rootText?: string; rootUsername?: string; rootReplyCount?: number; username?: string },
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
        const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });
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
