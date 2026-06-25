# 置顶视频跳过采集功能设计规格

**日期**: 2026-06-23  
**状态**: 已批准（Oracle 审查通过）  
**作者**: AI Assistant

---

## 1. 问题概述

当前系统对所有视频（包括置顶视频）同等对待，没有识别、标记或跳过逻辑。置顶视频通常是长期存在的内容，其评论采集会导致：
- 重复采集已知评论
- 浪费 Phase3 采集资源
- 前端显示大量重复数据

---

## 2. 设计决策

### 2.1 默认行为
**决策**：默认跳过置顶视频（新用户自动启用跳过）

**理由**：
- 置顶视频通常是长期存在的内容，评论变化缓慢
- 跳过可以节省采集资源，提高效率
- 用户可以按需开启采集

### 2.2 控制粒度
**决策**：按用户+平台控制（同一个用户在抖音跳过，但在快手不跳过）

**理由**：
- 不同平台的置顶视频策略不同
- 用户可能对不同平台有不同的采集需求
- 提供更细粒度的控制

### 2.3 数据存储
**决策**：存储 `isPinned` 字段，前端可以显示置顶标记

**理由**：
- 便于前端区分显示
- 支持后续的置顶视频统计分析
- 为 Phase3 跳过提供判断依据

### 2.4 Phase3 跳过
**决策**：跳过置顶视频时不进行 Phase3 评论采集

**理由**：
- 置顶视频评论变化缓慢，无需频繁采集
- 节省浏览器资源和 API 调用
- 减少风控风险

---

## 3. 各平台置顶字段

| 平台 | API 字段 | 非置顶值 | 置顶值 |
|------|----------|----------|--------|
| 快手 | `photoTop` | `false` | `true` |
| 抖音 | `is_pinned` | `false` | `true` |
| 小红书 | `sticky` | `false` | `true` |
| 视频号 | `stickyOpStatus` | `0` | `2` |

---

## 4. 详细设计

### 4.1 数据模型

**修改文件**：`prisma/schema.prisma`

```prisma
model Video {
  // ...现有字段...
  isPinned Boolean @default(false) @map("is_pinned")
}

model User {
  // ...现有字段...
  skipPinnedVideos Json? @map("skip_pinned_videos")
  // 格式: { "douyin": true, "kuaishou": false, "xiaohongshu": true, "tencent": true }
  // 默认 null（等同于所有平台 true）
}
```

**设计决策**：
- `Video.isPinned`：标记视频是否为置顶，用于前端显示和 Phase3 跳过判断
- `User.skipPinnedVideos`：JSON 字段，按平台独立控制，默认 `null`（等同于所有平台 `true`）

### 4.2 置顶识别逻辑

**⚠️ 关键：`VideoInfo` 接口分散在 4 处，需全量同步修改**

代码库中存在 4 个不同的 `VideoInfo` 定义：

| 文件 | 类型名 | 当前字段 |
|------|--------|----------|
| `douyinCrawler.ts:21` | `type VideoInfo` | `aweme_id, description, create_time, comment_count, metrics` |
| `kuaishouCrawler.ts:24` | `interface VideoInfo` | `workId, title, createTime, commentCount, metrics` |
| `xiaohongshuCrawler.ts:26` | `interface VideoInfo` | `id, display_title, time, comments_count, metrics` |
| `tencentCrawler.ts:19` | `type TencentVideoInfo` | `exportId, desc, createTime, commentCount, metrics` |
| `packages/browser-core/src/types.ts:65` | `interface VideoInfo` | 共享定义，字段更少 |

**每个都需要添加 `isPinned: boolean` 字段。**

#### 4.2.1 实现模式：从 raw response 提取 isPinned

参考现有的 `awemeIdToAuthor` Map 模式，使用 `awemeIdToIsPinned` Map 从 raw response 中提取各平台的置顶字段：

```typescript
// 抖音示例：在 fetchVideoListFromSource 中
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.aweme_list || []) {
    awemeIdToIsPinned.set(item.aweme_id, item.is_pinned === true);
  }
}

// 在 enriched.map() 中追加 isPinned
const videos: VideoInfo[] = items.map(item => ({
  aweme_id: item.aweme_id,
  description: item.description || '',
  create_time: item.create_time || 0,
  comment_count: item.statistics?.comment_count || 0,
  metrics: JSON.stringify(item.statistics || {}),
  isPinned: awemeIdToIsPinned.get(item.aweme_id) || false,  // 新增
}));
```

#### 4.2.2 各平台置顶字段提取

```typescript
// 快手
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.list || []) {
    awemeIdToIsPinned.set(item.workId, item.photoTop === true);
  }
}

// 小红书
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.notes || []) {
    awemeIdToIsPinned.set(item.id, item.sticky === true);
  }
}

// 视频号
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.list || []) {
    awemeIdToIsPinned.set(item.exportId, item.stickyOpStatus === 2);
  }
}
```

**修改文件清单**：
- `douyinCrawler.ts` - `fetchVideoListFromSource` + `type VideoInfo`
- `kuaishouCrawler.ts` - `fetchVideoListFromSource` + `interface VideoInfo`
- `xiaohongshuCrawler.ts` - `fetchNoteListFromSource` + `interface VideoInfo`
- `tencentCrawler.ts` - `checkForUpdates` + `type TencentVideoInfo`

### 4.3 数据库存储

**⚠️ 关键：`reconcileVideosForUser` 类型签名需要修改**

当前签名：
```typescript
visibleVideos: Array<{ aweme_id: string; description: string; create_time: number; comment_count: number; metrics?: any; }>
```

需要增加 `isPinned?: boolean`。

**修改文件**：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`

在 `reconcileVideosForUser` 函数中，写入 `isPinned` 字段：

```typescript
// upsertVideo 时包含 isPinned
await prisma.video.upsert({
  where: { id: video.id },
  update: {
    // ...现有字段...
    isPinned: video.isPinned ?? false,
  },
  create: {
    // ...现有字段...
    isPinned: video.isPinned ?? false,
  },
});
```

### 4.4 CommentQueueItem 传递 isPinned

**⚠️ 关键：`CommentQueueItem` 不包含 `isPinned` 字段，需要在所有 `push()` 调用点添加**

当前各爬虫构建 queue item 的代码类似：
```typescript
commentsQueue.push({
  awemeId: video.aweme_id,
  description: video.description,
  createTime: video.create_time,
  oldCount: dbVideo.commentCount,
  newCount: video.comment_count,
  isFirstCrawl: true,
  _userId: userId,
});
```

**需要在每个平台的所有 `commentsQueue.push(...)` 调用处添加 `isPinned`**。

**修改文件和位置**：

| 平台 | 文件 | push() 调用点数量 |
|------|------|------------------|
| 抖音 | `douyinCrawler.ts` | 3 处 |
| 快手 | `kuaishouCrawler.ts` | 3 处 |
| 小红书 | `xiaohongshuCrawler.ts` | 1 处 |
| 视频号 | `tencentCrawler.ts` | 2 处 |

**修改示例**：
```typescript
commentsQueue.push({
  awemeId: video.aweme_id,
  description: video.description,
  createTime: video.create_time,
  oldCount: dbVideo.commentCount,
  newCount: video.comment_count,
  isFirstCrawl: true,
  _userId: userId,
  isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,  // 新增
});
```

### 4.5 过滤和跳过逻辑

**⚠️ 关键：过滤位置必须在 Light 模式判断之前**

当前 Light 模式在 Phase1 后就直接返回（跳过 Phase2/3）：
```typescript
if (crawlMode === 'light') {
  // 直接返回，不经过设计文档标注的过滤点
  return { hasUpdate: true, ... };
}
```

**过滤逻辑应该在 `const queue = phase1Result.commentsQueue` 之后、`if (crawlMode === 'light')` 判断之前执行。**

**修改文件**：`apps/ts-api-gateway/src/services/monitorService.ts` 的 4 个 `run*Check` 函数

```typescript
// Phase1 结束后
const queue = phase1Result.commentsQueue;

// 读取用户配置
const user = await prisma.user.findUnique({ where: { id: task.userId } });
const skipConfig = (user?.skipPinnedVideos as Record<string, boolean>) || {};
const skipPinned = skipConfig[task.platform] !== false; // 默认 true

// 过滤置顶视频（在 Light 模式判断之前）
let filteredQueue = queue;
if (skipPinned) {
  const pinnedVideos = queue.filter(q => q.isPinned);
  if (pinnedVideos.length > 0) {
    logger.info({ platform: task.platform, count: pinnedVideos.length }, '跳过置顶视频');
    filteredQueue = queue.filter(q => !q.isPinned);
  }
}

// Light 模式判断（使用 filteredQueue）
if (crawlMode === 'light') {
  // Light 模式也应记录跳过的置顶视频
  return { hasUpdate: true, commentsQueue: filteredQueue, ... };
}

// Phase3 只处理非置顶视频
if (filteredQueue.length > 0) {
  // ... 现有 Phase3 逻辑（使用 filteredQueue 替代 queue）...
}
```

**设计决策**：
- 在 Phase1 结束后过滤，而非在爬虫层过滤（保持爬虫层职责单一）
- `skipConfig[platform] !== false`：默认跳过，只有显式设置为 `false` 才不跳过
- 过滤后的 `filteredQueue` 直接传给 Phase3，Phase3 不需要修改

### 4.6 API 端点

**修改文件**：`apps/ts-api-gateway/src/routes/matrix.ts`

新增 API 端点：

```typescript
/** PATCH /matrix/monitor/accounts/:userId/skip-pinned — 更新置顶视频跳过设置 */
router.patch('/monitor/accounts/:userId/skip-pinned', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { skipPinnedVideos } = req.body;
    
    if (!skipPinnedVideos || typeof skipPinnedVideos !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid skipPinnedVideos format' });
    }
    
    // 输入验证：只允许已知平台名和 boolean 值
    const validPlatforms = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'];
    for (const [k, v] of Object.entries(skipPinnedVideos)) {
      if (!validPlatforms.includes(k) || typeof v !== 'boolean') {
        return res.status(400).json({ success: false, error: `Invalid platform or value: ${k}` });
      }
    }
    
    await prisma.user.update({
      where: { id: userId },
      data: { skipPinnedVideos },
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

**同时修改**：`GET /matrix/monitor/accounts/:userId` 端点，在视频列表中返回 `isPinned` 字段：

```typescript
// matrix.ts - accounts/:userId 端点
videos: v._count?.comments !== undefined ? {
  // ...现有字段...
  isPinned: v.isPinned,  // 新增
} : undefined,
```

### 4.7 前端 Hooks

**修改文件**：`apps/admin-dashboard/src/hooks/useApi.ts`

```typescript
/** 更新置顶视频跳过设置 */
export function useUpdateSkipPinnedVideos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, skipPinnedVideos }: { userId: number; skipPinnedVideos: Record<string, boolean> }) =>
      api.patch(`/matrix/monitor/accounts/${userId}/skip-pinned`, { skipPinnedVideos }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}
```

**同时修改**：`MonitorVideoDetail` 类型增加 `isPinned` 字段：

```typescript
// useApi.ts - MonitorVideoDetail 类型
export interface MonitorVideoDetail {
  // ...现有字段...
  isPinned: boolean;  // 新增
}
```

### 4.8 前端 UI

**修改文件**：`apps/admin-dashboard/src/app/matrix/page.tsx`

在用户卡片操作区域添加「置顶视频设置」按钮：

```tsx
<button
  onClick={() => setShowPinnedSettings(userId)}
  className="px-3 py-1 text-sm bg-gray-600 text-white rounded hover:bg-gray-700"
>
  置顶视频设置
</button>
```

弹出设置面板：

```tsx
{showPinnedSettings && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg p-6 max-w-md">
      <h3 className="text-lg font-bold mb-4">置顶视频采集设置</h3>
      <p className="mb-4 text-gray-600">控制是否跳过置顶视频的评论采集</p>
      
      {['douyin', 'kuaishou', 'xiaohongshu', 'tencent'].map(platform => (
        <div key={platform} className="flex items-center justify-between mb-3">
          <span>{platformNameMap[platform]}</span>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={pinnedSettings[platform] !== false}
              onChange={(e) => setPinnedSettings(prev => ({
                ...prev,
                [platform]: e.target.checked,
              }))}
            />
            <span className="text-sm">跳过置顶</span>
          </label>
        </div>
      ))}
      
      <div className="flex gap-4 mt-4">
        <button
          onClick={() => savePinnedSettings()}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          保存设置
        </button>
        <button
          onClick={() => setShowPinnedSettings(null)}
          className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
        >
          取消
        </button>
      </div>
    </div>
  </div>
)}
```

**同时修改**：视频列表中对置顶视频加 📌 标记：

```tsx
// 视频列表项
<div className="flex items-center gap-2">
  <span>{video.description}</span>
  {video.isPinned && <span className="text-yellow-500">📌</span>}
</div>
```

---

## 5. 文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `prisma/schema.prisma` | 修改 | 添加 `Video.isPinned` 和 `User.skipPinnedVideos` 字段 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 修改 | 解析 `is_pinned` 字段 + `type VideoInfo` + `commentsQueue.push()` |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 修改 | 解析 `photoTop` 字段 + `interface VideoInfo` + `commentsQueue.push()` |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 修改 | 解析 `sticky` 字段 + `interface VideoInfo` + `commentsQueue.push()` |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 修改 | 解析 `stickyOpStatus` 字段 + `type TencentVideoInfo` + `commentsQueue.push()` |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 修改 | 存储 `isPinned` 字段 + `reconcileVideosForUser` 类型签名 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 修改 | Phase1 后过滤置顶视频（在 Light 模式判断之前） |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 修改 | 新增 `PATCH /skip-pinned` 端点 + 视频列表返回 `isPinned` |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 修改 | 新增 `useUpdateSkipPinnedVideos` + `MonitorVideoDetail.isPinned` |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 修改 | 置顶视频设置 UI + 视频列表置顶标记 |

---

## 6. 测试验证

### 6.1 单元测试

- [ ] 各平台置顶字段正确识别（`is_pinned`, `photoTop`, `sticky`, `stickyOpStatus`）
- [ ] `Video.isPinned` 正确写入数据库
- [ ] `User.skipPinnedVideos` 配置正确读取
- [ ] 置顶视频过滤逻辑正确
- [ ] `CommentQueueItem.isPinned` 正确传递
- [ ] Light 模式下置顶视频也被过滤

### 6.2 集成测试

- [ ] 简单模式下置顶视频被正确跳过
- [ ] 深度模式下置顶视频被正确跳过
- [ ] Light 模式下置顶视频被正确跳过
- [ ] 前端设置面板正常工作
- [ ] API 端点正常响应
- [ ] 输入验证拒绝非法平台名和非 boolean 值

### 6.3 端到端测试

- [ ] 新用户默认跳过置顶视频
- [ ] 用户修改设置后立即生效
- [ ] 前端显示置顶标记（📌）
- [ ] 4 个平台都正常工作

---

## 7. 风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 置顶字段 API 变化 | 无法识别置顶视频 | 监控 API 响应，及时更新字段映射 |
| 用户配置丢失 | 跳过设置失效 | JSON 字段默认 null（等同于所有平台 true） |
| Phase3 跳过导致遗漏 | 置顶视频评论未采集 | 用户可手动开启采集 |
| `VideoInfo` 接口分散 | 修改遗漏 | 全量同步修改 4 处定义 |
| `CommentQueueItem` 缺少 `isPinned` | 过滤逻辑失效 | 在所有 9 处 `push()` 调用点添加 |
| Light 模式遗漏过滤 | 置顶视频未被跳过 | 过滤逻辑放在 Light 模式判断之前 |

---

## 8. 后续优化（不在本次范围内）

- [ ] 置顶视频统计分析
- [ ] 置顶视频评论变化趋势
- [ ] 批量置顶视频操作
- [ ] 置顶视频提醒功能
