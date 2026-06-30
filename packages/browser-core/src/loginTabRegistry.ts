// packages/browser-core/src/loginTabRegistry.ts
import type { LoginTabRecord, LoginFlowConfig, LoginState } from './types';

const QR_PADDING = 40;

const LOGIN_TAB_MARK_KEY = '__login_tab_mark__';

export class LoginTabRegistry {
  /** 内存注册表：key = `${windowId}:${flowId}` */
  tabs = new Map<string, LoginTabRecord>();

  /** 注册登录标签页到内存注册表 */
  register(windowId: string, platform: string, flowId: string, record: LoginTabRecord): void {
    const key = `${windowId}:${platform}:${flowId}`;
    this.tabs.set(key, record);
  }

  /** 从内存注册表移除并清除 localStorage 标记。跨域跳转的标签页会被关闭。 */
  async unregister(windowId: string, platform: string, flowId: string): Promise<void> {
    const key = `${windowId}:${platform}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) {
      this.tabs.delete(key);

      // 清除 localStorage 标记（在当前域名下操作）
      try {
        await record.page.evaluate(({ markKey }: { markKey: string }) => {
          localStorage.removeItem(markKey);
        }, { markKey: LOGIN_TAB_MARK_KEY }).catch(() => {});
      } catch { /* 页面可能已关闭 */ }

      // C2: 跨域跳转检测 — 如果页面 URL 已离开登录域名，关闭标签页防止成为孤儿
      try {
        if (record.page.isClosed()) return;
        const currentUrl = record.page.url();

        // 从 loginUrl 提取域名
        let loginDomain = '';
        try {
          loginDomain = new URL(record.loginUrl).hostname;
        } catch { /* loginUrl 无效则跳过关闭 */ }
        if (!loginDomain || currentUrl === 'about:blank') return;

        // 提取当前 URL 域名并精确比较（处理子域名情况）
        let currentHostname = '';
        try {
          currentHostname = new URL(currentUrl).hostname;
        } catch { /* URL 无效则跳过关闭 */ }
        if (!currentHostname) return;

        const isSameDomain = currentHostname === loginDomain
          || currentHostname.endsWith('.' + loginDomain);
        if (!isSameDomain) {
          await record.page.close();
          console.info(`[LoginTabRegistry] unregister: closed cross-domain tab (loginUrl domain=${loginDomain}, currentHostname=${currentHostname})`);
        }
      } catch { /* 页面操作失败，忽略 */ }
    }
  }

  /**
   * 查找登录标签页：先查内存，miss 则枚举所有页面扫描 localStorage 标记。
   * 同时清理同域名的孤儿标签页（openLoginTab 失败后遗留的未标记页面）。
   * @param browser - patchright Browser 实例（any 类型避免依赖 patchright）
   * @param domain - loginFlow 配置中的 domain 字段，用于 URL 筛选
   */
  async find(windowId: string, platform: string, flowId: string, browser: any, domain: string): Promise<LoginTabRecord | null> {
    const key = `${windowId}:${platform}:${flowId}`;

    // 1. 查内存
    const cached = this.tabs.get(key);
    if (cached) {
      try {
        if (!cached.page.isClosed()) {
          // domain 校验：防止跨平台 key 冲突后的残留串号
          if (cached.domain === domain) return cached;
          console.warn(`[LoginTabRegistry] find: memory hit domain mismatch (record.domain=${cached.domain}, expected=${domain}), clearing stale entry`);
        }
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
          if (markData && markData.platform === platform && markData.flowId === flowId) {
            const record: LoginTabRecord = {
              page,
              targetId: markData.targetId || '',
              domain,
              flowId,
              platform,
              openedAt: markData.openedAt || Date.now(),
              userId: markData.userId || 0,
              loginUrl: markData.loginUrl || '',
            };
           this.tabs.set(key, record);
           return record;
         }
         // 同域名但 platform/flowId 不匹配 → 跳过（可能是其他平台登录 tab 或主监控页）
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

    // 0. 如配置了激活选择器，先检查 QR 是否已可见，不可见才点击激活
    if (config.qrActivationSelector) {
      try {
        // 先检查 QR 是否已经可见（避免对切换按钮多次点击导致 QR 消失）
        let qrAlreadyVisible = false;
        for (const sel of selectors) {
          try {
            const el = await page.$(sel);
            if (el && await el.isVisible().catch(() => false)) {
              qrAlreadyVisible = true;
              break;
            }
          } catch { continue; }
        }

        if (!qrAlreadyVisible) {
          const activator = await page.$(config.qrActivationSelector);
          if (activator) {
            const box = await activator.boundingBox();
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            } else {
              await activator.click();
            }
            await page.waitForTimeout(2000);
            for (const sel of selectors) {
              try { await page.waitForSelector(sel, { timeout: 3000, state: 'visible' }); break; } catch { continue; }
            }
            console.info(`[LoginTabRegistry] captureQR: activated QR via "${config.qrActivationSelector}"`);
          }
        } else {
          console.info('[LoginTabRegistry] captureQR: QR already visible, skipping activation click');
        }
      } catch (err: any) {
        console.warn(`[LoginTabRegistry] captureQR: activation selector "${config.qrActivationSelector}" failed: ${err.message}`);
      }
    }

    // 收集所有 frame（主页面 + 子 iframe），视频号 QR 在 login-for-iframe 内
    const frames: any[] = [page, ...page.frames().filter((f: any) => f !== page.mainFrame())];

    // 0.5 QR 码过期检测：如果存在过期遮罩，先点击刷新按钮
    try {
      const timeoutOverlay = await page.$('.qrcode-status-timeout, [class*="qrcode-status-timeout"]');
      if (timeoutOverlay) {
        // 优先用配置的 qrRefreshSelector，回退到通用 .qrcode-refresh
        const refreshSel = config.qrRefreshSelector
          ? `${config.qrRefreshSelector}, .qrcode-refresh, [class*="qrcode-refresh"]`
          : '.qrcode-refresh, [class*="qrcode-refresh"]';
        const refreshBtn = await page.$(refreshSel);
        if (refreshBtn) {
          await refreshBtn.click();
          await page.waitForTimeout(3000);
          try { await page.waitForSelector('.qrcode-status-timeout', { state: 'hidden', timeout: 5000 }); } catch { /* 可能已消失 */ }
          console.info('[LoginTabRegistry] captureQR: QR expired, clicked refresh');
        }
      }
    } catch { /* 过期检测失败不阻塞主流程 */ }

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
  async openLoginTab(windowId: string, platform: string, userId: number, flowId: string, browser: any, config: LoginFlowConfig): Promise<LoginTabRecord | null> {
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
      const markData = JSON.stringify({ flowId, platform, userId, openedAt: Date.now(), loginUrl: config.loginUrl });
      await page.evaluate(({ data, markKey }: { data: string; markKey: string }) => {
        localStorage.setItem(markKey, data);
      }, { data: markData, markKey: LOGIN_TAB_MARK_KEY });
      const targetId = (page as any)._targetId || 'unknown';
      const record: LoginTabRecord = {
        page, targetId, domain: config.domain, flowId, platform,
        openedAt: Date.now(), userId,
        loginUrl: config.loginUrl,
      };
      this.register(windowId, platform, flowId, record);
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
  async closeLoginTab(windowId: string, platform: string, flowId: string): Promise<void> {
    const key = `${windowId}:${platform}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) { try { await record.page.close(); } catch { /* 已关闭 */ } }
    await this.unregister(windowId, platform, flowId);
    this.tabs.delete(key);
  }
}
