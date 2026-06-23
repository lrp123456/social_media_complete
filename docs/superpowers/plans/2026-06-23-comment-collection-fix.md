# 评论采集修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复评论采集的 4 个问题：选择器 Docker volume 同步、commentCount 存储策略、XHS Phase 3 点击失败、腾讯根评论分页不完整

**架构：** Phase 1 从平台 API 存储真实 commentCount 到 Video 表；Phase 3 不再覆盖该值。选择器通过 Dockerfile 复制到非 volume 路径，启动时 deep-merge 到 runtime。XHS 点击增加 JS evaluate 降级和 URL 直接导航降级。腾讯滚动改用 shadow DOM 穿透的优先级容器检测。

**技术栈：** TypeScript, Prisma, Playwright, BullMQ, wujie Shadow DOM

**规格文档：** `docs/superpowers/specs/2026-06-23-comment-collection-fix-design.md`

---

### 任务 1：选择器自动同步 — Dockerfile + selectorStore.ts

**文件：**
- 修改：`apps/ts-api-gateway/Dockerfile:12` — 新增 COPY 指令
- 修改：`apps/ts-api-gateway/src/lib/selectorStore.ts:73-75` — 新增常量
- 修改：`apps/ts-api-gateway/src/lib/selectorStore.ts:300-383` — 修改 `loadFromDisk()`

- [ ] **步骤 1：Dockerfile 新增 bundled selectors 复制**

在 `apps/ts-api-gateway/Dockerfile` 第 12 行 `COPY apps/ts-api-gateway/ apps/ts-api-gateway/` 之后新增：

```dockerfile
COPY apps/ts-api-gateway/data/selectors.json /app/bundled-selectors.json
```

这确保打包的选择器文件不被 Docker volume 覆盖。

- [ ] **步骤 2：selectorStore.ts 新增常量**

在 `apps/ts-api-gateway/src/lib/selectorStore.ts` 第 75 行 (`const SCHEMA_FILE = ...`) 之后新增：

```typescript
const BUNDLED_SELECTOR_FILE = '/app/bundled-selectors.json';
```

- [ ] **步骤 3：实现 deep-merge 逻辑**

在 `selectorStore.ts` 的 `loadFromDisk()` 函数（第 300 行）开头，在读取 runtime 文件之前，新增 merge 逻辑：

```typescript
// === Bundled selectors deep-merge ===
// 在 runtime 文件读取之后、返回之前，执行 merge
```

在 `loadFromDisk()` 函数的 `return config;` 之前（约第 382 行），插入以下 merge 逻辑：

```typescript
  // --- Deep-merge bundled selectors into runtime config ---
  try {
    const bundledRaw = fs.readFileSync(BUNDLED_SELECTOR_FILE, 'utf-8');
    const bundledConfig: SelectorConfig = JSON.parse(bundledRaw);
    let addedCount = 0;
    let skippedCount = 0;

    for (const [platform, platformData] of Object.entries(bundledConfig)) {
      if (typeof platformData !== 'object' || platformData === null) continue;
      if (!(config as any)[platform]) (config as any)[platform] = {};

      for (const [category, categoryData] of Object.entries(platformData as Record<string, any>)) {
        if (typeof categoryData !== 'object' || categoryData === null) continue;
        if (!(config as any)[platform][category]) (config as any)[platform][category] = {};

        for (const [key, value] of Object.entries(categoryData)) {
          if ((config as any)[platform][category][key]) {
            skippedCount++;
          } else {
            (config as any)[platform][category][key] = value;
            addedCount++;
          }
        }
      }
    }

    if (addedCount > 0) {
      logger.info({ addedCount, skippedCount }, 'Selector sync: merged bundled selectors into runtime');
      // 保存合并结果到 runtime 文件
      try {
        fs.writeFileSync(SELECTOR_FILE, JSON.stringify(config, null, 2), 'utf-8');
      } catch (writeErr) {
        logger.warn({ error: writeErr }, 'Selector sync: failed to save merged config');
      }
    } else {
      logger.debug({ skippedCount }, 'Selector sync: no new selectors to add');
    }
  } catch (bundledErr) {
    // 非 Docker 环境或文件不存在，跳过 merge
    logger.debug({ error: (bundledErr as Error).message }, 'Selector sync: bundled file not found, skipping merge');
  }
```

- [ ] **步骤 4：验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/lib/selectorStore.ts
```

预期：无类型错误

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/Dockerfile apps/ts-api-gateway/src/lib/selectorStore.ts
git commit -m "feat: selector auto-sync — deep-merge bundled selectors.json into runtime volume"
```

---

### 任务 2：commentCount Phase 1 存储 — monitorDatabaseService.ts

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts:246-251` — `reconcileVideosForUser` 的 create/update 块

- [ ] **步骤 1：修改 create 块存储 API commentCount**

在 `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` 第 251 行，将：

```typescript
commentCount: 0,
```

改为：

```typescript
commentCount: v.comment_count ?? 0,
```

- [ ] **步骤 2：修改 update 块存储 API commentCount**

在同函数的 update 块（第 242-244 行附近），当前是：

```typescript
update: {
  description: v.description,
  metrics: JSON.stringify(v.metrics || {}),
},
```

改为：

```typescript
update: {
  description: v.description,
  metrics: JSON.stringify(v.metrics || {}),
  commentCount: v.comment_count ?? undefined,
},
```

当 `v.comment_count` 为 `undefined` 时 Prisma 跳过该字段不更新。

- [ ] **步骤 3：验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/services/monitorDatabaseService.ts
```

预期：无类型错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat: store API commentCount in Phase 1 via reconcileVideosForUser"
```

---

### 任务 3：移除 XHS/腾讯 Phase 3 的 commentCount 覆盖

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:1152` — 移除 `updateVideoCommentCount` 调用
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:1475` — 移除 `updateVideoCommentCount` 调用

- [ ] **步骤 1：移除 XHS 的 commentCount 覆盖**

在 `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` 第 1152 行，删除或注释掉：

```typescript
await db.updateVideoCommentCount(userId, exportId, comments.length);
```

替换为注释说明：

```typescript
// commentCount 已在 Phase 1 由 reconcileVideosForUser 存储 API 真实值，此处不再覆盖
```

- [ ] **步骤 2：移除腾讯的 commentCount 覆盖**

在 `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` 第 1475 行，删除或注释掉：

```typescript
await db.updateVideoCommentCount(userId, exportId, dbCommentsArray.length);
```

替换为注释说明：

```typescript
// commentCount 已在 Phase 1 由 reconcileVideosForUser 存储 API 真实值，此处不再覆盖
```

- [ ] **步骤 3：验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
```

预期：无类型错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "fix: remove Phase 3 commentCount override in XHS and tencent crawlers"
```

---

### 任务 4：XHS clickThumbnailAndWaitNewTab 修复

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:764-796` — 重写 `clickThumbnailAndWaitNewTab` 方法

- [ ] **步骤 1：重写 clickThumbnailAndWaitNewTab 方法**

将第 764-796 行的整个方法替换为：

```typescript
async clickThumbnailAndWaitNewTab(page: Page, noteId: string, timeout = 15000): Promise<Page | null> {
    logger.info({ noteId }, '[XHS-Phase3] Clicking thumbnail to open note detail');

    try {
      // 1. 获取选择器
      const cardDef = getSelector('region.note-card-by-id', XHS_PLATFORM);
      const coverDef = getSelector('region.note-card-cover', XHS_PLATFORM);

      let cardSelector = cardDef.css?.replace('{noteId}', noteId);
      let coverSelector = coverDef.css;

      // 2. 选择器降级：如果 getSelector 返回空，使用硬编码
      if (!cardSelector) {
        cardSelector = `.note-card[data-impression*="${noteId}"]`;
        logger.warn({ noteId, cardSelector }, '[XHS-Phase3] Using hardcoded card selector fallback');
      }
      if (!coverSelector) {
        coverSelector = '.note-card__cover .note-card__media';
        logger.warn({ noteId, coverSelector }, '[XHS-Phase3] Using hardcoded cover selector fallback');
      }

      logger.info({ noteId, cardSelector, coverSelector }, '[XHS-Phase3] Resolved selectors');

      // 3. 等待卡片元素（CSS 选择器）
      let card: ElementHandle | null = null;
      try {
        card = await page.waitForSelector(cardSelector, { timeout: 10000 });
      } catch {
        // CSS 选择器失败，降级为 JS evaluate（不受 HTML 转义影响）
        logger.warn({ noteId, cardSelector }, '[XHS-Phase3] CSS selector failed, trying JS evaluate');
        const handle = await page.evaluateHandle((nid: string) => {
          const cards = document.querySelectorAll('.note-card');
          for (const c of Array.from(cards)) {
            const imp = c.getAttribute('data-impression') || '';
            if (imp.includes(nid)) return c;
          }
          return null;
        }, noteId);
        const element = handle.asElement();
        if (element) {
          card = element as unknown as ElementHandle;
          logger.info({ noteId }, '[XHS-Phase3] Card found via JS evaluate');
        }
      }

      if (!card) {
        logger.error({ noteId }, '[XHS-Phase3] Card element not found by any method');
        return null;
      }

      // 4. 查找 cover 元素
      let clickEl: ElementHandle = card;
      if (coverSelector) {
        const cover = await card.$(coverSelector);
        if (cover) clickEl = cover;
      }

      // 5. 顺序式：先注册 waitForEvent，再点击
      let newPage: Page | null = null;
      try {
        const pagePromise = page.context().waitForEvent('page', { timeout });
        await clickEl.click();
        newPage = await pagePromise;
        await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await HumanActions.wait(newPage, 2000, 4000);
        logger.info({ noteId, url: newPage.url() }, '[XHS-Phase3] New tab opened via click');
        return newPage;
      } catch {
        // 点击未打开新标签页，降级为 URL 直接导航
        logger.warn({ noteId }, '[XHS-Phase3] Click did not open new tab, falling back to direct URL navigation');
        try {
          newPage = await page.context().newPage();
          await newPage.goto(`https://www.xiaohongshu.com/explore/${noteId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await HumanActions.wait(newPage, 2000, 4000);
          logger.info({ noteId, url: newPage.url() }, '[XHS-Phase3] New tab opened via URL fallback');
          return newPage;
        } catch (navErr: any) {
          logger.error({ noteId, error: navErr.message }, '[XHS-Phase3] URL fallback also failed');
          return null;
        }
      }
    } catch (err: any) {
      logger.warn({ noteId, error: err.message }, '[XHS-Phase3] Failed to open note detail page');
      return null;
    }
  }
```

- [ ] **步骤 2：验证类型**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
```

预期：无类型错误。如有 `ElementHandle` 类型问题，需从 playwright 导入。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "fix: XHS clickThumbnailAndWaitNewTab — selector fallback + JS evaluate + URL navigation"
```

---

### 任务 5：腾讯 scrollShadowContainer 优先级修复

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:1588-1635` — `scrollShadowContainer` 方法
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:1299,1323,1332` — `collectVideoComments` 中的调用
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:1721,1723,1725` — `scrollCommentArea` 中的调用
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:2426` — `scrollRootCommentIntoView` 中的调用
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:2449,2459` — `expandSubRepliesForReply` 中的调用

- [ ] **步骤 1：修改 scrollShadowContainer 支持 null containerSelector**

在 `scrollShadowContainer` 方法（第 1588 行）内部，在获取 `containerSelector` 的 rect 之前，新增优先级检测逻辑。找到方法中获取 rect 的 `page.evaluate` 调用（约第 1595 行），在其前面插入：

```typescript
    // 如果传入的 containerSelector 是 '.feed-comment__wrp'，按优先级检测更合适的容器
    // 腾讯页面使用 wujie shadow DOM，必须用 page.evaluate 穿透
    const SCROLL_PRIORITY = [
      '.scroll-list__wrp .scroll-list',
      '.scroll-list__wrp',
      containerSelector,
    ];
    containerSelector = await page.evaluate((selectors: string[]) => {
      const wujieApps = document.querySelectorAll('wujie-app');
      for (const sel of selectors) {
        for (const app of Array.from(wujieApps)) {
          const sr = (app as HTMLElement).shadowRoot;
          if (sr?.querySelector(sel)) return sel;
        }
        if (document.querySelector(sel)) return sel;
      }
      return selectors[selectors.length - 1];
    }, SCROLL_PRIORITY);
```

注意：`containerSelector` 参数需要从 `const` 改为 `let`（如果当前是 const 的话）。

- [ ] **步骤 2：验证所有调用点无需修改**

由于 `scrollShadowContainer` 内部自动检测优先级容器，所有传入 `'.feed-comment__wrp'` 的调用点无需修改。验证以下 9 个调用点仍然正常工作：
- 行 1299, 1323, 1332（collectVideoComments）
- 行 1721, 1723, 1725（scrollCommentArea）
- 行 2426（scrollRootCommentIntoView）
- 行 2449, 2459（expandSubRepliesForReply）

- [ ] **步骤 3：修复 dataExhausted 竞态**

在 `collectVideoComments` 方法中，找到 `dataExhausted` 退出逻辑（约第 1282-1292 行）。当前逻辑：

```typescript
if (dataExhausted && currentRootCount > 0) {
  break;
}
```

改为：仅在当前迭代未收到新 API 响应时才退出：

```typescript
// 仅当本次迭代没有新响应且数据已耗尽时才退出
const hasNewResponsesInThisIteration = /* 需要根据实际代码判断 */;
if (dataExhausted && currentRootCount > 0 && !hasNewResponsesInThisIteration) {
  logger.info({ exportId, rootCount: currentRootCount }, '[Phase3:Collect] All root comments loaded (downContinueFlag=0, no new responses)');
  break;
}
```

具体实现需要跟踪 `responses.length` 在迭代前后的变化。

- [ ] **步骤 4：添加诊断日志**

在滚动循环中每次滚动后添加日志：

```typescript
logger.info({ 
  exportId, 
  scrollTarget: containerSelector,
  downContinueFlag: extracted?.downContinueFlag,
  rootCount: currentRootCount,
  scrollAttempts 
}, '[Phase3:Collect] Scroll iteration');
```

- [ ] **步骤 5：验证类型**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
```

预期：无类型错误

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "fix: tencent scrollShadowContainer priority detection via shadow DOM + dataExhausted race fix"
```

---

### 任务 6：Docker 构建验证

**前置依赖：** 任务 1-5 全部完成

- [ ] **步骤 1：Docker 构建**

```bash
cd /home/lrp/social_media_complete && docker compose up -d --build --force-recreate
```

- [ ] **步骤 2：检查选择器同步日志**

```bash
docker logs ts-api-gateway 2>&1 | grep "Selector sync"
```

预期：`Selector sync: added N new selectors`（N > 0 表示首次同步成功）

- [ ] **步骤 3：验证 XHS 选择器存在**

```bash
curl -s http://localhost:3000/api/v1/config-automation/selectors?platform=xiaohongshu | grep -o '"region_note_card_by_id"'
```

预期：输出 `"region_note_card_by_id"`

- [ ] **步骤 4：运行监控任务验证 XHS 和腾讯评论采集**

通过前端或 API 触发一次监控任务，检查日志：
- XHS：`[XHS-Phase3] New tab opened` 或 `[XHS-Phase3] New tab opened via URL fallback`
- 腾讯：`rootCount: 24`（而非 10）

- [ ] **步骤 5：验证 DB commentCount**

```bash
docker exec postgres psql -U postgres -d social_media -c "SELECT platform, id, \"commentCount\" FROM \"Video\" WHERE \"commentCount\" > 0 ORDER BY \"commentCount\" DESC LIMIT 20;"
```

预期：所有平台视频的 commentCount 均为 API 真实值（非 0，非采集数）
