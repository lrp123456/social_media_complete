// @ts-api-gateway/lib/browserManager.ts - BrowserManager 单例
// 所有 CDP 连接（发布/监控/Pinterest）共享同一指纹浏览器窗口会话池

import fs from 'fs';
import path from 'path';
import { BrowserManager, BitWindowOpener } from '@social-media/browser-core';
import { createLogger } from './logger';

const logger = createLogger('browser-manager');

let instance: BrowserManager | null = null;

/** 加载 data/infra-overrides.json 中的覆盖值到 process.env */
function loadInfraOverrides(): void {
  const overridesFile = path.resolve(process.cwd(), 'data', 'infra-overrides.json');
  try {
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf-8'));
    for (const [k, v] of Object.entries(overrides)) {
      process.env[k] = String(v);
    }
  } catch { /* file may not exist */ }
}

/** 重建 BrowserManager 单例（用于 config-infra 热重载后更新端口/密钥） */
export function resetBrowserManager(): void {
  if (instance) {
    logger.info('BrowserManager 单例已销毁，下次调用将重建');
    instance = null;
  }
}

export function getBrowserManager(): BrowserManager {
  if (!instance) {
    loadInfraOverrides();
    // RoxyBrowser API: 从环境变量提取端口和密钥
    const roxyUrl = process.env.ROXY_BROWSER_URL || 'http://localhost:54345';
    const portMatch = roxyUrl.match(/:(\d+)/);
    const apiPort = portMatch ? parseInt(portMatch[1], 10) : 54345;
    const apiKey = process.env.ROXY_BROWSER_KEY || '';

    if (!apiKey) {
      logger.warn('ROXY_BROWSER_KEY 未设置, CDP 连接可能失败');
    }

    instance = new BrowserManager(apiPort, apiKey);

    // 注册 BitBrowser 窗口开启器
    const bitUrl = process.env.BIT_BROWSER_URL;
    if (bitUrl) {
      instance.registerOpener(new BitWindowOpener(bitUrl));
      logger.info({ bitUrl }, 'BitBrowser opener registered');
    }

    // 注册 vendor 解析器：从数据库查询 windowId 对应的 browserVendor
    instance.setVendorResolver(async (windowId: string) => {
      try {
        const { prisma } = require('./prisma');
        const window = await prisma.browserWindow.findFirst({
          where: { externalId: windowId },
          select: { browserVendor: true },
        });
        return window?.browserVendor || null;
      } catch (err: any) {
        logger.warn({ windowId, error: err.message }, 'Failed to resolve vendor from database');
        return null;
      }
    });

    logger.info({ apiPort, hasKey: !!apiKey, hasBit: !!bitUrl }, 'BrowserManager 单例已创建');
  }
  return instance;
}
