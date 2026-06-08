// @ts-api-gateway/lib/browserManager.ts - BrowserManager 单例
// 所有 CDP 连接（发布/监控/Pinterest）共享同一指纹浏览器窗口会话池

import { BrowserManager } from '@social-media/browser-core';
import { createLogger } from './logger';

const logger = createLogger('browser-manager');

let instance: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!instance) {
    // RoxyBrowser API: 从环境变量提取端口和密钥
    const roxyUrl = process.env.ROXY_BROWSER_URL || 'http://localhost:54345';
    const portMatch = roxyUrl.match(/:(\d+)/);
    const apiPort = portMatch ? parseInt(portMatch[1], 10) : 54345;
    const apiKey = process.env.ROXY_BROWSER_KEY || '';

    if (!apiKey) {
      logger.warn('ROXY_BROWSER_KEY 未设置, CDP 连接可能失败');
    }

    instance = new BrowserManager(apiPort, apiKey);
    logger.info({ apiPort, hasKey: !!apiKey }, 'BrowserManager 单例已创建');
  }
  return instance;
}
