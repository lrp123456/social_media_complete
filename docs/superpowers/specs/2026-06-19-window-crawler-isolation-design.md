# 窗口实例化 Crawler + 应用层隔离（方案 B-2）

> 日期：2026-06-19
> 范围：Crawler 单例改按窗口实例化，interceptor/listener/page 状态完全隔离
> 审查状态：已修复 Oracle 审查发现的 C1-C3、H1-H4、M2 问题

---

## 问题根因

`monitorService.ts` 中 4 个 Crawler（douyin/kuaishou/xiaohongshu/tencent）都是模块级单例：

```typescript
const douyinCrawler = new DouyinCrawler(MAX_MONITOR_VIDEOS);  // 单例
```

Crawler 的实例字段被所有窗口共享。当两个窗口同时监控同一平台时，评论 API 响应混入同一 interceptor 存储，`waitForCommentResponse` 取到错误视频的评论，导致评论树绑定到错误的 video_id。

## 完整的共享状态字段清单

以下所有字段都必须按窗口隔离：

| 字段 | 抖音 | 快手 | 小红书 | 视频号 | 说明 |
|------|------|------|--------|--------|------|
| `interceptor` | ✅ | ✅ | ✅ | ✅ | API 拦截器，核心隔离对象 |
| `listenerPageId` | ✅ | ✅ | ✅ | ✅ | Phase 1 监听器 ID |
| `commentListenerPageId` | ✅ | ✅ | ❌ | ❌ | Phase 3 评论监听器 ID |
| `currentMenuSection` | ✅ | ✅ | ✅ | ❌ | 当前菜单位置 |
| `page` | ✅ | ✅ | ❌ | ❌ | 当前页面引用 |
| `_awemeIdToPlayCount` | ✅ | ❌ | ❌ | ❌ | 非公开过滤映射（fetchVideoList→checkForUpdates 传递） |
| `_awemeIdToPhotoStatus` | ❌ | ✅ | ❌ | ❌ | 非公开过滤映射（同上） |
| `_commentInterceptor` | ❌ | ❌ | ✅ | ❌ | 独立的评论拦截器实例 |
| `_commentListenerId` | ❌ | ❌ | ✅ | ❌ | 评论监听器 ID |

### 字段规范化

将所有 `(_xxx as any)` 动态属性声明为正式 `private` 字段：

**douyinCrawler.ts**:
```typescript
private awemeIdToPlayCount: Map<string, number> = new Map();
```

**kuaishouCrawler.ts**:
```typescript
private awemeIdToPhotoStatus: Map<string, number> = new Map();
```

**xiaohongshuCrawler.ts**:
```typescript
private commentInterceptor: RequestInterceptor | null = null;
private commentListenerId: string | null = null;
```

将所有 `(this as any)._xxx` 引用替换为 `this.xxx`。

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

### 3. 实例生命周期规则

**关键：同一 `{windowId, platform}` 的 Monitor 和 Reply 任务使用同一个 Crawler 实例。**

理由：
- Phase 2 注册的 `commentListenerPageId` 在 Phase 3 中使用
- Reply 任务可能依赖 Monitor 任务预注册的 listener
- WindowMutex 已确保同一窗口+平台的任务串行执行，不会并发

**释放时机：不在 Phase 之间释放。** 整个 Monitor pipeline（Phase 1→2→3）使用同一实例。释放只在 Monitor 整个 pipeline 完成后的 finally 块中进行。

**Reply 任务的 Crawler 实例：** 通过 `getCrawler(windowId)` 获取——如果 Monitor 任务已创建实例，Reply 复用同一实例。Reply 完成后**不释放**实例（留给后续 Monitor 任务复用）。

### 4. 窗口缓存清理

```typescript
function releaseCrawler(platform: string, windowId: string): void {
  const cache = crawlerCache[platform as keyof typeof crawlerCache];
  if (!cache) return;
  const crawler = cache.get(windowId);
  if (!crawler) return;

  // 清理所有监听器和拦截器
  try { crawler.unregisterListener?.(); } catch {}
  try { crawler.unregisterCommentListener?.(); } catch {}

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

在 Monitor 函数的 **finally 块**（Phase 3 完成后）中调用 `releaseCrawler`。

### 5. Reply 路径增加 interceptor 清理

`executeReplyAction` 的 finally 块中增加清理：

```typescript
// finally 块中
try { crawler.unregisterListener?.(); } catch {}
try { crawler.unregisterCommentListener?.(); } catch {}
```

注意：Reply 完成后不调用 `releaseCrawler`（实例留给后续 Monitor 复用），但清理 listener 状态。

### 6. 不删除跨用户保护和评论去重代码

**保留以下代码，不回退：**

- **跨用户保护**（douyinCrawler.ts ~L1248-1260）：`prisma.video.findUnique()` 查询，检测视频是否已被其他用户爬取。这是**数据层**保护逻辑，与 Crawler 实例隔离正交——无论单例还是按窗口实例化，跨用户数据保护都需要保留。

- **评论去重**（douyinCrawler.ts ~L1836-1868）：`prisma.comment.findMany()` 查询，检测评论是否已存在。同样是数据层逻辑，保留。

### 7. 快手 checkForUpdates 签名统一

快手 `checkForUpdates` 当前签名缺少 `windowId` 参数。统一为：

```typescript
async checkForUpdates(
    page: Page,
    userId: number,
    windowId: string,  // 新增
    source: KuaishouQuerySource
): Promise<KuaishouCheckResult>
```

调用点同步修改。

## 不变的部分

- 数据库 schema 不变
- Crawler 类内部业务逻辑不变
- 前端 API 不变
- selectors.json 配置不变

## 验证标准

1. 两个窗口同时监控抖音时，评论不再串扰
2. TypeScript 编译无新增错误
3. 单窗口监控行为与改动前一致（回归验证）
4. Reply 任务不残留 listener 状态
5. 小红书 `_commentInterceptor` 不泄漏

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 单例→工厂函数，66 个调用点替换，增加 releaseCrawler |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | `_awemeIdToPlayCount` 声明为 private 字段 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | `_awemeIdToPhotoStatus` 声明为 private 字段，checkForUpdates 增加 windowId 参数 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | `_commentInterceptor`/`_commentListenerId` 声明为 private 字段 |
