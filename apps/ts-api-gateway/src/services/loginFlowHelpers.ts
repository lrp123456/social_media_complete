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
