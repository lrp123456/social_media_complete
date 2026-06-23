// @ts-api-gateway/services/loginFlowHelpers.ts
// LoginTabRegistry 单例 + selectors.json 登录流配置读取
import { LoginTabRegistry } from '@social-media/browser-core';
import type { LoginFlowConfig } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';

/** LoginTabRegistry 单例 */
export const loginTabRegistry = new LoginTabRegistry();

/**
 * 从 selectors.json 读取指定平台的 loginFlows 配置。
 */
export function loadLoginFlowConfig(platform: string): LoginFlowConfig[] {
  const reader = getSelectorReader();
  const cfg = reader.getConfig();
  const p = (cfg.platforms as any)?.[platform];
  if (!p?.loginFlows) return [];

  const result: LoginFlowConfig[] = [];
  for (const [flowId, entry] of Object.entries(p.loginFlows) as [string, any][]) {
    result.push({
      domain: entry.domain || '',
      label: entry.label || flowId,
      loginUrl: entry.loginUrl || '',
      closeOnLoginSuccess: entry.closeOnLoginSuccess ?? false,
      loggedOutIndicators: entry.loggedOutIndicators || [],
      loggedInIndicators: entry.loggedInIndicators || [],
      qrSelectors: entry.qrSelectors || [],
    });
  }
  return result;
}

/**
 * 根据 flowId 获取单个 loginFlow 配置。
 */
export function getLoginFlowConfig(platform: string, flowId: string): LoginFlowConfig | null {
  const reader = getSelectorReader();
  const cfg = reader.getConfig();
  const p = (cfg.platforms as any)?.[platform];
  if (!p?.loginFlows?.[flowId]) return null;

  const entry = p.loginFlows[flowId];
  return {
    domain: entry.domain || '',
    label: entry.label || flowId,
    loginUrl: entry.loginUrl || '',
    closeOnLoginSuccess: entry.closeOnLoginSuccess ?? false,
    loggedOutIndicators: entry.loggedOutIndicators || [],
    loggedInIndicators: entry.loggedInIndicators || [],
    qrSelectors: entry.qrSelectors || [],
  };
}

/**
 * 获取某个平台的所有 flowId 列表。
 */
export function getFlowIdsForPlatform(platform: string): string[] {
  const reader = getSelectorReader();
  const cfg = reader.getConfig();
  const p = (cfg.platforms as any)?.[platform];
  if (!p?.loginFlows) return [];
  return Object.keys(p.loginFlows);
}

/**
 * 平台特定的 QR 切换操作：某些平台登录页默认显示密码登录，需要点击切换按钮才显示 QR。
 */
const PLATFORM_QR_SWITCH: Record<string, string> = {
  kuaishou: 'div.platform-switch',
};

/**
 * 查找或创建登录标签页，并执行平台特定的 QR 切换操作。
 * 供 wechatBotService 刷新/强制刷新、monitorService sendLoginQR 共用。
 * 返回 LoginTabRecord 或 null。调用方可通过 getLoginFlowConfig 获取 config。
 */
export async function ensureLoginTab(
  windowId: string,
  userId: number,
  platform: string,
  flowId: string = 'creator',
): Promise<import('@social-media/browser-core').LoginTabRecord | null> {
  const config = getLoginFlowConfig(platform, flowId);
  if (!config) return null;

  const { getBrowserManager } = await import('../lib/browserManager');
  const bm = getBrowserManager();
  const browser = await bm.getBrowser(windowId);
  if (!browser) return null;

  // 1. 查找已有登录标签页
  let record = await loginTabRegistry.find(windowId, flowId, browser, config.domain);
  // 2. 未找到则打开新标签页
  if (!record) {
    record = await loginTabRegistry.openLoginTab(windowId, userId, flowId, browser, config);
  }
  if (!record) return null;

  // 3. 平台特定：点击 QR 切换按钮
  const switchSelector = PLATFORM_QR_SWITCH[platform];
  if (switchSelector) {
    try {
      const switchEl = await record.page.$(switchSelector);
      if (switchEl) {
        await switchEl.click();
        await new Promise(r => setTimeout(r, 2000));
        console.info(`[ensureLoginTab] clicked QR switch "${switchSelector}" for ${platform}`);
      }
    } catch { /* switch may not be needed */ }
  }

  return record;
}
