# 评论数据修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 XHS 字段不匹配 BUG、清理死代码、验证快手/抖音新代码

**架构：** 在 `monitorService.ts` 中修复 XHS 简单模式的字段映射（`exportId` → `awemeId`），清理 4 处 `crawlMode === 'light'` 死代码分支，在 `monitorDatabaseService.ts` 中添加 legacy `'light'` 模式归一化，然后 Docker 重建并手动触发验证。

**技术栈：** TypeScript, Prisma, Docker

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|---------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 监控服务主逻辑 | 修改 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 数据库服务 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫 | 修改 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 小红书爬虫 | 只读（检查接口） |

---

### 任务 1：修复 XHS 简单模式字段映射

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:1451-1454`

- [ ] **步骤 1：定位当前代码**

找到 `monitorService.ts` 中 XHS 简单模式调用处（约 line 1451-1454）：
```typescript
await xhs.processCommentsQueueSimple(page, filteredQueue as any, maxRootComments);
```

- [ ] **步骤 2：替换为正确的字段映射**

```typescript
const xhsQueue = filteredQueue.map(q => ({
  awemeId: q.exportId,
  description: q.description,
  createTime: 0,
  oldCount: q.oldCount,
  newCount: q.newCount,
  isFirstCrawl: q.isFirstCrawl,
  _userId: task.userId,
  isPinned: q.isPinned,
}));
await xhs.processCommentsQueueSimple(page, xhsQueue, maxRootComments);
```

- [ ] **步骤 3：验证 `task.userId` 在作用域内**

确认 `task` 变量在当前函数作用域内可用（`runXiaohongshuCheck` 函数参数）。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix: XHS simple mode field mapping — exportId → awemeId"
```

---

### 任务 2：清理 light 模式死代码 — 抖音

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（抖音 light 模式分支）

- [ ] **步骤 1：定位抖音 light 模式分支**

找到 `runDouyinCheck` 函数中的 `crawlMode === 'light'` 分支（约 line 1070）。

- [ ] **步骤 2：删除 light 模式分支**

删除 `if (crawlMode === 'light') { ... }` 块及其日志。保留 `else` 分支的逻辑作为主路径。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: remove dead crawlMode === 'light' branch — douyin"
```

---

### 任务 3：清理 light 模式死代码 — 快手

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（快手 light 模式分支）

- [ ] **步骤 1：定位快手 light 模式分支**

找到 `runKuaishouCheck` 函数中的 `crawlMode === 'light'` 分支（约 line 1247）。

- [ ] **步骤 2：删除 light 模式分支**

删除 `if (crawlMode === 'light') { ... }` 块及其日志。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: remove dead crawlMode === 'light' branch — kuaishou"
```

---

### 任务 4：清理 light 模式死代码 — 小红书

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（小红书 light 模式分支）

- [ ] **步骤 1：定位小红书 light 模式分支**

找到 `runXiaohongshuCheck` 函数中的 `crawlMode === 'light'` 分支（约 line 1414）。

- [ ] **步骤 2：保留 `filteredQueue.length === 0` 条件**

当前条件是 `crawlMode === 'light' || filteredQueue.length === 0`。删除 `'light'` 检查后，保留：
```typescript
if (filteredQueue.length === 0) {
  // 无更新的处理逻辑（exit + upsert light mode comments）
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: remove dead crawlMode === 'light' branch — xiaohongshu"
```

---

### 任务 5：清理 light 模式死代码 — 腾讯

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（腾讯 light 模式分支）

- [ ] **步骤 1：定位腾讯 light 模式分支**

找到 `runTencentCheck` 函数中的 `crawlMode === 'light'` 分支（约 line 1624）。

- [ ] **步骤 2：删除 light 模式分支**

删除 `if (crawlMode === 'light') { ... }` 块及其日志。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: remove dead crawlMode === 'light' branch — tencent"
```

---

### 任务 6：getCrawlMode legacy 归一化

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts:502-508`

- [ ] **步骤 1：定位 getCrawlMode 函数**

找到 `getCrawlMode` 函数（约 line 502-508）。

- [ ] **步骤 2：添加 legacy 归一化**

```typescript
export async function getCrawlMode(platform: string): Promise<string> {
  const setting = await prisma.crawlSetting.findUnique({
    where: { platform },
  });
  const mode = setting?.mode || 'simple';
  // normalize legacy 'light' mode
  if (mode === 'light') return 'simple';
  return mode;
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "fix: normalize legacy 'light' crawlMode to 'simple'"
```

---

### 任务 7：快手 photoList 等待时间改为轮询

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:2199-2201`

- [ ] **步骤 1：定位 updateCommentCountsFromPhotoList 方法**

找到 `updateCommentCountsFromPhotoList` 方法开头的等待逻辑（约 line 2199-2201）。

- [ ] **步骤 2：替换为轮询**

```typescript
// 原代码：
await HumanActions.wait(page, 500, 1000);

// 替换为：
for (let w = 0; w < 6; w++) {
  const check = this.interceptor.getResponses(PHOTO_LIST_PATTERN);
  if (check.length > 0) break;
  await HumanActions.wait(page, 500, 500);
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "fix: kuaishou photoList wait改为轮询（最多3秒）"
```

---

### 任务 8：Docker 重建 + 手动触发验证

**文件：**
- 无代码变更

- [ ] **步骤 1：Docker 重建**

```bash
cd /home/lrp/social_media_complete && docker compose up -d --build --force-recreate
```

- [ ] **步骤 2：检查容器启动日志**

```bash
docker logs sm-ts-api 2>&1 | tail -20
```

确认无 `crawlMode === 'light'` 相关日志。

- [ ] **步骤 3：手动触发抖音监控**

通过 API 或前端触发一次抖音监控任务。

- [ ] **步骤 4：检查抖音抽屉日志**

```bash
docker logs sm-ts-api 2>&1 | grep -i "Douyin-Drawer" | tail -10
```

预期：看到 `[Douyin-Drawer] Extracted comment counts from drawer DOM` 日志。

- [ ] **步骤 5：手动触发快手监控**

通过 API 或前端触发一次快手监控任务。

- [ ] **步骤 6：检查快手 photoList 日志**

```bash
docker logs sm-ts-api 2>&1 | grep -i "Kuaishou-PhotoList" | tail -10
```

预期：看到 `[Kuaishou-PhotoList] Processing photoList responses for comment counts` 日志。

- [ ] **步骤 7：检查数据库 commentCount**

```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "
SELECT u.platform, COUNT(*) as total, COUNT(CASE WHEN v.comment_count > 0 THEN 1 END) as with_count
FROM videos v JOIN users u ON v.user_id = u.id
GROUP BY u.platform ORDER BY u.platform;"
```

预期：所有平台有 comment_count > 0 的视频。

- [ ] **步骤 8：检查 XHS 评论采集**

```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "
SELECT COUNT(*) as xhs_comments FROM comments c JOIN videos v ON c.video_id = v.id JOIN users u ON v.user_id = u.id WHERE u.platform = 'xiaohongshu';"
```

预期：XHS 有评论记录（不再是 0）。

- [ ] **步骤 9：Commit 验证结果**

如果有额外修复，commit。否则跳过。
