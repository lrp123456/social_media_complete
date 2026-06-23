// packages/browser-core/src/loginTabRegistry.ts
import type { LoginTabRecord, LoginFlowConfig, LoginState } from './types';

const QR_PADDING = 40;

const LOGIN_TAB_MARK_KEY = '__login_tab_mark__';

export class LoginTabRegistry {
  /** 内存注册表：key = `${windowId}:${flowId}` */
  tabs = new Map<string, LoginTabRecord>();

  /** 注册登录标签页到内存注册表 */
  register(windowId: string, flowId: string, record: LoginTabRecord): void {
    const key = `${windowId}:${flowId}`;
    this.tabs.set(key, record);
  }

  /** 从内存注册表移除并清除 localStorage 标记 */
  async unregister(windowId: string, flowId: string): Promise<void> {
    const key = `${windowId}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) {
      // Delete from memory first (synchronous) so callers without await still work
      this.tabs.delete(key);
      // Fire-and-forget localStorage cleanup
      try {
        await record.page.evaluate(({ markKey }: { markKey: string }) => {
          localStorage.removeItem(markKey);
        }, { markKey: LOGIN_TAB_MARK_KEY }).catch(() => {});
      } catch { /* 页面可能已关闭 */ }
    }
  }

  /**
   * 查找登录标签页：先查内存，miss 则枚举所有页面扫描 localStorage 标记。
   * 同时清理同域名的孤儿标签页（openLoginTab 失败后遗留的未标记页面）。
   * @param browser - patchright Browser 实例（any 类型避免依赖 patchright）
   * @param domain - loginFlow 配置中的 domain 字段，用于 URL 筛选
   */
  async find(windowId: string, flowId: string, browser: any, domain: string): Promise<LoginTabRecord | null> {
    const key = `${windowId}:${flowId}`;

    // 1. 查内存
    const cached = this.tabs.get(key);
    if (cached) {
      try {
        if (!cached.page.isClosed()) return cached;
      } catch { /* page 引用过期 */ }
      this.tabs.delete(key);
    }

   // 2. 枚举所有页面，通过 localStorage 标记恢复
   try {
     const ctx = browser.contexts()[0];
     if (!ctx) return null;
     const pages = ctx.pages();
     for (const page of pages) {
       try {
         const url = page.url();
         if (!url.includes(domain)) continue;
         const markData = await page.evaluate(({ markKey }: { markKey: string }) => {
           const raw = localStorage.getItem(markKey);
           return raw ? JSON.parse(raw) : null;
         }, { markKey: LOGIN_TAB_MARK_KEY });
         if (markData && markData.flowId === flowId) {
           const record: LoginTabRecord = {
             page,
             targetId: markData.targetId || '',
             domain,
             flowId,
             openedAt: markData.openedAt || Date.now(),
             userId: markData.userId || 0,
           };
           this.tabs.set(key, record);
           return record;
         }
         // 同域名但没有标记 → 跳过（可能是主监控页面，不能关闭）
       } catch { continue; }
     }
    } catch { /* browser 不可用 */ }
    return null;
  }

  /** 在指定页面执行登录态检测 */
  async checkLoginState(page: any, config: LoginFlowConfig): Promise<LoginState> {
    // 1. 优先检测未登录态
    for (const sel of (config.loggedOutIndicators || [])) {
      try {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) return 'logged_out';
        }
      } catch { continue; }
    }
    // 2. 检测已登录态
    for (const sel of (config.loggedInIndicators || [])) {
      try {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) return 'logged_in';
        }
      } catch { continue; }
    }
    // 3. 都没命中
    return 'unknown';
  }

  /** 截取 QR 码，带 padding 正方形裁剪，全页兜底。支持 iframe 内查找。 */
  async captureQR(page: any, config: LoginFlowConfig): Promise<Buffer | null> {
    const selectors = config.qrSelectors || [];

    // 收集所有 frame（主页面 + 子 iframe），视频号 QR 在 login-for-iframe 内
    const frames: any[] = [page, ...page.frames().filter((f: any) => f !== page.mainFrame())];

    for (const sel of selectors) {
      for (const frame of frames) {
        try {
          const el = await frame.waitForSelector(sel, { timeout: 8000, state: 'visible' });
          if (!el) continue;
          await page.waitForTimeout(500);
          const box = await el.boundingBox();
          if (!box || box.width < 50 || box.height < 50) {
            console.warn(`[LoginTabRegistry] captureQR: selector "${sel}" too small (${box?.width}x${box?.height}) in frame ${frame.url()?.substring(0, 60)}`);
            continue;
          }
          const maxDim = Math.max(box.width, box.height);
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const side = maxDim + QR_PADDING * 2;
          const clip = {
            x: Math.max(0, cx - side / 2),
            y: Math.max(0, cy - side / 2),
            width: side,
            height: side,
          };
          console.info(`[LoginTabRegistry] captureQR: captured via "${sel}" (${box.width}x${box.height}) in frame ${frame === page ? 'main' : 'iframe'}`);
          return await page.screenshot({ type: 'png', clip });
        } catch (err: any) {
          continue;
        }
      }
      console.warn(`[LoginTabRegistry] captureQR: selector "${sel}" not found in any frame`);
    }
    // 全页兜底
    try {
      console.info('[LoginTabRegistry] captureQR: falling back to full page screenshot');
      return await page.screenshot({ type: 'png' });
    } catch (err: any) {
      console.error(`[LoginTabRegistry] captureQR: full page fallback failed: ${err.message}`);
      return null;
    }
  }

  /** 打开登录标签页并注册 */
  async openLoginTab(windowId: string, userId: number, flowId: string, browser: any, config: LoginFlowConfig): Promise<LoginTabRecord | null> {
    let page: any = null;
    try {
      const contexts = browser.contexts();
      const ctx = contexts[0];
      if (!ctx) {
        console.warn('[LoginTabRegistry] openLoginTab: browser has no contexts');
        return null;
      }
      page = await ctx.newPage();
      console.info(`[LoginTabRegistry] openLoginTab: navigating to ${config.loginUrl}`);
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const markData = JSON.stringify({ flowId, userId, openedAt: Date.now() });
      await page.evaluate(({ data, markKey }: { data: string; markKey: string }) => {
        localStorage.setItem(markKey, data);
      }, { data: markData, markKey: LOGIN_TAB_MARK_KEY });
      const targetId = (page as any)._targetId || 'unknown';
      const record: LoginTabRecord = {
        page, targetId, domain: config.domain, flowId,
        openedAt: Date.now(), userId,
      };
      this.register(windowId, flowId, record);
      console.info(`[LoginTabRegistry] openLoginTab: success, tab registered (${windowId}:${flowId})`);
      return record;
    } catch (err: any) {
      // 失败时关闭已创建的页面，防止孤儿标签页堆积
      if (page) {
        try { await page.close(); console.info('[LoginTabRegistry] openLoginTab: closed orphan page after failure'); } catch { /* ignore */ }
      }
      console.error(`[LoginTabRegistry] openLoginTab failed: ${err.message}`);
      return null;
    }
  }

  /** 关闭登录标签页：unregister + page.close() */
  async closeLoginTab(windowId: string, flowId: string): Promise<void> {
    const key = `${windowId}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) { try { await record.page.close(); } catch { /* 已关闭 */ } }
    await this.unregister(windowId, flowId);
    this.tabs.delete(key);
  }
}
