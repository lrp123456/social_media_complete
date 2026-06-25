# 置顶视频跳过采集功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现置顶视频跳过采集功能，支持按用户+平台独立控制，默认跳过

**架构：** 在爬虫层识别置顶字段并写入 `VideoInfo`，在 `monitorService.ts` 的 Phase1 后过滤置顶视频（在 Light 模式判断之前），前端提供设置面板

**技术栈：** TypeScript, Prisma, Playwright, 企业微信 SDK

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `prisma/schema.prisma` | 数据模型定义 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音爬虫，识别 `is_pinned` 字段 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫，识别 `photoTop` 字段 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 小红书爬虫，识别 `sticky` 字段 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 视频号爬虫，识别 `stickyOpStatus` 字段 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 数据库存储，`reconcileVideosForUser` |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 监控服务，Phase1 后过滤置顶视频 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | API 端点，`PATCH /skip-pinned` |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 前端 hooks，`useUpdateSkipPinnedVideos` |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 前端 UI，置顶视频设置面板 |

---

## 任务 1：Prisma Schema 迁移

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：添加 Video.isPinned 字段**

```prisma
model Video {
  // ...现有字段...
  isPinned Boolean @default(false) @map("is_pinned")
}
```

- [ ] **步骤 2：添加 User.skipPinnedVideos 字段**

```prisma
model User {
  // ...现有字段...
  skipPinnedVideos Json? @map("skip_pinned_videos")
}
```

- [ ] **步骤 3：运行 Prisma 迁移**

```bash
cd /home/lrp/social_media_complete
npx prisma migrate dev --name add-pinned-video-fields
```

- [ ] **步骤 4：Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add Video.isPinned and User.skipPinnedVideos fields"
```

---

## 任务 2：抖音爬虫置顶识别

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

- [ ] **步骤 1：读取 fetchVideoListFromSource 函数**

读取 `douyinCrawler.ts` 中 `fetchVideoListFromSource` 函数，了解当前实现。

- [ ] **步骤 2：添加 isPinned 到 VideoInfo 类型**

```typescript
type VideoInfo = {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: string;
  isPinned: boolean;  // 新增
};
```

- [ ] **步骤 3：从 raw response 提取 isPinned**

在 `fetchVideoListFromSource` 中，参考现有的 `awemeIdToAuthor` Map 模式：

```typescript
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.aweme_list || []) {
    awemeIdToIsPinned.set(item.aweme_id, item.is_pinned === true);
  }
}
```

- [ ] **步骤 4：在 enriched.map() 中追加 isPinned**

```typescript
const videos: VideoInfo[] = items.map(item => ({
  aweme_id: item.aweme_id,
  description: item.description || '',
  create_time: item.create_time || 0,
  comment_count: item.statistics?.comment_count || 0,
  metrics: JSON.stringify(item.statistics || {}),
  isPinned: awemeIdToIsPinned.get(item.aweme_id) || false,
}));
```

- [ ] **步骤 5：在 commentsQueue.push() 中添加 isPinned**

找到所有 `commentsQueue.push(...)` 调用点（3 处），添加 `isPinned`：

```typescript
commentsQueue.push({
  awemeId: video.aweme_id,
  description: video.description,
  createTime: video.create_time,
  oldCount: dbVideo.commentCount,
  newCount: video.comment_count,
  isFirstCrawl: true,
  _userId: userId,
  isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,
});
```

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "douyinCrawler" | head -20
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat: add isPinned detection for douyin crawler"
```

---

## 任务 3：快手爬虫置顶识别

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

- [ ] **步骤 1：读取 fetchVideoListFromSource 函数**

读取 `kuaishouCrawler.ts` 中 `fetchVideoListFromSource` 函数。

- [ ] **步骤 2：添加 isPinned 到 VideoInfo 类型**

```typescript
interface VideoInfo {
  workId: string;
  title: string;
  createTime: number;
  commentCount: number;
  metrics: string;
  isPinned: boolean;  // 新增
}
```

- [ ] **步骤 3：从 raw response 提取 isPinned**

```typescript
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.list || []) {
    awemeIdToIsPinned.set(item.workId, item.photoTop === true);
  }
}
```

- [ ] **步骤 4：在 enriched.map() 中追加 isPinned**

```typescript
const videos: VideoInfo[] = items.map(item => ({
  workId: item.workId,
  title: item.title || '',
  createTime: item.createTime || 0,
  commentCount: item.commentCount || 0,
  metrics: JSON.stringify(item.metrics || {}),
  isPinned: awemeIdToIsPinned.get(item.workId) || false,
}));
```

- [ ] **步骤 5：在 commentsQueue.push() 中添加 isPinned**

找到所有 `commentsQueue.push(...)` 调用点（3 处），添加 `isPinned`。

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "kuaishouCrawler" | head -20
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat: add isPinned detection for kuaishou crawler"
```

---

## 任务 4：小红书爬虫置顶识别

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

- [ ] **步骤 1：读取 fetchNoteListFromSource 函数**

读取 `xiaohongshuCrawler.ts` 中 `fetchNoteListFromSource` 函数。

- [ ] **步骤 2：添加 isPinned 到 VideoInfo 类型**

```typescript
interface VideoInfo {
  id: string;
  display_title: string;
  time: string;
  comments_count: number;
  metrics: string;
  isPinned: boolean;  // 新增
}
```

- [ ] **步骤 3：从 raw response 提取 isPinned**

```typescript
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.notes || []) {
    awemeIdToIsPinned.set(item.id, item.sticky === true);
  }
}
```

- [ ] **步骤 4：在 enriched.map() 中追加 isPinned**

```typescript
const videos: VideoInfo[] = items.map(item => ({
  id: item.id,
  display_title: item.display_title || '',
  time: item.time || '',
  comments_count: item.comments_count || 0,
  metrics: JSON.stringify(item.metrics || {}),
  isPinned: awemeIdToIsPinned.get(item.id) || false,
}));
```

- [ ] **步骤 5：在 commentsQueue.push() 中添加 isPinned**

找到所有 `commentsQueue.push(...)` 调用点（1 处），添加 `isPinned`。

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "xiaohongshuCrawler" | head -20
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat: add isPinned detection for xiaohongshu crawler"
```

---

## 任务 5：视频号爬虫置顶识别

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **步骤 1：读取 checkForUpdates 函数**

读取 `tencentCrawler.ts` 中 `checkForUpdates` 函数。

- [ ] **步骤 2：添加 isPinned 到 TencentVideoInfo 类型**

```typescript
type TencentVideoInfo = {
  exportId: string;
  desc: string;
  createTime: number;
  commentCount: number;
  metrics: string;
  isPinned: boolean;  // 新增
};
```

- [ ] **步骤 3：从 raw response 提取 isPinned**

```typescript
const awemeIdToIsPinned = new Map<string, boolean>();
for (const resp of rawResponses) {
  for (const item of resp.data?.list || []) {
    awemeIdToIsPinned.set(item.exportId, item.stickyOpStatus === 2);
  }
}
```

- [ ] **步骤 4：在 enriched.map() 中追加 isPinned**

```typescript
const videos: TencentVideoInfo[] = items.map(item => ({
  exportId: item.exportId,
  desc: item.desc?.description || '',
  createTime: item.createTime || 0,
  commentCount: item.commentCount || 0,
  metrics: JSON.stringify(item.metrics || {}),
  isPinned: awemeIdToIsPinned.get(item.exportId) || false,
}));
```

- [ ] **步骤 5：在 commentsQueue.push() 中添加 isPinned**

找到所有 `commentsQueue.push(...)` 调用点（2 处），添加 `isPinned`。

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "tencentCrawler" | head -20
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat: add isPinned detection for tencent crawler"
```

---

## 任务 6：数据库存储 isPinned

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`

- [ ] **步骤 1：读取 reconcileVideosForUser 函数**

读取 `monitorDatabaseService.ts` 中 `reconcileVideosForUser` 函数。

- [ ] **步骤 2：修改函数类型签名**

在 `visibleVideos` 参数类型中添加 `isPinned?: boolean`：

```typescript
visibleVideos: Array<{
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics?: any;
  isPinned?: boolean;  // 新增
}>
```

- [ ] **步骤 3：在 upsertVideo 中包含 isPinned**

```typescript
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

- [ ] **步骤 4：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "monitorDatabaseService" | head -20
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat: store isPinned field in video database"
```

---

## 任务 7：monitorService 过滤逻辑

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：读取 runDouyinCheck 函数**

读取 `monitorService.ts` 中 `runDouyinCheck` 函数，找到 Phase1 结束后的位置。

- [ ] **步骤 2：在 Phase1 结束后添加过滤逻辑**

在 `const queue = phase1Result.commentsQueue` 之后、`if (crawlMode === 'light')` 之前：

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
```

- [ ] **步骤 3：修改 Light 模式判断使用 filteredQueue**

```typescript
// Light 模式判断（使用 filteredQueue）
if (crawlMode === 'light') {
  return { hasUpdate: true, commentsQueue: filteredQueue, ... };
}
```

- [ ] **步骤 4：修改 Phase3 使用 filteredQueue**

将所有 `queue` 引用改为 `filteredQueue`。

- [ ] **步骤 5：对其他 3 个平台重复步骤 1-4**

对 `runKuaishouCheck`、`runXiaohongshuCheck`、`runTencentCheck` 重复相同修改。

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "monitorService" | head -20
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat: add pinned video filtering in monitorService"
```

---

## 任务 8：API 端点

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：添加 PATCH /skip-pinned 端点**

```typescript
/** PATCH /matrix/monitor/accounts/:userId/skip-pinned — 更新置顶视频跳过设置 */
router.patch('/monitor/accounts/:userId/skip-pinned', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { skipPinnedVideos } = req.body;
    
    if (!skipPinnedVideos || typeof skipPinnedVideos !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid skipPinnedVideos format' });
    }
    
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

- [ ] **步骤 2：修改 GET /monitor/accounts/:userId 端点**

在视频列表中返回 `isPinned` 字段。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "matrix" | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat: add PATCH /skip-pinned API endpoint"
```

---

## 任务 9：前端 Hooks

**文件：**
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：添加 useUpdateSkipPinnedVideos hook**

```typescript
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

- [ ] **步骤 2：修改 MonitorVideoDetail 类型**

```typescript
export interface MonitorVideoDetail {
  // ...现有字段...
  isPinned: boolean;
}
```

- [ ] **步骤 3：验证前端构建**

```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard
npm run build
```

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat: add useUpdateSkipPinnedVideos hook"
```

---

## 任务 10：前端 UI

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：添加状态变量**

```typescript
const [showPinnedSettings, setShowPinnedSettings] = useState<number | null>(null);
const [pinnedSettings, setPinnedSettings] = useState<Record<string, boolean>>({});
```

- [ ] **步骤 2：添加「置顶视频设置」按钮**

在用户卡片操作区域添加按钮。

- [ ] **步骤 3：添加设置面板**

实现置顶视频设置面板 UI。

- [ ] **步骤 4：添加视频列表置顶标记**

```tsx
{video.isPinned && <span className="text-yellow-500">📌</span>}
```

- [ ] **步骤 5：验证前端构建**

```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard
npm run build
```

- [ ] **步骤 6：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat: add pinned video settings UI"
```

---

## 任务 11：Docker 重建和集成测试

**文件：**
- 无代码修改

- [ ] **步骤 1：重建 Docker 容器**

```bash
cd /home/lrp/social_media_complete
docker compose build --no-cache ts-api-gateway admin-dashboard
```

- [ ] **步骤 2：重启容器**

```bash
docker compose up -d
sleep 8
docker logs sm-ts-api 2>&1 | grep -iE "注册浏览器|apiPort|error" | tail -3
```

- [ ] **步骤 3：测试 API 端点**

```bash
# 测试 PATCH /skip-pinned
curl -X PATCH http://localhost:3001/api/v1/matrix/monitor/accounts/20/skip-pinned \
  -H "Content-Type: application/json" \
  -d '{"skipPinnedVideos": {"douyin": true, "kuaishou": false}}'
```

- [ ] **步骤 4：验证前端显示**

访问监控页面，验证置顶视频设置面板正常工作。

- [ ] **步骤 5：Commit 最终版本**

```bash
git add -A
git commit -m "feat: complete skip pinned videos feature"
```

---

## 自检清单

- [ ] 规格中的所有需求都有对应任务
- [ ] 所有代码步骤都包含完整代码块
- [ ] `VideoInfo` 接口在 4 处都已修改
- [ ] `CommentQueueItem` 在 9 处 `push()` 调用点都已修改
- [ ] 过滤逻辑在 Light 模式判断之前
- [ ] 输入验证包含平台名和 boolean 值检查
