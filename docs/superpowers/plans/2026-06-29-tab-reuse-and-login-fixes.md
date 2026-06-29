# 标签页复用与登录态泄漏修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复标签页不复用、快手二次刷新收到截图、未登录却爬到数据、特定视频评论无法爬取四个问题

**架构：** 涉及 6 个文件的定向修复，按依赖顺序分为 6 个任务。types.ts 是基础依赖需先改，其余文件可并行。

**技术栈：** TypeScript, patchright (Playwright fork), jest, pnpm monorepo

**规格文档：** `docs/superpowers/specs/2026-06-29-tab-reuse-and-login-fixes-design.md`

---

## 文件结构

| 文件 | 职责 | 修改项 |
|------|------|--------|
| `packages/browser-core/src/types.ts` | 类型定义 | D1: Platform 加 'pinterest'; C2: LoginTabRecord 加 loginUrl |
| `packages/browser-core/src/browserManager.ts` | 标签页管理 | C1: fallback 返回 undefined; C3: 排除 passport 域名; D2: pinterest URL 匹配 |
| `packages/browser-core/src/loginTabRegistry.ts` | 登录标签页注册表 | A2: captureQR 先检查 QR 可见; C2: unregister 跨域关闭 |
| `data/selectors.json` | 选择器配置 | A1: 快手 qrActivationSelector |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫 | B1/B2: checkLoginStatus 默认 false; E1: Simple Pre-check; E2: CDP 重试 |
| `apps/ts-api-gateway/src/platforms/pinterest.ts` | Pinterest 爬虫 | D3: platform 改为 'pinterest' |

---

## 任务 1：types.ts 类型扩展（D1 + C2 基础）

**文件：**
- 修改：`packages/browser-core/src/types.ts:1` — Platform 类型
- 修改：`packages/browser-core/src/types.ts:110-117` — LoginTabRecord 接口
- 测试：无（纯类型变更，编译时验证）

- [ ] **步骤 1：修改 Platform 类型**

在 `packages/browser-core/src/types.ts:1`，将：

```typescript
export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu';
```

改为：

```typescript
export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'pinterest';
```

- [ ] **步骤 2：给 LoginTabRecord 添加 loginUrl 字段**

在 `packages/browser-core/src/types.ts:110-117`，将：

```typescript
export interface LoginTabRecord {
  page: any; // Page (避免循环引用的 any 类型)
  targetId: string;
  domain: string;
  flowId: string;
  openedAt: number;
  userId: number;
}
```

改为：

```typescript
export interface LoginTabRecord {
  page: any; // Page (避免循环引用的 any 类型)
  targetId: string;
  domain: string;
  flowId: string;
  openedAt: number;
  userId: number;
  /** 登录页 URL（用于 unregister 时判定是否发生跨域跳转） */
  loginUrl: string;
}
```

- [ ] **步骤 3：编译验证**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/browser-core build`
预期：编译通过。如果有 `loginUrl` 缺失错误，是因为 `loginTabRegistry.ts` 中构造 `LoginTabRecord` 时还没传 `loginUrl`，这在任务 3 中修复。

- [ ] **步骤 4：Commit**

```bash
git add packages/browser-core/src/types.ts
git commit -m "fix(types): add 'pinterest' to Platform, add loginUrl to LoginTabRecord"
```

---

## 任务 2：browserManager.ts 标签页管理修复（C1 + C3 + D2）

**文件：**
- 修改：`packages/browser-core/src/browserManager.ts:525-543` — `findPlatformPage()`
- 测试：无（private 方法，通过编译和集成验证）

- [ ] **步骤 1：修改 findPlatformPage — 添加 pinterest 匹配 + 排除 passport 域名 + fallback 返回 undefined**

在 `packages/browser-core/src/browserManager.ts:525-543`，将整个 `findPlatformPage` 方法替换为：

```typescript
  private async findPlatformPage(pages: Page[], platform: Platform): Promise<Page | undefined> {
    const candidates = pages.filter(p => {
      const url = p.url();
      if (platform === 'kuaishou') return url.includes('kuaishou.com') || url.includes('cp.kuaishou.com');
      if (platform === 'xiaohongshu') return url.includes('xiaohongshu.com') || url.includes('creator.xiaohongshu.com');
      if (platform === 'tencent') return url.includes('channels.weixin.qq.com');
      if (platform === 'pinterest') return url.includes('pinterest.com');
      return url.includes('douyin.com') || url.includes('creator.douyin.com');
    });

    // 排除登录标签页（有 __login_tab_mark__ 标记的不作为工作标签页）
    // 同时排除仍在 passport 域名的标签页（登录跳转前的页面）
    for (const p of candidates) {
      try {
        const url = p.url();
        // C3: 跳过 passport 域名的页面（如 passport.kuaishou.com）
        if (url.includes('passport.')) continue;

        const isLoginTab = await p.evaluate(() =>
          !!localStorage.getItem('__login_tab_mark__')
        );
        if (!isLoginTab) return p;
      } catch { continue; }
    }

    // C1: 所有候选都是登录标签页时，返回 undefined（不返回 candidates[0]）
    // 让 connect() 走新建标签页分支
    return undefined;
  }
```

- [ ] **步骤 2：编译验证**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/browser-core build`
预期：编译通过。`connect()` 中 L288 `if (platformPage)` 对 `undefined` 的处理已正确（走 L391 新建分支）。

- [ ] **步骤 3：Commit**

```bash
git add packages/browser-core/src/browserManager.ts
git commit -m "fix(browserManager): findPlatformPage returns undefined for all-login-tabs, excludes passport domain, adds pinterest matching"
```

---

## 任务 3：loginTabRegistry.ts 修复（A2 + C2）

**文件：**
- 修改：`packages/browser-core/src/loginTabRegistry.ts:19-32` — `unregister()`
- 修改：`packages/browser-core/src/loginTabRegistry.ts:111-136` — `captureQR()`
- 修改：`packages/browser-core/src/loginTabRegistry.ts:195-228` — `openLoginTab()`
- 测试：`packages/browser-core/src/__tests__/loginTabRegistry.test.ts`

- [ ] **步骤 1：编写 unregister 跨域关闭的失败测试**

在 `packages/browser-core/src/__tests__/loginTabRegistry.test.ts` 末尾（L144 的 `});` 之前）添加：

```javascript
  it('should close page on unregister when URL crossed domains (kuaishou)', async () => {
    let closed = false;
    const page = mockPage('https://cp.kuaishou.com/article/comment', 'target-ks');
    page.close = () => { closed = true; return Promise.resolve(); };
    const record = {
      page,
      targetId: 'target-ks',
      domain: 'cp.kuaishou.com',
      flowId: 'creator',
      openedAt: Date.now(),
      userId: 11,
      loginUrl: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api',
    };
    registry.register('windowKS', 'creator', record);
    await registry.unregister('windowKS', 'creator');
    expect(closed).toBe(true);
    expect(registry.tabs.has('windowKS:creator')).toBe(false);
  });

  it('should NOT close page on unregister when URL is same domain (douyin)', async () => {
    let closed = false;
    const page = mockPage('https://creator.douyin.com/creator-micro/home', 'target-dy');
    page.close = () => { closed = true; return Promise.resolve(); };
    const record = {
      page,
      targetId: 'target-dy',
      domain: 'creator.douyin.com',
      flowId: 'creator',
      openedAt: Date.now(),
      userId: 7,
      loginUrl: 'https://creator.douyin.com/creator-micro/home',
    };
    registry.register('windowDY', 'creator', record);
    await registry.unregister('windowDY', 'creator');
    expect(closed).toBe(false);
    expect(registry.tabs.has('windowDY:creator')).toBe(false);
  });
```

同时，更新文件顶部 `mockPage` 函数（L9-25），添加 `loginUrl` 字段到已有测试中的 record 对象。已有测试中的 record 对象需要补加 `loginUrl` 字段以满足类型。在 `mockPage` 返回对象中不需要改，但在每个 `record` 字面量中需要加 `loginUrl`。

对于已有测试中的 3 个 record 对象（L36-43, L51-55, L62-72），添加 `loginUrl: 'https://www.xiaohongshu.com/explore'`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/browser-core test`
预期：新测试失败 — `unregister` 当前不关闭页面，`closed` 为 `false`，断言 `expect(closed).toBe(true)` 失败。

- [ ] **步骤 3：修改 unregister 实现跨域关闭**

在 `packages/browser-core/src/loginTabRegistry.ts:19-32`，将 `unregister` 方法替换为：

```typescript
  /** 从内存注册表移除并清除 localStorage 标记。跨域跳转的标签页会被关闭。 */
  async unregister(windowId: string, flowId: string): Promise<void> {
    const key = `${windowId}:${flowId}`;
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
        if (!record.page.isClosed()) {
          const currentUrl = record.page.url();
          // 从 loginUrl 提取域名
          let loginDomain = '';
          try {
            loginDomain = new URL(record.loginUrl).hostname;
          } catch { /* loginUrl 无效则跳过关闭 */ }

          if (loginDomain && !currentUrl.includes(loginDomain) && currentUrl !== 'about:blank') {
            await record.page.close();
            console.info(`[LoginTabRegistry] unregister: closed cross-domain tab (loginUrl domain=${loginDomain}, currentUrl=${currentUrl})`);
          }
        }
      } catch { /* 页面操作失败，忽略 */ }
    }
  }
```

- [ ] **步骤 4：修改 openLoginTab 存入 loginUrl**

在 `packages/browser-core/src/loginTabRegistry.ts:212-216`，将 record 构造改为：

```typescript
      const targetId = (page as any)._targetId || 'unknown';
      const record: LoginTabRecord = {
        page, targetId, domain: config.domain, flowId,
        openedAt: Date.now(), userId,
        loginUrl: config.loginUrl,
      };
```

- [ ] **步骤 5：修改 captureQR — qrActivationSelector 点击前先检查 QR 可见性**

在 `packages/browser-core/src/loginTabRegistry.ts:114-136`，将 `if (config.qrActivationSelector)` 块替换为：

```typescript
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
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/browser-core test`
预期：所有测试通过，包括新增的跨域关闭测试。

- [ ] **步骤 7：Commit**

```bash
git add packages/browser-core/src/loginTabRegistry.ts packages/browser-core/src/__tests__/loginTabRegistry.test.ts
git commit -m "fix(loginTabRegistry): unregister closes cross-domain tabs, captureQR checks QR visibility before clicking"
```

---

## 任务 4：selectors.json 快手 qrActivationSelector（A1）

**文件：**
- 修改：`data/selectors.json` — 快手 `loginFlows.creator` 段
- 测试：无（JSON 配置，通过启动加载验证）

- [ ] **步骤 1：添加 qrActivationSelector 到快手 loginFlows.creator**

在 `data/selectors.json` 中找到快手的 `loginFlows.creator` 配置（约 L4301 附近），当前内容为：

```json
    "creator": {
      "domain": "cp.kuaishou.com",
      "label": "创作者中心",
      "loginUrl": "https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api",
      "closeOnLoginSuccess": false,
      "loggedOutIndicators": [
        ".login-qrcode",
        ".qrcode-img",
        "[class*=\"login\"]"
      ],
      "loggedInIndicators": [
        ".el-menu",
        ".sidebar",
        "[class*=\"sidebar\"]",
        "[class*=\"menu\"]"
      ],
      "qrSelectors": [
        "img[alt=\"qrcode\"]",
        "img[src*=\"data:image/\"]",
        "canvas"
      ]
    }
```

在 `"qrSelectors"` 数组后添加 `"qrActivationSelector"` 字段：

```json
    "creator": {
      "domain": "cp.kuaishou.com",
      "label": "创作者中心",
      "loginUrl": "https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api",
      "closeOnLoginSuccess": false,
      "loggedOutIndicators": [
        ".login-qrcode",
        ".qrcode-img",
        "[class*=\"login\"]"
      ],
      "loggedInIndicators": [
        ".el-menu",
        ".sidebar",
        "[class*=\"sidebar\"]",
        "[class*=\"menu\"]"
      ],
      "qrSelectors": [
        "img[alt=\"qrcode\"]",
        "img[src*=\"data:image/\"]",
        "canvas"
      ],
      "qrActivationSelector": "div.platform-switch"
    }
```

- [ ] **步骤 2：验证 JSON 格式**

运行：`node -e "JSON.parse(require('fs').readFileSync('/home/lrp/social_media_complete/data/selectors.json','utf8')); console.log('JSON valid')"`
预期：输出 `JSON valid`

- [ ] **步骤 3：Commit**

```bash
git add data/selectors.json
git commit -m "fix(selectors): add qrActivationSelector for kuaishou creator login flow"
```

---

## 任务 5：kuaishouCrawler.ts 修复（B1 + B2 + E1 + E2）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:216,219` — `checkLoginStatus()` 默认返回值
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:2136-2294` — `findAndClickVideoInDrawer()` CDP 重试
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:3336-3375` — `processCommentsQueueSimple()` Pre-check
- 测试：无（浏览器交互代码，通过编译 + 日志验证）

- [ ] **步骤 1：修改 checkLoginStatus 默认返回值（B1 + B2）**

在 `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:185-221`，找到 `checkLoginStatus` 方法的末尾两处 `return true`：

L216 当前为：
```typescript
      return true;
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Login] Error checking login status');
      return true;
    }
```

改为：
```typescript
      return false;
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Login] Error checking login status');
      return false;
    }
```

注意：只改最后两处 `return true`（L216 和 L219），不要改 L213 的 `return true`（那是 sidebar 可见时确认已登录的返回）。

- [ ] **步骤 2：修改 findAndClickVideoInDrawer 添加 CDP 重试（E2）**

在 `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:2151-2194`，找到 `findAndClickVideoInDrawer` 中的 `for` 循环第一次 `evaluateOrSafe` 调用。

当前代码（L2154-2194）：
```typescript
      const matchResult = await this.evaluateOrSafe(
        page,
        (params: { createTimeNum: number; tolerance: number }) => {
          // ... DOM 扫描逻辑 ...
        },
        [{ createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE }],
        'drawer-video-timestamp-matching',
      );
```

替换为带重试的版本：

```typescript
      let matchResult;
      try {
        matchResult = await this.evaluateOrSafe(
          page,
          (params: { createTimeNum: number; tolerance: number }) => {
            const { createTimeNum: createTimeNum, tolerance } = params;
            const items = Array.from(document.querySelectorAll('.video-item'));
            let minTimestamp = Infinity;
            let maxTimestamp = -Infinity;
            let itemCount = 0;
            const candidates: Array<{ domTimestamp: number; title: string; dateText: string; fullText: string }> = [];

            for (const item of items) {
              const titleEl = item.querySelector('.video-info__content__title');
              const dateEl = item.querySelector('.video-info__content__date');
              const title = titleEl?.textContent?.trim() || '';
              const dateText = dateEl?.textContent?.trim() || '';
              const fullText = `${title} ${dateText}`;

              const dateMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
              if (!dateMatch) continue;
              const [, y, m, d, h, min, s] = dateMatch;
              const domTimestamp = Math.floor(new Date(`${y}-${m}-${d}T${h}:${min}:${s}+08:00`).getTime() / 1000);

              itemCount++;
              if (domTimestamp < minTimestamp) minTimestamp = domTimestamp;
              if (domTimestamp > maxTimestamp) maxTimestamp = domTimestamp;

              if (Math.abs(domTimestamp - createTimeNum) <= tolerance) {
                candidates.push({ domTimestamp, title: title.substring(0, 80), dateText, fullText });
              }
            }

            return {
              itemCount,
              minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : null,
              maxTimestamp: Number.isFinite(maxTimestamp) ? maxTimestamp : null,
              candidates,
            };
          },
          [{ createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE }],
          'drawer-video-timestamp-matching',
        );
      } catch (evalErr: any) {
        if (evalErr.message?.includes('Cannot find context')) {
          logger.warn({ awemeId, error: evalErr.message }, '[Drawer] CDP context lost, clearing isolated world cache and retrying');
          // E2: 清除隔离世界缓存，让 getIsolatedWorldId 重新创建
          HumanActions.isolatedWorldIds.delete(page);
          await HumanActions.wait(page, 2000, 3000);
          matchResult = await this.evaluateOrSafe(
            page,
            (params: { createTimeNum: number; tolerance: number }) => {
              const { createTimeNum: createTimeNum, tolerance } = params;
              const items = Array.from(document.querySelectorAll('.video-item'));
              let minTimestamp = Infinity;
              let maxTimestamp = -Infinity;
              let itemCount = 0;
              const candidates: Array<{ domTimestamp: number; title: string; dateText: string; fullText: string }> = [];

              for (const item of items) {
                const titleEl = item.querySelector('.video-info__content__title');
                const dateEl = item.querySelector('.video-info__content__date');
                const title = titleEl?.textContent?.trim() || '';
                const dateText = dateEl?.textContent?.trim() || '';
                const fullText = `${title} ${dateText}`;

                const dateMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
                if (!dateMatch) continue;
                const [, y, m, d, h, min, s] = dateMatch;
                const domTimestamp = Math.floor(new Date(`${y}-${m}-${d}T${h}:${min}:${s}+08:00`).getTime() / 1000);

                itemCount++;
                if (domTimestamp < minTimestamp) minTimestamp = domTimestamp;
                if (domTimestamp > maxTimestamp) maxTimestamp = domTimestamp;

                if (Math.abs(domTimestamp - createTimeNum) <= tolerance) {
                  candidates.push({ domTimestamp, title: title.substring(0, 80), dateText, fullText });
                }
              }

              return {
                itemCount,
                minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : null,
                maxTimestamp: Number.isFinite(maxTimestamp) ? maxTimestamp : null,
                candidates,
              };
            },
            [{ createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE }],
            'drawer-video-timestamp-matching-retry',
          );
        } else {
          throw evalErr;
        }
      }
```

- [ ] **步骤 3：修改 processCommentsQueueSimple 添加 Pre-check（E1）**

在 `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`，找到 `processCommentsQueueSimple` 方法中的清空拦截器位置（约 L3336-3339）。

当前代码：
```typescript
        // ── 清空拦截器中旧的评论响应 ──
        for (const p of ALL_KUAISHOU_COMMENT_PATTERNS) {
          this.interceptor.clear(p);
        }

        // ── 打开抽屉 ──
        const drawerOpened = await this.openSelectVideoDrawer(page);
```

替换为：

```typescript
        // ── Pre-check：检查 comment/home 是否已匹配目标视频（页面默认选中的视频可能就是目标）──
        let precheckMatched = false;
        let precheckCommentResp: any = null;

        const homeResp = this.interceptor.getResponses(COMMENT_HOME_PATTERN);
        if (homeResp.length > 0) {
          const latestHome = homeResp[homeResp.length - 1];
          const currentPhotoId = latestHome.body?.data?.photo?.photoId || '';
          if (currentPhotoId === item.awemeId) {
            logger.info({ awemeId: item.awemeId, currentPhotoId }, '[Simple] Pre-check: home API matches target video');
            const listResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
            if (listResp.length > 0) {
              precheckCommentResp = listResp[listResp.length - 1];
              precheckMatched = true;
              logger.info({ awemeId: item.awemeId }, '[Simple] Pre-check: commentList response found, skipping drawer');
            }
          } else {
            logger.info({ awemeId: item.awemeId, currentPhotoId }, '[Simple] Pre-check: current video is different, need drawer');
          }
        }

        let firstCommentResponse: any = null;

        if (precheckMatched) {
          // Pre-check 命中：直接使用已有响应，不清空、不开抽屉
          firstCommentResponse = precheckCommentResp;
        } else {
          // Pre-check 未命中：走原有抽屉流程

          // ── 清空拦截器中旧的评论响应 ──
          for (const p of ALL_KUAISHOU_COMMENT_PATTERNS) {
            this.interceptor.clear(p);
          }

          // ── 打开抽屉 ──
          const drawerOpened = await this.openSelectVideoDrawer(page);
          if (!drawerOpened) {
            logger.warn({ awemeId: item.awemeId }, '[Simple] Failed to open drawer, skipping');
            results.push({ awemeId: item.awemeId, success: false, error: 'Failed to open drawer' });
            continue;
          }
          logger.info({
            awemeId: item.awemeId,
            visible: true,
          }, '[Simple] Drawer opened');

          // ── 点击视频 ──
          const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description, item.createTime);
          if (!clicked) {
            logger.warn({ awemeId: item.awemeId }, '[Simple] Failed to click video, skipping');
            results.push({ awemeId: item.awemeId, success: false, error: 'Failed to click video' });
            continue;
          }
          logger.info({
            awemeId: item.awemeId,
            matched: true,
            matchType: 'exact',
          }, '[Simple] Video clicked');

          // ── 等待 API 响应 ──
          await HumanActions.wait(page, 3000, 5000);

          firstCommentResponse = await this.waitForCommentResponse(page, 8000);
          if (!firstCommentResponse) {
            logger.warn({ awemeId: item.awemeId }, '[Simple] No commentList after selecting video — skipping');
            results.push({ awemeId: item.awemeId, success: false, error: 'No commentList after selecting video' });
            continue;
          }
        }
```

然后，删除原来 L3366-3375 中重复的 `waitForCommentResponse` 调用（因为已在上面的 else 分支中处理）。原代码中从 `// ── 等待 API 响应 ──` 到 `continue;` 的整段需要删除，因为已被上面的 if/else 替代。

原代码中接下来是日志和 `collectAllCommentResponses`，保留这些：

```typescript
        {
          const bodyKeys = Object.keys(firstCommentResponse.body || {});
          // ... 原有的日志逻辑保持不变 ...
        }

        // 2. 获取已有的根评论 CID 集合
        const existingCids = await prisma.comment.findMany({
          // ... 原有逻辑不变 ...
```

- [ ] **步骤 4：编译验证**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/ts-api-gateway build`
预期：编译通过。如果报 `isolatedWorldIds` 是 private，需要确认 `HumanActions` 中 `isolatedWorldIds` 的可见性。如果是 `private static`，改为 `static`（包内可见）或在 `humanActions.ts` 中添加一个 `clearIsolatedWorldCache(page)` 公开方法。

- [ ] **步骤 5：处理 isolatedWorldIds 可见性问题（如需要）**

如果步骤 4 编译报 `isolatedWorldIds` 是 private 属性无法访问，在 `packages/browser-core/src/humanActions.ts:75` 将：

```typescript
  private static isolatedWorldIds = new WeakMap<Page, number>();
```

改为：

```typescript
  static isolatedWorldIds = new WeakMap<Page, number>();
```

- [ ] **步骤 6：运行已有测试确认无回归**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/ts-api-gateway test`
预期：所有已有测试通过。

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts packages/browser-core/src/humanActions.ts
git commit -m "fix(kuaishouCrawler): checkLoginStatus defaults to false, Simple mode pre-check skips drawer, CDP context retry with cache clear"
```

---

## 任务 6：pinterest.ts platform 参数修复（D3）

**文件：**
- 修改：`apps/ts-api-gateway/src/platforms/pinterest.ts:77`
- 测试：无（单行参数变更，通过编译验证）

- [ ] **步骤 1：修改 connect 调用的 platform 参数**

在 `apps/ts-api-gateway/src/platforms/pinterest.ts:77`，将：

```typescript
      const { browser, page } = await bm.connect(task.windowId, '', 'douyin');
```

改为：

```typescript
      const { browser, page } = await bm.connect(task.windowId, '', 'pinterest');
```

- [ ] **步骤 2：编译验证**

运行：`cd /home/lrp/social_media_complete && pnpm --filter @social-media/ts-api-gateway build`
预期：编译通过（`Platform` 类型已在任务 1 中添加 `'pinterest'`）。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/platforms/pinterest.ts
git commit -m "fix(pinterest): use correct platform param 'pinterest' instead of 'douyin'"
```

---

## 任务 7：全量编译和 lint 验证

**文件：** 无修改

- [ ] **步骤 1：全量编译**

运行：`cd /home/lrp/social_media_complete && pnpm build:ts`
预期：所有包编译通过。

- [ ] **步骤 2：全量测试**

运行：`cd /home/lrp/social_media_complete && pnpm -r test`
预期：所有测试通过。

- [ ] **步骤 3：全量 lint**

运行：`cd /home/lrp/social_media_complete && pnpm -r lint`
预期：无新增 lint 错误（已有错误可忽略）。

- [ ] **步骤 4：最终 Commit（如有 lint 修复）**

```bash
git add -A
git commit -m "chore: lint fixes after tab-reuse and login fixes"
```
