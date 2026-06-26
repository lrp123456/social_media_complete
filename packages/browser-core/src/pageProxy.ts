// @social-media/browser-core/pageProxy.ts
// 旁路报警器：对未收口到 HumanActions 的 page.evaluate/$/$$/locator 调用，
// 用 apply 拦截器在实际调用时记录旁路，不影响业务流程。

import type { Page } from 'patchright';
import { MaintenanceProbe } from './maintenanceProbe';

export const PROXY_INTERCEPT_METHODS = ['evaluate', 'evaluateHandle', '$', '$$', 'locator'] as const;

const EXCLUDED = new Set(['goto', 'screenshot', 'waitForTimeout', 'keyboard', 'mouse', 'fill']);

export function createProxiedPage(rawPage: Page, windowId: string): Page {
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const name = typeof prop === 'string' ? prop : String(prop);
      if (
        PROXY_INTERCEPT_METHODS.includes(name as any) &&
        !EXCLUDED.has(name) &&
        typeof value === 'function'
      ) {
        return new Proxy(value, {
          apply(fnTarget, thisArg, args) {
            void MaintenanceProbe.recordBypass(
              name,
              new Error().stack,
              windowId,
            );
            return Reflect.apply(fnTarget, thisArg, args);
          },
        });
      }
      return value;
    },
  };
  return new Proxy(rawPage, handler) as Page;
}
