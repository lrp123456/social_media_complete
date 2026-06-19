# 窗口实例化 Crawler + 应用层隔离 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 4 个 Crawler 从模块级单例改为按窗口实例化，彻底隔离 interceptor/listener/page 状态，解决评论树跨窗口串扰 bug

**架构：** 在 monitorService.ts 中新增 crawlerCache Map 和 getCrawler 工厂函数，所有 66 个调用点改为通过工厂获取实例；将动态属性声明为正式 private 字段

**技术栈：** TypeScript, Prisma, Playwright CDP

**设计文档：** `docs/superpowers/specs/2026-06-19-window-crawler-isolation-design.md`

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|---------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 监控调度服务 | 修改：单例→工厂函数，66 个调用点替换 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音爬虫 | 修改：动态属性声明为 private |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫 | 修改：动态属性声明为 private，checkForUpdates 增加 windowId |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 小红书爬虫 | 修改：动态属性声明为 private |

---

## 任务 1：声明正式 private 字段（3 个 Crawler）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:142-146`
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:144-148`
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:59-61`

- [ ] **步骤 1：抖音 — 声明 awemeIdToPlayCount 为 private 字段**

在 `douyinCrawler.ts` L146（`private page?: Page;` 之后），新增：

```typescript
  private awemeIdToPlayCount: Map<string, number> = new Map();
```

- [ ] **步骤 2：抖音 — 替换所有 (this as any)._awemeIdToPlayCount 引用**

在 `douyinCrawler.ts` 中：

L404，将：
```typescript
    (this as any)._awemeIdToPlayCount = awemeIdToPlayCount;
```
改为：
```typescript
    this.awemeIdToPlayCount = awemeIdToPlayCount;
```

L1237，将：
```typescript
    const awemeIdToPlayCount = (this as any)._awemeIdToPlayCount || new Map<string, number>();
```
改为：
```typescript
    const awemeIdToPlayCount = this.awemeIdToPlayCount;
```

- [ ] **步骤 3：快手 — 声明 awemeIdToPhotoStatus 为 private 字段**

在 `kuaishouCrawler.ts` L148（`private page?: Page;` 之后），新增：

```typescript
  private awemeIdToPhotoStatus: Map<string, number> = new Map();
```

- [ ] **步骤 4：快手 — 替换所有 (this as any)._awemeIdToPhotoStatus 引用**

在 `kuaishouCrawler.ts` 中：

L649，将：
```typescript
    (this as any)._awemeIdToPhotoStatus = awemeIdToPhotoStatus;
```
改为：
```typescript
    this.awemeIdToPhotoStatus = awemeIdToPhotoStatus;
```

L1258，将：
```typescript
    const awemeIdToPhotoStatus = (this as any)._awemeIdToPhotoStatus || new Map<string, number>();
```
改为：
```typescript
    const awemeIdToPhotoStatus = this.awemeIdToPhotoStatus;
```

- [ ] **步骤 5：小红书 — 声明 commentInterceptor 和 commentListenerId 为 private 字段**

在 `xiaohongshuCrawler.ts` L61（`private currentMenuSection` 之后），新增：

```typescript
  private commentInterceptor: RequestInterceptor | null = null;
  private commentListenerId: string | null = null;
```

- [ ] **步骤 6：小红书 — 替换所有 (this as any)._commentInterceptor 和 _commentListenerId 引用**

在 `xiaohongshuCrawler.ts` 中，将所有 `(this as any)._commentInterceptor` 替换为 `this.commentInterceptor`，将所有 `(this as any)._commentListenerId` 替换为 `this.commentListenerId`。涉及行：L817, L818, L824, L915, L1053, L1054, L1058, L1059。

L1058-1059 中的 `= undefined` 改为 `= null`。

- [ ] **步骤 7：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep -E "douyinCrawler|kuaishouCrawler|xiaohongshuCrawler" | grep -v "pre-existing\|NodeListOf\|withCDPContext\|innerText\|click.*Element" | head -10`
预期：无新增错误

- [ ] **步骤 8：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "refactor: declare dynamic properties as formal private fields"
```

---

## 任务 2：快手 checkForUpdates 签名统一

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1199-1203`
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:874`

- [ ] **步骤 1：修改 checkForUpdates 签名**

在 `kuaishouCrawler.ts` L1199-1203，将：
```typescript
  async checkForUpdates(
    page: Page,
    userId: number,
    source: KuaishouQuerySource
  ): Promise<KuaishouCheckResult> {
```
改为：
```typescript
  async checkForUpdates(
    page: Page,
    userId: number,
    windowId: string,
    source: KuaishouQuerySource
  ): Promise<KuaishouCheckResult> {
```

- [ ] **步骤 2：修改 monitorService.ts 中的调用点**

在 `monitorService.ts` L874，将：
```typescript
  const phase1Result = await kuaishouCrawler.checkForUpdates(page, task.userId, source);
```
改为：
```typescript
  const phase1Result = await getKuaishouCrawler(task.windowId).checkForUpdates(page, task.userId, task.windowId, source);
```

注意：此步骤同时完成了调用点的工厂函数替换。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor(kuaishou): unify checkForUpdates signature with windowId param"
```

---

## 任务 3：monitorService.ts — 替换单例为工厂函数

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:605-608`（单例声明）
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（66 个调用点）

- [ ] **步骤 1：替换单例声明为工厂函数和缓存**

在 `monitorService.ts` L605-608，将：
```typescript
const douyinCrawler = new DouyinCrawler(MAX_MONITOR_VIDEOS);
const kuaishouCrawler = new KuaishouCrawler(MAX_MONITOR_VIDEOS);
const xiaohongshuCrawler = new XiaohongshuCrawler(MAX_MONITOR_VIDEOS);
const tencentCrawler = new TencentCrawler(MAX_MONITOR_VIDEOS);
```
替换为：
```typescript
// Crawler 按窗口实例化，避免 interceptor/listener 跨窗口串扰
const crawlerCache = {
  douyin: new Map<string, DouyinCrawler>(),
  kuaishou: new Map<string, KuaishouCrawler>(),
  xiaohongshu: new Map<string, XiaohongshuCrawler>(),
  tencent: new Map<string, TencentCrawler>(),
};

function getDouyinCrawler(windowId: string): DouyinCrawler {
  if (!crawlerCache.douyin.has(windowId)) {
    crawlerCache.douyin.set(windowId, new DouyinCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.douyin.get(windowId)!;
}

function getKuaishouCrawler(windowId: string): KuaishouCrawler {
  if (!crawlerCache.kuaishou.has(windowId)) {
    crawlerCache.kuaishou.set(windowId, new KuaishouCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.kuaishou.get(windowId)!;
}

function getXiaohongshuCrawler(windowId: string): XiaohongshuCrawler {
  if (!crawlerCache.xiaohongshu.has(windowId)) {
    crawlerCache.xiaohongshu.set(windowId, new XiaohongshuCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.xiaohongshu.get(windowId)!;
}

function getTencentCrawler(windowId: string): TencentCrawler {
  if (!crawlerCache.tencent.has(windowId)) {
    crawlerCache.tencent.set(windowId, new TencentCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.tencent.get(windowId)!;
}

function releaseCrawler(platform: string, windowId: string): void {
  const cache = crawlerCache[platform as keyof typeof crawlerCache];
  if (!cache) return;
  const crawler = cache.get(windowId);
  if (!crawler) return;
  try { (crawler as any).unregisterListener?.(); } catch {}
  try { (crawler as any).unregisterCommentListener?.(); } catch {}
  // 清理小红书的独立评论拦截器
  try {
    if ((crawler as any).commentInterceptor) {
      (crawler as any).commentInterceptor.unregisterAll?.();
      (crawler as any).commentInterceptor = null;
    }
    if ((crawler as any).commentListenerId) {
      (crawler as any).commentListenerId = null;
    }
  } catch {}
  cache.delete(windowId);
}
```

- [ ] **步骤 2：替换 runDouyinCheck 中的所有调用点**

在 `monitorService.ts` 的 `runDouyinCheck` 函数中（约 L655-830），将所有 `douyinCrawler.xxx` 替换为 `getDouyinCrawler(task.windowId).xxx`。

具体替换列表：
- L690: `douyinCrawler.executeExitStrategy` → `getDouyinCrawler(task.windowId).executeExitStrategy`
- L717: `douyinCrawler.registerListener` → `getDouyinCrawler(task.windowId).registerListener`
- L721: `douyinCrawler.navigateToCreatorHome` → `getDouyinCrawler(task.windowId).navigateToCreatorHome`
- L727: `douyinCrawler.checkForUpdates` → `getDouyinCrawler(task.windowId).checkForUpdates`
- L729: `douyinCrawler.unregisterListener` → `getDouyinCrawler(task.windowId).unregisterListener`
- L745: `douyinCrawler.executeExitStrategy` → `getDouyinCrawler(task.windowId).executeExitStrategy`
- L754: `douyinCrawler.executeExitStrategy` → `getDouyinCrawler(task.windowId).executeExitStrategy`
- L778: `douyinCrawler.registerCommentListener` → `getDouyinCrawler(task.windowId).registerCommentListener`
- L779: `douyinCrawler.navigateToCommentManage` → `getDouyinCrawler(task.windowId).navigateToCommentManage`
- L782: `douyinCrawler.executeExitStrategy` → `getDouyinCrawler(task.windowId).executeExitStrategy`
- L789: `douyinCrawler.processCommentsQueue` → `getDouyinCrawler(task.windowId).processCommentsQueue`
- L798: `douyinCrawler.unregisterCommentListener` → `getDouyinCrawler(task.windowId).unregisterCommentListener`
- L824: `douyinCrawler.executeExitStrategy` → `getDouyinCrawler(task.windowId).executeExitStrategy`
- L825: `douyinCrawler.unregisterCommentListener` → `getDouyinCrawler(task.windowId).unregisterCommentListener`

优化技巧：可以在函数开头添加 `const dy = getDouyinCrawler(task.windowId);`，然后用 `dy.xxx` 替代所有调用，减少重复。

- [ ] **步骤 3：在 runDouyinCheck 的 finally 块中增加 releaseCrawler**

找到 `runDouyinCheck` 函数的 finally 块（Phase 3 完成后），在现有的清理逻辑之后新增：

```typescript
  releaseCrawler('douyin', task.windowId);
```

- [ ] **步骤 4：替换 runKuaishouCheck 中的所有调用点**

在 `monitorService.ts` 的 `runKuaishouCheck` 函数中（约 L840-965），将所有 `kuaishouCrawler.xxx` 替换为 `getKuaishouCrawler(task.windowId).xxx`。同样可在函数开头添加 `const ks = getKuaishouCrawler(task.windowId);`。

具体替换列表：
- L853, L857, L865, L874 (已在任务2中替换), L876, L890, L898, L924, L925, L928, L935, L944, L960, L961

- [ ] **步骤 5：在 runKuaishouCheck 的 finally 块中增加 releaseCrawler**

```typescript
  releaseCrawler('kuaishou', task.windowId);
```

- [ ] **步骤 6：替换 runXiaohongshuCheck 中的所有调用点**

将所有 `xiaohongshuCrawler.xxx` 替换为 `getXiaohongshuCrawler(task.windowId).xxx`。可在函数开头添加 `const xhs = getXiaohongshuCrawler(task.windowId);`。

具体替换列表：
- L993, L997, L1002, L1003, L1016, L1030, L1038, L1062, L1065

- [ ] **步骤 7：在 runXiaohongshuCheck 的 finally 块中增加 releaseCrawler**

```typescript
  releaseCrawler('xiaohongshu', task.windowId);
```

- [ ] **步骤 8：替换 runTencentCheck 中的所有调用点**

将所有 `tencentCrawler.xxx` 替换为 `getTencentCrawler(task.windowId).xxx`。可在函数开头添加 `const tc = getTencentCrawler(task.windowId);`。

具体替换列表：
- L1102, L1113, L1115, L1135, L1144, L1167, L1171, L1184, L1216

- [ ] **步骤 9：在 runTencentCheck 的 finally 块中增加 releaseCrawler**

```typescript
  releaseCrawler('tencent', task.windowId);
```

- [ ] **步骤 10：替换 executeReplyAction 中的所有调用点**

在 `monitorService.ts` 的 `executeReplyAction` 函数中（约 L1499-1864），将所有 `douyinCrawler.xxx` / `kuaishouCrawler.xxx` / `xiaohongshuCrawler.xxx` / `tencentCrawler.xxx` 替换为对应的 `getCrawler(task.windowId).xxx`。

具体替换列表：
- L1572: `douyinCrawler.navigateToCreatorHome` → `getDouyinCrawler(task.windowId).navigateToCreatorHome`
- L1576: `douyinCrawler.navigateToCommentManage` → `getDouyinCrawler(task.windowId).navigateToCommentManage`
- L1662: `douyinCrawler.replyToComment` → `getDouyinCrawler(task.windowId).replyToComment`
- L1678: `kuaishouCrawler.navigateToHome` → `getKuaishouCrawler(task.windowId).navigateToHome`
- L1681: `kuaishouCrawler.navigateToCommentPageDirect` → `getKuaishouCrawler(task.windowId).navigateToCommentPageDirect`
- L1693: `kuaishouCrawler.selectVideoForReply` → `getKuaishouCrawler(task.windowId).selectVideoForReply`
- L1714: `kuaishouCrawler.replyToComment` → `getKuaishouCrawler(task.windowId).replyToComment`
- L1728: `tencentCrawler.handleLogin` → `getTencentCrawler(task.windowId).handleLogin`
- L1735: `tencentCrawler.navigateToCommentManage` → `getTencentCrawler(task.windowId).navigateToCommentManage`
- L1779: `tencentCrawler.replyToComment` → `getTencentCrawler(task.windowId).replyToComment`
- L1790: `tencentCrawler.executeExitStrategy` → `getTencentCrawler(task.windowId).executeExitStrategy`
- L1798: `xiaohongshuCrawler.navigateToCreatorHome` → `getXiaohongshuCrawler(task.windowId).navigateToCreatorHome`
- L1804: `xiaohongshuCrawler.clickThumbnailAndWaitNewTab` → `getXiaohongshuCrawler(task.windowId).clickThumbnailAndWaitNewTab`
- L1825: `xiaohongshuCrawler.replyToComment` → `getXiaohongshuCrawler(task.windowId).replyToComment`
- L1840: `xiaohongshuCrawler.executeExitStrategy` → `getXiaohongshuCrawler(task.windowId).executeExitStrategy`

- [ ] **步骤 11：在 executeReplyAction 的 finally 块中增加 listener 清理**

在 `executeReplyAction` 的 finally 块中（约 L1847-1863），在现有的 `executeExitStrategy` 调用之前，新增 listener 清理：

```typescript
  } finally {
    // 清理 listener 状态（不释放实例，留给后续 Monitor 复用）
    const platform = task.platform;
    const crawler = platform === 'douyin' ? getDouyinCrawler(task.windowId)
      : platform === 'kuaishou' ? getKuaishouCrawler(task.windowId)
      : platform === 'xiaohongshu' ? getXiaohongshuCrawler(task.windowId)
      : platform === 'tencent' ? getTencentCrawler(task.windowId)
      : null;
    if (crawler) {
      try { (crawler as any).unregisterListener?.(); } catch {}
      try { (crawler as any).unregisterCommentListener?.(); } catch {}
    }

    // 原有的 exitStrategy 逻辑保持不变
    if (task.platform === 'douyin') {
      try {
        await getDouyinCrawler(task.windowId).executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
      } catch {}
    }
    // ... 其他平台同理
  }
```

- [ ] **步骤 12：验证无残留的单例引用**

运行：`cd /home/lrp/social_media_complete && grep -n 'douyinCrawler\.\|kuaishouCrawler\.\|xiaohongshuCrawler\.\|tencentCrawler\.' apps/ts-api-gateway/src/services/monitorService.ts | grep -v 'getDouyinCrawler\|getKuaishouCrawler\|getXiaohongshuCrawler\|getTencentCrawler\|function get\|//'`
预期：无输出（所有引用已替换）

- [ ] **步骤 13：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep monitorService | head -10`
预期：无新增错误

- [ ] **步骤 14：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix: isolate Crawler instances per window to prevent cross-window comment data contamination"
```

---

## 任务 4：全量验证

- [ ] **步骤 1：TypeScript 全量编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | tail -20`
预期：无新增错误

- [ ] **步骤 2：搜索残留的 (this as any) 引用**

运行：`cd /home/lrp/social_media_complete && grep -rn '(this as any)\._' apps/ts-api-gateway/src/crawlers/ --include="*.ts" | grep -v ".test."`
预期：无输出（所有动态属性已声明为正式字段）

- [ ] **步骤 3：搜索残留的单例引用**

运行：`cd /home/lrp/social_media_complete && grep -n 'const douyinCrawler\|const kuaishouCrawler\|const xiaohongshuCrawler\|const tencentCrawler' apps/ts-api-gateway/src/services/monitorService.ts`
预期：无输出（单例声明已删除）

- [ ] **步骤 4：搜索残留的裸引用**

运行：`cd /home/lrp/social_media_complete && grep -nE '\b(douyinCrawler|kuaishouCrawler|xiaohongshuCrawler|tencentCrawler)\.' apps/ts-api-gateway/src/services/monitorService.ts | grep -v 'getDouyinCrawler\|getKuaishouCrawler\|getXiaohongshuCrawler\|getTencentCrawler\|function get\|crawlerCache\|//'`
预期：无输出

- [ ] **步骤 5：最终 Commit**

```bash
git add -A
git commit -m "chore: window crawler isolation — verification complete"
```

---

## 自检

| 检查项 | 结果 |
|-------|------|
| 规格覆盖度 — Crawler 工厂函数 | ✅ 任务 3 步骤 1 |
| 规格覆盖度 — 66 个调用点替换 | ✅ 任务 3 步骤 2-11 |
| 规格覆盖度 — releaseCrawler | ✅ 任务 3 步骤 3,5,7,9 |
| 规格覆盖度 — Reply 路径 listener 清理 | ✅ 任务 3 步骤 11 |
| 规格覆盖度 — 动态属性声明为 private | ✅ 任务 1 |
| 规格覆盖度 — 快手 checkForUpdates 签名 | ✅ 任务 2 |
| 规格覆盖度 — 保留跨用户保护和评论去重 | ✅ 不涉及修改（保留原样） |
| 占位符扫描 | ✅ 无 TODO/待定 |
| 类型一致性 | ✅ getCrawler 返回类型与原单例类型一致 |
