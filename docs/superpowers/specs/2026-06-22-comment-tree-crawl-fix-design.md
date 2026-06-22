# 评论树爬取修复 + 反检测审计 + 轻量模式 UI 设计规格

> **日期**: 2026-06-22
> **状态**: 待审查
> **关联文件**: `interceptor.ts`, `xiaohongshuCrawler.ts`, `douyinCrawler.ts`, `kuaishouCrawler.ts`, `tencentCrawler.ts`, `monitorDatabaseService.ts`, `admin-dashboard/src/app/matrix/page.tsx`

## 1. 背景与问题

### 1.1 滚动循环永不退出

`scrollLoadRootComments()` 依赖 `getCollectedItems()` 获取评论数据，但 `extractItems()` 不认识各平台的评论 API 响应路径，导致 `getCollectedItems()` 永远返回空数组。退出条件 `!hasMore && allItems.length > 0` 永远不满足，循环跑满 30 次（45-60 秒）。

### 1.2 轻量模式合成评论混入评论树

`upsertLightModeComment()` 创建的合成评论（`[轻量模式] X 条新评论`）与真实评论混在一起显示在评论树中。

### 1.3 文本框叠加

`upsertLightModeComment()` 的 CID 为 `light_${videoId}_${create_time}`，每次 `create_time` 不同导致创建新记录而非更新，造成多个轻量通知叠加。

### 1.4 反检测合规性

需要确认新增 LoginTabRegistry 代码符合 HumanActions 反检测标准，以及 HumanActions 本身是否存在高风险模式。

## 2. 各平台评论 API 响应结构

| 平台 | 评论列表路径 | has_more 判断 | 分页游标 |
|------|-------------|--------------|---------|
| 抖音 | `body.comments` | `body.has_more !== 0`（number: 0=无更多，非0=有） | `body.cursor` |
| 快手 | `body.data.list` | `!!body.data.pcursor`（存在=有更多，不存在=无更多） | `body.data.pcursor` |
| 小红书 | `body.data.comments` | `body.data.has_more === true`（boolean） | `body.data.cursor` |
| 视频号 | `body.data.comment` | `body.data.downContinueFlag !== 0`（0=无更多，非0=有更多） | `body.data.lastBuff` |

## 3. 设计：修复 extractItems + extractHasMore

### 3.1 extractItems 新增路径

在 `interceptor.ts:66-101` 的 `extractItems()` 函数中，`return []` 之前追加：

```typescript
// 抖音评论管理页面
const douyinComments = body.comments;
if (Array.isArray(douyinComments)) return douyinComments;
// 小红书评论
const xhsComments = body.data?.comments;
if (Array.isArray(xhsComments)) return xhsComments;
// 视频号评论
const tencentComments = body.data?.comment;
if (Array.isArray(tencentComments)) return tencentComments;
```

快手已有 `body.data?.list` 路径覆盖，无需改动。

### 3.2 extractHasMore 修复

在 `interceptor.ts:31-50` 的 `extractHasMore()` 函数中：

1. 修复抖音 number 类型：`body.has_more` 实际是 number（0/1），当前按 boolean 判断会返回 undefined
2. 新增快手 pcursor 存在性检测
3. 新增视频号 downContinueFlag 检测

```typescript
// 抖音：has_more 是 number（0=无更多，非0=有更多）
if (typeof body.has_more === 'number') return body.has_more !== 0;
if (typeof body.has_more === 'boolean') return body.has_more;
if (body.data && typeof body.data.has_more === 'number') return body.data.has_more !== 0;
if (body.data && typeof body.data.has_more === 'boolean') return body.data.has_more;
// 快手：pcursor 存在则有更多
if (body.data && body.data.pcursor !== undefined && body.data.pcursor !== null && body.data.pcursor !== '') return true;
// 视频号：downContinueFlag
if (body.data && typeof body.data.downContinueFlag === 'number') return body.data.downContinueFlag !== 0;
// 腾讯视频号: continueFlag
if (body.data && typeof body.data.continueFlag === 'boolean') return body.data.continueFlag;
```

### 3.3 scrollLoadRootComments 稳健性增强

修复后 `getCollectedItems()` 将正确返回评论数据，退出条件 `!hasMore && allItems.length > 0` 将在 `has_more` 为 false 时正确触发。

为稳健性增加"连续 N 次滚动无新响应"的兜底退出：

```typescript
async scrollLoadRootComments(newPage: Page): Promise<any[]> {
  const interceptor = this.commentInterceptor as RequestInterceptor;
  const pattern = '/api/sns/web/v2/comment/page'; // XHS 示例；各 crawler 使用各自的 API pattern

  await interceptor.waitForResponse(pattern, 15000).catch(() => {});

  let prevItemCount = 0;
  let noNewItemsStreak = 0;
  const maxNoNewItems = 3;

  for (let attempt = 0; attempt < 15; attempt++) {
    const items = interceptor.getCollectedItems(pattern);
    if (items.length > prevItemCount) {
      prevItemCount = items.length;
      noNewItemsStreak = 0;
    } else {
      noNewItemsStreak++;
    }

    const responses = interceptor.getResponses(pattern);
    const lastResp = responses[responses.length - 1];
    const hasMore = lastResp?.hasMore;

    if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {
      break;
    }

    // 滚动
    await this.scrollCommentArea(newPage);
    await HumanActions.wait(newPage, 1500, 2500);
  }

  return interceptor.getCollectedItems(pattern);
}
```

关键改动：
- `maxScrollAttempts` 从 30 降到 15
- 增加 `noNewItemsStreak` 兜底退出
- 使用 `lastResp?.hasMore`（由 `extractHasMore` 提取）而非手动读 `body.data.has_more`

## 4. 设计：HumanActions 合规性

### 4.1 LoginTabRegistry 合规性

LoginTabRegistry 使用的操作全部是被动 CDP 命令，不涉及鼠标模拟：

| 操作 | 底层机制 | 反检测风险 |
|------|---------|-----------|
| `page.waitForSelector()` | CDP DOM 查询 | 无 |
| `page.$()` | CDP DOM 查询 | 无 |
| `page.evaluate()` | CDP Runtime.evaluate | 无 |
| `page.screenshot()` | CDP Page.captureScreenshot | 无 |
| `page.goto()` / `page.reload()` | CDP Page.navigate / Page.reload | 无 |
| `page.close()` | CDP Target.closeTarget | 无 |

**结论：LoginTabRegistry 无反检测风险。**

### 4.2 HumanActions 本身审计

HumanActions 的反检测机制：

| 机制 | 实现 | 风险评估 |
|------|------|---------|
| 鼠标轨迹 | `TrajectoryGenerator.generateBezierPath()` — 贝塞尔曲线生成自然轨迹 | 低 — 轨迹点间有随机延迟 |
| 点击偏移 | `gaussianOffset()` — 高斯分布随机偏移，避免精确点击元素中心 | 低 |
| 滚动行为 | `CDPScroller` — 分段滚动 + 随机步长 | 低 |
| 行为噪声 | `BehaviorNoise` — 随机微交互（hover、微滚、idle move） | 低 |
| 延迟 | `HumanActions.wait(page, min, max)` — 随机区间等待 | 低 |

**已知高风险点**：
- `cdpSmartScroll` 的滚动步长可能过于规律（固定 400px），建议增加随机性
- 行为噪声的触发频率可能不够自然

**结论：HumanActions 整体反检测机制健全，无立即需要修复的高风险点。** 上述已知点可在后续迭代中优化。

## 5. 设计：轻量模式不展示在评论树中

### 5.1 后端改动

`new-comments` API 返回评论时，标记 `isLightMode: true`：

```typescript
// 在返回评论列表时
comments.map(c => ({
  ...c,
  isLightMode: c.cid?.startsWith('light_') || false,
}))
```

### 5.2 前端改动

在 `admin-dashboard/src/app/matrix/page.tsx` 的视频详情展开区域，增加 tab 切换：

```tsx
// 新增状态
const [commentTab, setCommentTab] = useState<'comments' | 'notifications'>('comments');

// 分离数据
const realComments = videoCommentsData?.filter(c => !c.isLightMode) || [];
const lightNotifications = videoCommentsData?.filter(c => c.isLightMode) || [];

// Tab 切换 UI
<div className="flex gap-2 mb-2">
  <button onClick={() => setCommentTab('comments')}
    className={cn('px-3 py-1 rounded text-sm', commentTab === 'comments' ? 'bg-primary text-white' : 'bg-surface-container')}>
    评论详情 ({realComments.length})
  </button>
  <button onClick={() => setCommentTab('notifications')}
    className={cn('px-3 py-1 rounded text-sm', commentTab === 'notifications' ? 'bg-amber-500 text-white' : 'bg-surface-container')}>
    更新通知 ({lightNotifications.length})
  </button>
</div>

// 根据 tab 显示不同内容
{commentTab === 'comments' ? <CommentTree comments={realComments} /> : <LightNotifications items={lightNotifications} />}
```

## 6. 设计：修复文本框叠加

### 根因

`monitorDatabaseService.ts:291`：

```typescript
const cid = `light_${videoId}_${info.create_time}`; // 每次不同 → 新建记录
```

### 修复

```typescript
const cid = `light_${videoId}`; // 固定 → upsert 更新已有记录
```

每次检测到评论数变化，更新同一条记录的 `text` 和 `createTime`。

## 7. 文件改动清单

| 文件 | 改动 |
|------|------|
| `packages/browser-core/src/interceptor.ts` | `extractItems()` 新增 3 个评论路径；`extractHasMore()` 修复抖音 number + 新增快手/视频号 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | `scrollLoadRootComments()` 增加 noNewItemsStreak 兜底退出，maxScrollAttempts 降到 15 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 评论采集逻辑适配新的 extractItems/extractHasMore |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 同上 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 同上 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | `upsertLightModeComment()` CID 改为固定 `light_${videoId}` |
| `apps/ts-api-gateway/src/routes/monitor.ts` (或相关 API) | `new-comments` 返回时标记 `isLightMode` |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 评论区域增加 tab 切换（评论详情 / 更新通知） |
