# 窗口实例化 Crawler + 应用层隔离（方案 B-2）

> 日期：2026-06-19
> 范围：Crawler 单例改按窗口实例化，interceptor/listener/page 状态完全隔离

---

## 问题根因

`monitorService.ts` 中 4 个 Crawler（douyin/kuaishou/xiaohongshu/tencent）都是模块级单例：

```typescript
const douyinCrawler = new DouyinCrawler(MAX_MONITOR_VIDEOS);  // 单例
```

Crawler 的实例字段 `interceptor`、`listenerPageId`、`commentListenerPageId`、`currentMenuSection`、`page` 被所有窗口共享。当两个窗口同时监控同一平台时，评论 API 响应混入同一 interceptor 存储，`waitForCommentResponse` 取到错误视频的评论，导致评论树绑定到错误的 video_id。

## 设计方案

### 1. Crawler 工厂函数

在 `monitorService.ts` 中，将 4 个模块级单例常量替换为按窗口缓存的工厂函数：

```typescript
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

function getKuaishouCrawler(windowId: string): KuaishouCrawler { /* 同理 */ }
function getXiaohongshuCrawler(windowId: string): XiaohongshuCrawler { /* 同理 */ }
function getTencentCrawler(windowId: string): TencentCrawler { /* 同理 */ }
```

### 2. 调用点替换

`monitorService.ts` 中所有 66 个调用点，从 `douyinCrawler.xxx()` 改为 `getDouyinCrawler(task.windowId).xxx()`。四平台同理。

涉及函数：
- `runDouyinMonitor`（Phase 1 + Phase 2/3）
- `runKuaishouMonitor`（同上）
- `runXiaohongshuMonitor`（同上）
- `runTencentMonitor`（同上）
- `executeReplyAction` 中的回复逻辑（4 平台各一段）

### 3. 窗口缓存清理

任务完成后释放 Crawler 实例，避免内存泄漏：

```typescript
function releaseCrawler(platform: string, windowId: string): void {
  const cache = crawlerCache[platform as keyof typeof crawlerCache];
  if (cache) {
    const crawler = cache.get(windowId);
    if (crawler) {
      // 清理监听器
      try { crawler.unregisterListener?.(); } catch {}
      try { crawler.unregisterCommentListener?.(); } catch {}
      cache.delete(windowId);
    }
  }
}
```

在 monitor 函数的 finally 块中调用 `releaseCrawler`。

### 4. 回退 fixer 自行添加的代码

**douyinCrawler.ts** 中删除两块代码：

1. **跨用户保护**（约 L1248-1260）：删除 `existingVideo` 查询和 `skip` 逻辑
2. **评论去重**（约 L1836-1868）：删除 `firstCrawlGroups` 过滤已存在 CID 的逻辑

这些代码不在原始实现计划中，引入了额外复杂度，且 B-2 方案通过窗口隔离已从根本上防止跨用户数据串扰。

### 5. 不变的部分

- 数据库 schema 不变（`user_id` 外键隔离已正确）
- Crawler 类内部代码不变（interceptor 注册/清除逻辑不变）
- 前端 API 不变
- selectors.json 配置不变

## 验证标准

1. 两个窗口同时监控抖音时，评论不再串扰
2. TypeScript 编译无新增错误
3. 单窗口监控行为与改动前一致（回归验证）

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 单例→工厂函数，66 个调用点替换 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 删除 fixer 自行添加的跨用户保护和评论去重 |
