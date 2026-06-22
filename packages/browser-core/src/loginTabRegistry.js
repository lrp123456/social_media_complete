"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginTabRegistry = void 0;
const QR_PADDING = 40;
const LOGIN_TAB_MARK_KEY = '__login_tab_mark__';
class LoginTabRegistry {
    /** 内存注册表：key = `${windowId}:${flowId}` */
    tabs = new Map();
    /** 注册登录标签页到内存注册表 */
    register(windowId, flowId, record) {
        const key = `${windowId}:${flowId}`;
        this.tabs.set(key, record);
    }
    /** 从内存注册表移除并清除 localStorage 标记 */
    async unregister(windowId, flowId) {
        const key = `${windowId}:${flowId}`;
        const record = this.tabs.get(key);
        if (record) {
            // Delete from memory first (synchronous) so callers without await still work
            this.tabs.delete(key);
            // Fire-and-forget localStorage cleanup
            try {
                await record.page.evaluate((markKey) => {
                    localStorage.removeItem(markKey);
                }, LOGIN_TAB_MARK_KEY).catch(() => { });
            }
            catch { /* 页面可能已关闭 */ }
        }
    }
    /**
     * 查找登录标签页：先查内存，miss 则枚举所有页面扫描 localStorage 标记。
     * @param browser - patchright Browser 实例（any 类型避免依赖 patchright）
     * @param domain - loginFlow 配置中的 domain 字段，用于 URL 筛选
     */
    async find(windowId, flowId, browser, domain) {
        const key = `${windowId}:${flowId}`;
        // 1. 查内存
        const cached = this.tabs.get(key);
        if (cached) {
            try {
                if (!cached.page.isClosed())
                    return cached;
            }
            catch { /* page 引用过期 */ }
            this.tabs.delete(key);
        }
        // 2. 枚举所有页面，通过 localStorage 标记恢复
        try {
            const ctx = browser.contexts()[0];
            if (!ctx)
                return null;
            const pages = ctx.pages();
            for (const page of pages) {
                try {
                    const url = page.url();
                    if (!url.includes(domain))
                        continue;
                    const markData = await page.evaluate((markKey) => {
                        const raw = localStorage.getItem(markKey);
                        return raw ? JSON.parse(raw) : null;
                    }, LOGIN_TAB_MARK_KEY);
                    if (markData && markData.flowId === flowId) {
                        const record = {
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
                }
                catch {
                    continue;
                }
            }
        }
        catch { /* browser 不可用 */ }
        return null;
    }
    /** 在指定页面执行登录态检测 */
    async checkLoginState(page, config) {
        // 1. 优先检测未登录态
        for (const sel of (config.loggedOutIndicators || [])) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const isVisible = await el.isVisible().catch(() => false);
                    if (isVisible)
                        return 'logged_out';
                }
            }
            catch {
                continue;
            }
        }
        // 2. 检测已登录态
        for (const sel of (config.loggedInIndicators || [])) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const isVisible = await el.isVisible().catch(() => false);
                    if (isVisible)
                        return 'logged_in';
                }
            }
            catch {
                continue;
            }
        }
        // 3. 都没命中
        return 'unknown';
    }
    /** 截取 QR 码，带 padding 正方形裁剪，全页兜底 */
    async captureQR(page, config) {
        const selectors = config.qrSelectors || [];
        for (const sel of selectors) {
            try {
                const el = await page.waitForSelector(sel, { timeout: 8000, state: 'visible' });
                if (!el)
                    continue;
                await page.waitForTimeout(500);
                const box = await el.boundingBox();
                if (!box || box.width < 50 || box.height < 50)
                    continue;
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
                return await page.screenshot({ type: 'png', clip });
            }
            catch {
                continue;
            }
        }
        // 全页兜底
        try {
            return await page.screenshot({ type: 'png' });
        }
        catch {
            return null;
        }
    }
    /** 打开登录标签页并注册 */
    async openLoginTab(windowId, userId, flowId, browser, config) {
        try {
            const ctx = browser.contexts()[0];
            if (!ctx)
                return null;
            const page = await ctx.newPage();
            await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            const markData = JSON.stringify({ flowId, userId, openedAt: Date.now() });
            await page.evaluate((data, key) => {
                localStorage.setItem(key, data);
            }, markData, LOGIN_TAB_MARK_KEY);
            const targetId = page._targetId || 'unknown';
            const record = {
                page, targetId, domain: config.domain, flowId,
                openedAt: Date.now(), userId,
            };
            this.register(windowId, flowId, record);
            return record;
        }
        catch {
            return null;
        }
    }
    /** 关闭登录标签页：unregister + page.close() */
    async closeLoginTab(windowId, flowId) {
        const key = `${windowId}:${flowId}`;
        const record = this.tabs.get(key);
        if (record) {
            try {
                await record.page.close();
            }
            catch { /* 已关闭 */ }
        }
        await this.unregister(windowId, flowId);
        this.tabs.delete(key);
    }
}
exports.LoginTabRegistry = LoginTabRegistry;
//# sourceMappingURL=loginTabRegistry.js.map