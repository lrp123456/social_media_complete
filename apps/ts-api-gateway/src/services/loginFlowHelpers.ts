// @ts-api-gateway/services/loginFlowHelpers.ts
// LoginTabRegistry 单例 + selectors.json 登录流配置读取
import { LoginTabRegistry, getLoginHost, isOnLoginDomain } from '@social-media/browser-core';
import type { LoginFlowConfig } from '@social-media/browser-core';
import { HumanActions } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';
import { isAntiDetectionV2 } from '../lib/antiDetectionMode';

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
      qrActivationSelector: entry.qrActivationSelector || undefined,
      qrRefreshSelector: entry.qrRefreshSelector || undefined,
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
    qrActivationSelector: entry.qrActivationSelector || undefined,
    qrRefreshSelector: entry.qrRefreshSelector || undefined,
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
  const loginHost = getLoginHost(config.loginUrl, config.domain);
  let record = await loginTabRegistry.find(windowId, platform, flowId, browser, loginHost);
  // 2. 未找到则优先复用监控已打开的同域名平台 tab（不新建连接/tab）
  if (!record) {
    try {
      const ctx = browser.contexts()[0];
      if (ctx) {
        for (const page of ctx.pages()) {
          try {
            const url = page.url();
            if (!isOnLoginDomain(url, loginHost)) continue;
            // 排除已带登录标记的页，避免误复用旧登录 tab
            const mark = await page.evaluate(({ markKey }: { markKey: string }) => {
              const raw = localStorage.getItem(markKey);
              return raw ? JSON.parse(raw) : null;
            }, { markKey: '__login_tab_mark__' }).catch(() => null);
            if (mark && mark.platform === platform && mark.flowId === flowId) continue;
            // 复用：导航到登录页并写入标记
            await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            const markData = JSON.stringify({ flowId, platform, userId, openedAt: Date.now(), loginUrl: config.loginUrl });
            await page.evaluate(({ data, markKey }: { data: string; markKey: string }) => {
              localStorage.setItem(markKey, data);
            }, { data: markData, markKey: '__login_tab_mark__' }).catch(() => {});
            record = {
              page, targetId: (page as any)._targetId || 'reused',
              domain: config.domain, flowId, platform,
              openedAt: Date.now(), userId, loginUrl: config.loginUrl,
            };
            loginTabRegistry.register(windowId, platform, flowId, record);
            console.info(`[ensureLoginTab] reused existing platform tab for ${platform} (${windowId}:${flowId})`);
            break;
          } catch { continue; }
        }
      }
    } catch (err: any) {
      console.warn(`[ensureLoginTab] reuse-platform-tab failed: ${err.message}`);
    }
  }
  // 3. 仍无可用页则打开新标签页
  if (!record) {
    record = await loginTabRegistry.openLoginTab(windowId, platform, userId, flowId, browser, config);
  }
  if (!record) return null;

  // 3. 平台特定：点击 QR 切换按钮或激活 QR 弹窗
  const switchSelector = PLATFORM_QR_SWITCH[platform];
  if (switchSelector) {
    try {
      if (isAntiDetectionV2()) {
        if (await HumanActions.cdpIsElementVisible(record.page, switchSelector)) {
          await HumanActions.cdpClick(record.page, switchSelector);
          await new Promise(r => setTimeout(r, 2000));
          console.info(`[ensureLoginTab] clicked QR switch "${switchSelector}" for ${platform}`);
        }
      } else {
        const switchEl = await record.page.$(switchSelector);
        if (switchEl) {
          await switchEl.click();
          await new Promise(r => setTimeout(r, 2000));
          console.info(`[ensureLoginTab] clicked QR switch "${switchSelector}" for ${platform}`);
        }
      }
    } catch { /* switch may not be needed */ }
  }
  // 4. 平台特定：QR 弹窗预激活（如小红书创作者中心需点缩略图）
  if (platform === 'xiaohongshu') {
    try {
      if (isAntiDetectionV2()) {
        if (!(await HumanActions.cdpIsElementVisible(record.page, 'div.css-dvxtzn'))) {
          if (await HumanActions.cdpIsElementVisible(record.page, 'img.css-wemwzq')) {
            await HumanActions.cdpClick(record.page, 'img.css-wemwzq');
            await new Promise(r => setTimeout(r, 2500));
            console.info('[ensureLoginTab] xiaohongshu QR modal activated via CDP click');
          }
        }
      } else {
        const alreadyOpen = await record.page.$('div.css-dvxtzn');
        if (!alreadyOpen) {
          const thumb = await record.page.$('img.css-wemwzq');
          if (thumb) {
            const box = await thumb.boundingBox();
            if (box) {
              await record.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            } else {
              await thumb.click();
            }
            await new Promise(r => setTimeout(r, 2500));
            console.info('[ensureLoginTab] xiaohongshu QR modal activated via CDP click');
          }
        }
      }
    } catch (err: any) {
      console.warn(`[ensureLoginTab] xiaohongshu QR activation failed: ${err.message}`);
    }
  }

  // 5. 通用：QR 码过期检测与刷新（快手等平台 QR 有时效限制）
  try {
    if (isAntiDetectionV2()) {
      if (await HumanActions.cdpIsElementVisible(record.page, '.qrcode-status-timeout, [class*="qrcode-status-timeout"]')) {
        if (await HumanActions.cdpIsElementVisible(record.page, '.qrcode-refresh, [class*="qrcode-refresh"], [class*="refresh"]')) {
          await HumanActions.cdpClick(record.page, '.qrcode-refresh, [class*="qrcode-refresh"], [class*="refresh"]');
          await new Promise(r => setTimeout(r, 3000));
          // 等待过期遮罩消失
          try {
            const start = Date.now();
            const timeoutMs = 5000;
            while (Date.now() - start < timeoutMs) {
              if (!(await HumanActions.cdpIsElementVisible(record.page, '.qrcode-status-timeout'))) break;
              await new Promise(r => setTimeout(r, 300));
            }
          } catch { /* 可能已消失 */ }
          console.info(`[ensureLoginTab] QR expired, clicked refresh for ${platform}`);
          // 如果刷新后仍然过期，再点一次
          if (await HumanActions.cdpIsElementVisible(record.page, '.qrcode-status-timeout')) {
            if (await HumanActions.cdpIsElementVisible(record.page, '.qrcode-refresh, [class*="qrcode-refresh"]')) {
              await HumanActions.cdpClick(record.page, '.qrcode-refresh, [class*="qrcode-refresh"]');
              await new Promise(r => setTimeout(r, 3000));
              console.info(`[ensureLoginTab] QR still expired, clicked refresh again for ${platform}`);
            }
          }
        }
      }
    } else {
      const timeoutOverlay = await record.page.$('.qrcode-status-timeout, [class*="qrcode-status-timeout"]');
      if (timeoutOverlay) {
        const refreshBtn = await record.page.$('.qrcode-refresh, [class*="qrcode-refresh"], [class*="refresh"]');
        if (refreshBtn) {
          await refreshBtn.click();
          await new Promise(r => setTimeout(r, 3000));
          // 等待过期遮罩消失
          try { await record.page.waitForSelector('.qrcode-status-timeout', { state: 'hidden', timeout: 5000 }); } catch { /* 可能已消失 */ }
          console.info(`[ensureLoginTab] QR expired, clicked refresh for ${platform}`);
          // 如果刷新后仍然过期，再点一次
          const stillTimeout = await record.page.$('.qrcode-status-timeout');
          if (stillTimeout) {
            const btn2 = await record.page.$('.qrcode-refresh, [class*="qrcode-refresh"]');
            if (btn2) {
              await btn2.click();
              await new Promise(r => setTimeout(r, 3000));
              console.info(`[ensureLoginTab] QR still expired, clicked refresh again for ${platform}`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[ensureLoginTab] QR timeout check failed for ${platform}: ${err.message}`);
  }

  return record;
}
