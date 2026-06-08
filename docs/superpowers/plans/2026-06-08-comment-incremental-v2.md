# 评论增量检测 v2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 改造评论检测逻辑为精准增量模式——首轮全量采集 + 后续按 root.subCommentCount 对比定位新增 + 作者评论过滤

**架构：** 两阶段检测（先比总数 → 再比每条根评论的 replyCount），对变化的根评论按需展开回复，按 createTime 过滤新增；作者评论不标记 isNew、不入企微通知

**技术栈：** Prisma ORM (PostgreSQL), Patchright (CDP), TypeScript

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `prisma/schema.prisma` | User 新增 platformAuthorId/platformAuthorName | 修改 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 新增 deleteStaleRootCounts | 修改 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 核心改造：作者提取、快照、局部展开、增量检测 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 同上，快手版本 | 修改 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 通知构建时过滤作者评论 | 修改 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | isNew 高亮样式 | 修改 |

---

### 任务 1：数据库 — User 表新增平台作者字段

**文件：**
- 修改：`prisma/schema.prisma:17-32`

- [ ] **步骤 1：在 User 模型添加 platformAuthorId 和 platformAuthorName**

```prisma
model User {
  id                   Int      @id @default(autoincrement())
  fingerprintWindowId  String   @map("fingerprint_window_id")
  wechatUserid         String   @map("wechat_userid")
  platform             String   @default("douyin")
  status               String   @default("init")
  consecutiveNoUpdate  Int      @default(0) @map("consecutive_no_update")
  cooldownUntil        BigInt   @default(0) @map("cooldown_until")
  monitoringEnabled    Boolean  @default(true) @map("monitoring_enabled")
  platformAuthorId     String?  @map("platform_author_id")
  platformAuthorName   String?  @map("platform_author_name")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  videos    Video[]
  @@unique([fingerprintWindowId, platform], name: "idx_users_window_platform")
  @@map("users")
}
```

- [ ] **步骤 2：生成迁移并确认**

```bash
cd /home/lrp/social_media_complete && npx prisma migrate dev --name add_user_platform_author
```

预期：迁移文件生成，无错误。`docker compose build ts-api-gateway` 可正常完成。

- [ ] **步骤 3：Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add platformAuthorId/platformAuthorName to User"
```

---

### 任务 2：DB 服务层 — 新增 deleteStaleRootCounts

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`（在 line 490 `upsertRootCommentCounts` 之后）

- [ ] **步骤 1：添加 deleteStaleRootCounts 函数**

```typescript
/**
 * 删除指定视频中不在 cid 集合里的根评论计数记录（根评论被删除时清理）
 */
export async function deleteStaleRootCounts(
  videoId: string,
  activeCids: string[],
): Promise<number> {
  if (activeCids.length === 0) {
    // 没有活跃根评论 → 删光
    const result = await prisma.videoRootCommentCount.deleteMany({
      where: { videoId },
    });
    return result.count;
  }
  const result = await prisma.videoRootCommentCount.deleteMany({
    where: {
      videoId,
      cid: { notIn: activeCids },
    },
  });
  return result.count;
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat(db): add deleteStaleRootCounts function"
```

---

### 任务 3：抖音 — 作者 ID 提取 + checkForUpdates 重构基础

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:914-1046` (checkForUpdates)

- [ ] **步骤 1：在 VideoInfo 类型中新增 author 字段**

在 `douyinCrawler.ts` 的 `VideoInfo` 类型定义（line 16-22）后追加：

```typescript
export type VideoInfo = {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, any>;
  authorUid?: string;       // 新增：作者抖音 uid
  authorNickname?: string;  // 新增：作者昵称
};
```

- [ ] **步骤 2：在 fetchVideoListFromSource 中提取 author 字段**

在 `fetchVideoListFromSource` 的 items map（line 290 返回前）中，从 collectedItems 提取 authorUid/authorNickname：

找到 line 279-292 的 `const allItems` → `const sliced` 区域，将 `return sliced` 改为映射：

```typescript
const allItems = this.interceptor.getCollectedItems(pattern);
const sliced = allItems.slice(0, this.maxMonitorVideos).map((item: any) => ({
  ...item,
  authorUid: item.author?.uid || item.author_uid || '',
  authorNickname: item.author?.nickname || item.author_nickname || item.user_nickname || '',
}));
```

- [ ] **步骤 3：在 checkForUpdates 新视频处理中写入 authorId 到 User 表**

在 `checkForUpdates` 的新视频处理分支（line 973-990 `if (!dbVideo)`），在 `continue` 前添加：

```typescript
// 提取作者 ID（每条视频的 author 可能相同，取第一条非空的）
if (!dbVideo && video.authorUid && !userAuthorIdExtracted) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      platformAuthorId: video.authorUid,
      platformAuthorName: video.authorNickname || '',
    },
  });
  userAuthorIdExtracted = true;
  logger.info({ userId, authorUid: video.authorUid }, '[Phase1] Extracted platform author ID');
}
```

需要在函数前部添加 `const userAuthorIdExtracted = false` 标记变量（或者直接查询 DB 中是否已有 authorId 再决定是否更新）。

更简洁的方式：在函数开头查一次 User 表，如果没有 `platformAuthorId` 就标记需要提取：

```typescript
const user = await prisma.user.findUnique({ where: { id: userId } });
let needAuthorId = !user?.platformAuthorId;
```

- [ ] **步骤 4：更新 checkForUpdates 的返回值类型，新增 firstCrawl 标记**

在 `CommentQueueItem` 类型（line 79-86）中新增字段：

```typescript
export interface CommentQueueItem {
  awemeId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;  // true = 新视频首次采集（全量展开+建快照）
}
```

在 checkForUpdates 中，新视频入队时设置 `isFirstCrawl: true`，已有视频入队时设置 `isFirstCrawl: false`。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): extract authorId in checkForUpdates + add isFirstCrawl flag"
```

---

### 任务 4：抖音 — parseRootCommentSnapshots

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（在 `parseCommentList` line 655 附近新增）

- [ ] **步骤 1：定义 RootCommentSnapshot 类型**

在类型定义区域（line 46 后）添加：

```typescript
export interface RootCommentSnapshot {
  cid: string;
  text: string;
  replyCount: number;
  createTime: number;
}
```

- [ ] **步骤 2：实现 parseRootCommentSnapshots**

```typescript
/**
 * 从评论列表 API 响应中提取每条根评论的快照（cid + subCommentCount）
 * 用于后续增量对比检测
 */
private parseRootCommentSnapshots(body: any): RootCommentSnapshot[] {
  const comments: any[] = body?.comments || [];
  return comments
    .filter((c: any) => {
      const replyId = c.reply_id ?? '0';
      return replyId === 0 || replyId === '0' || replyId === null;
    })
    .map((c: any) => ({
      cid: c.cid,
      text: c.text || '',
      replyCount: c.reply_comment_total ?? 0,
      createTime: c.create_time,
    }));
}
```

- [ ] **步骤 3：在 waitForCommentResponse 后调用它保存快照**

`waitForCommentResponse` 在 `douyinCrawler.ts:1535` 返回 `InterceptedResponse | null`。新函数 `saveRootCommentSnapshots`：

```typescript
private async saveRootCommentSnapshots(videoId: string): Promise<RootCommentSnapshot[]> {
  const response = await this.waitForCommentResponse(this.page!);
  if (!response?.body) {
    logger.warn({ videoId }, 'No comment API response for snapshots');
    return [];
  }
  const snapshots = this.parseRootCommentSnapshots(response.body);
  if (snapshots.length > 0) {
    await db.upsertRootCommentCounts(videoId, snapshots.map(s => ({
      cid: s.cid,
      replyCount: s.replyCount,
    })));
  }
  return snapshots;
}
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): add parseRootCommentSnapshots + saveRootCommentSnapshots"
```

---

### 任务 5：抖音 — expandRepliesForRoot 局部展开

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（在 `expandAllReplies` line 728 附近新增）

- [ ] **步骤 1：实现 expandRepliesForRoot**

```typescript
/**
 * 只展开一条根评论下的所有子回复（局部展开，用于增量检测）
 * 返回该 root 下新提取到的子回复 DOM 节点信息
 */
private async expandRepliesForRoot(
  page: Page,
  rootCid: string,
): Promise<Array<{ text: string; replyToName: string }>> {
  const replies: Array<{ text: string; replyToName: string }> = [];

  const containerCss = getSelector('comment.container')?.css || '[class*="container-sXKyMs"]';
  const containers = await HumanActions.queryElementsWithInfo(page, containerCss);

  // 定位目标 root 的容器（通过文本前缀匹配 rootCid）
  for (const container of containers) {
    const containerText = container.text || '';
    const containerKey = containerText.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
    if (containerKey !== rootCid) continue;

    // 检查是否有展开按钮
    const hasExpandBtn = containerText.match(/查看\d+条回复/);
    if (!hasExpandBtn) {
      logger.info({ rootCid }, '[ExpandReplies] No expand button — no replies');
      break;
    }

    // 点击"查看 N 条回复"
    const expandSelectors = [
      getSelector('comment.expand-replies')?.text || '',
      'text=/查看\\d+条回复/',
      'text=/展开/',
    ].filter(Boolean);

    for (const sel of expandSelectors) {
      const clicked = await HumanActions.cdpClickByText(page, sel, { timeout: 3000 });
      if (clicked) {
        await HumanActions.wait(page, 500, 1000);
        break;
      }
    }

    // 提取子回复 DOM 文本
    const subContainerCss = '[class*="reply-list"], [class*="sub-comment"]';
    await HumanActions.wait(page, 300, 500);
    const subReplies = await page.$$eval(subContainerCss + ' > div', (els) =>
      els.map((el) => {
        const text = el.textContent?.trim() || '';
        const replyToMatch = text.match(/回复\s*@?(\S+)/);
        return { text, replyToName: replyToMatch?.[1] || '' };
      })
    );
    replies.push(...subReplies);
    break;
  }

  return replies;
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): add expandRepliesForRoot for targeted reply expansion"
```

---

### 任务 6：抖音 — processCommentsQueue 重构（首次全量 + 后续增量）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1130-1289` (processCommentsQueue)

这部分是核心逻辑改造，替换现有的 `processCommentsQueue` 实现。

- [ ] **步骤 1：重构 processCommentsQueue 主体逻辑**

```typescript
async processCommentsQueue(
  page: Page,
  queue: CommentQueueItem[],
): Promise<{
  results: Array<{ awemeId: string; success: boolean; newComments: number; commentGroups?: any[]; error?: string }>;
  riskDetected: boolean;
  riskInfo?: RiskControlDetection;
}> {
  const results: any[] = [];
  this.page = page;

  for (const item of queue) {
    try {
      // 1. 打开"选择作品"抽屉，找到对应视频
      const drawerOpened = await this.openSelectWorkDrawer(page);
      if (!drawerOpened) {
        results.push({ awemeId: item.awemeId, success: false, newComments: 0, error: '抽屉打开失败' });
        continue;
      }

      const videoFound = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description);
      if (!videoFound) {
        results.push({ awemeId: item.awemeId, success: false, newComments: 0, error: '视频未找到' });
        continue;
      }

      // 2. 拦截评论 API + 保存快照
      const response = await this.waitForCommentResponse(page);
      if (!response?.body) {
        results.push({ awemeId: item.awemeId, success: false, newComments: 0, error: '评论 API 无响应' });
        continue;
      }

      const currentSnapshots = this.parseRootCommentSnapshots(response.body);
      const currentRootCids = currentSnapshots.map(s => s.cid);

      // 3. 加载上次快照对比
      const lastSnapshots = await db.getRootCommentCounts(item.awemeId);
      const isFirstCrawl = lastSnapshots.size === 0;

      if (isFirstCrawl) {
        // === 首次全量采集 ===
        // 3a. 保存快照
        await db.upsertRootCommentCounts(item.awemeId, currentSnapshots.map(s => ({
          cid: s.cid,
          replyCount: s.replyCount,
        })));

        // 3b. 全量展开所有回复
        await this.expandAllReplies(page, item.awemeId, currentRootCids);

        // 3c. DOM 解析 + API 合并
        const domTree = await this.parseCommentTreeFromDOM(page);
        const apiComments = this.mergeApiDataToDOM(domTree, response.body.comments);

        // 3d. 首次全部 isNew=0 + 作者评论不过滤（全量存储）
        const allFlat: any[] = [];
        const flatten = (nodes: any[]) => {
          for (const node of nodes) {
            allFlat.push({ ...node, isNew: 0 }); // 首次全部非新增
            if (node.subComments) flatten(node.subComments);
          }
        };
        flatten(apiComments);

        await db.upsertCommentTree(item.awemeId, allFlat);
        await db.updateCommentCount(item.awemeId, item.newCount);

        results.push({
          awemeId: item.awemeId,
          success: true,
          newComments: 0, // 首次不通知
          commentGroups: [],
        });

      } else {
        // === 后续增量检测 ===
        const newComments: any[] = [];

        // 4a. 对比 root 总数变化
        const apiRootCids = new Set(currentSnapshots.map(s => s.cid));
        const dbRootCids = new Set(lastSnapshots.keys());

        // 4b. 新增根评论
        for (const snapshot of currentSnapshots) {
          if (!dbRootCids.has(snapshot.cid)) {
            // 新根评论 → 按 createTime > lastCheckTime 过滤
            const user = await db.getUserById(item._userId);
            const lastCheckTime = (await prisma.monitorStatus.findFirst({
              where: { accountId: String(item._userId), platform: 'douyin' },
            }))?.lastCheckTime?.getTime() || 0;

            if (snapshot.createTime * 1000 > lastCheckTime) {
              const isAuthor = user?.platformAuthorId && snapshot.userUid === user.platformAuthorId;
              newComments.push({
                videoId: item.awemeId, cid: snapshot.cid, text: snapshot.text,
                userNickname: snapshot.userNickname, userUid: snapshot.userUid,
                createTime: snapshot.createTime, diggCount: 0,
                level: 1, rootId: null, parentId: null, replyToName: null,
                replyId: '0',
                isNew: isAuthor ? 0 : 1,
              });

              // 展开新根评论的子回复
              const replies = await this.expandRepliesForRoot(page, snapshot.cid);
              // ... (提取子回复并存入，逻辑同下 4c)
            }
          }
        }

        // 4c. 某条 root 的 replyCount 增加 → 局部展开
        for (const snapshot of currentSnapshots) {
          const lastCount = lastSnapshots.get(snapshot.cid);
          if (lastCount !== undefined && snapshot.replyCount > lastCount) {
            // 该 root 有新增回复
            const replies = await this.expandRepliesForRoot(page, snapshot.cid);
            if (replies.length > 0) {
              // 合并 API 数据获取 createTime
              const apiReplies = response.body.comments?.filter(
                (c: any) => c.reply_id !== '0' && c.reply_id === snapshot.cid
              ) || [];

              for (const reply of replies) {
                const apiMatch = apiReplies.find((c: any) => c.text?.includes(reply.text.slice(0, 10)));
                const createTime = apiMatch?.create_time || 0;
                const userUid = apiMatch?.user?.uid || '';
                const lastCheckTime = (await prisma.monitorStatus.findFirst({
                  where: { accountId: String(item._userId), platform: 'douyin' },
                }))?.lastCheckTime?.getTime() || 0;

                if (createTime * 1000 > lastCheckTime) {
                  const user = await db.getUserById(item._userId);
                  const isAuthor = user?.platformAuthorId && userUid === user.platformAuthorId;
                  newComments.push({
                    videoId: item.awemeId, cid: apiMatch?.cid || '', text: reply.text,
                    userNickname: apiMatch?.user?.nickname || '', userUid,
                    createTime, diggCount: apiMatch?.digg_count || 0,
                    level: 2, rootId: snapshot.cid, parentId: snapshot.cid,
                    replyToName: reply.replyToName, replyId: snapshot.cid,
                    isNew: isAuthor ? 0 : 1,
                  });
                }
              }
            }
          }
        }

        // 4d. 删除已不存在的 rootCids
        await db.deleteStaleRootCounts(item.awemeId, currentRootCids);

        // 4e. 更新快照
        await db.upsertRootCommentCounts(item.awemeId, currentSnapshots.map(s => ({
          cid: s.cid, replyCount: s.replyCount,
        })));

        // 4f. 新评论入库
        if (newComments.length > 0) {
          await db.upsertCommentTree(item.awemeId, newComments);
        }
        await db.updateCommentCount(item.awemeId, item.newCount);

        results.push({
          awemeId: item.awemeId, success: true,
          newComments: newComments.filter(c => c.isNew === 1).length,
          commentGroups: [],
        });
      }

      // 关闭抽屉
      await this.closeDrawer(page);
    } catch (err) {
      logger.error({ awemeId: item.awemeId, err: (err as Error).message }, 'processCommentsQueue item failed');
      results.push({ awemeId: item.awemeId, success: false, newComments: 0, error: (err as Error).message });
    }
  }

  return { results, riskDetected: false };
}
```

**注意**：上述代码是骨架，实际实现时需逐个细节展开。阶段 4b 和 4c 中需要添加 `item._userId` 字段以查询 lastCheckTime，需在 `CommentQueueItem` 类型中添加 `_userId?: number`。

- [ ] **步骤 2：在 processCommentsQueue 中实现 mergeApiDataToDOM 辅助函数**

```typescript
// 在 processCommentsQueue 内部或作为私有方法
private mergeApiDataToDOM(domNodes: CommentNode[], apiComments: any[]): CommentNode[] {
  for (const node of domNodes) {
    const apiMatch = apiComments.find((c: any) => c.cid === node.cid);
    if (apiMatch) {
      node.createTime = apiMatch.create_time;
      node.diggCount = apiMatch.digg_count || 0;
      node.userUid = apiMatch.user?.uid || '';
      node.userNickname = apiMatch.user?.nickname || node.userNickname;
    }
    if (node.subComments) {
      this.mergeApiDataToDOM(node.subComments, apiComments);
    }
  }
  return domNodes;
}
```

- [ ] **步骤 3：在 CommentQueueItem 类型中添加 _userId 字段**

```typescript
export interface CommentQueueItem {
  awemeId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
  _userId?: number;  // 内部用，携带 userId 以查询 lastCheckTime
}
```

- [ ] **步骤 4：重构 checkForUpdates 中已有的新视频入队逻辑**

在 `douyinCrawler.ts:981` 附近，修改 `commentsQueue.push` 为：

```typescript
commentsQueue.push({
  awemeId: video.aweme_id,
  description: video.description,
  oldCount: 0,
  newCount: video.comment_count,
  isFirstCrawl: true,
  _userId: userId,
});
```

同时，已有视频的入队（line 993+）也加上 `isFirstCrawl: false` 和 `_userId: userId`。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): refactor processCommentsQueue for incremental detection v2"
```

---

### 任务 7：快手 — 全量改造（同步抖音逻辑）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

快手的改造与抖音任务 3-6 对应，在同一个文件中完成所有变更。关键差异：

- 评论 API 为 `/rest/cp/comment/pc/list`，字段名为 `subCommentCount`（抖音是 `reply_comment_total`）
- 根评论过滤条件为 `replyTo === 0`（抖音是 `reply_id === '0'`）
- 作者 ID 来自 `userId` / `userName`（抖音是 `author.uid` / `author.nickname`）
- DOM 选择器不同：`data-comment-id` 而非 `data-cid`
- `KuaishouCommentQueueItem` 需新增 `isFirstCrawl` 和 `_userId` 字段

- [ ] **步骤 1：在 KuaishouVideoInfo 新增 author 字段**

```typescript
export interface VideoInfo {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, number>;
  authorUid?: string;       // 快手 userId
  authorNickname?: string;  // 快手 userName
}
```

- [ ] **步骤 2：fetchVideoListFromSource 提取 authorId**

在 `kuaishouCrawler.ts` 的 `fetchVideoListFromSource` 返回前（line 320+），映射 collectedItems 提取 author 字段。

- [ ] **步骤 3：checkForUpdates 提取 authorId 到 User 表**

与抖音任务 3 步骤 3 逻辑相同，提取 `video.userId` 和 `video.userName`。

- [ ] **步骤 4：实现 parseRootCommentSnapshots（快手版本）**

```typescript
private parseRootCommentSnapshots(body: any): RootCommentSnapshot[] {
  const comments: any[] = body?.data?.commentList || body?.data?.rootComments ||
                          body?.data?.commentInfoList || body?.data?.list || body?.data?.comments || [];
  return comments
    .filter((c: any) => c.replyTo === 0)
    .map((c: any) => ({
      cid: c.commentId || c.comment_id || '',
      text: c.content || c.text || '',
      replyCount: c.subCommentCount ?? 0,
      createTime: c.timestamp > 1e12 ? Math.floor(c.timestamp / 1000) : c.timestamp,
    }));
}
```

- [ ] **步骤 5：实现 expandRepliesForRoot（快手版本）**

与抖音版本相同逻辑，但 DOM 选择器替换为快手专用的（`data-comment-id`）。

- [ ] **步骤 6：重构 processCommentsQueue（快手版本）**

与抖音任务 6 逻辑一致，替换现有 `processCommentsQueue`（line 1035-1142）。

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): implement incremental detection v2 for kuaishou"
```

---

### 任务 8：通知过滤 — 排除作者评论

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:280-307`

- [ ] **步骤 1：在 sendMonitorNotification 调用前过滤作者评论**

在 `monitorService.ts` line 280-293 的 commentGroups 构建后，添加作者过滤。需要先查询 User 表的 `platformAuthorId`。

```typescript
// 查询平台作者 ID 以过滤作者自己的评论
const user = await prisma.user.findUnique({ where: { id: task.userId } });
const platformAuthorId = user?.platformAuthorId;

// 在 commentGroups flatMap 中过滤作者评论
const commentGroups = phase3Result?.results
  ?.filter((r: any) => r.success && r.commentGroups)
  ?.flatMap((r: any) =>
    r.commentGroups
      .map((g: any) => ({
        awemeId: r.awemeId,
        description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
        rootComment: g.rootComment,
        subReplies: g.subReplies.filter((s: any) => s.userUid !== platformAuthorId),
        newCids: new Set(
          g.newInGroup
            .filter((n: any) => n.userUid !== platformAuthorId)
            .map((n: any) => n.cid)
        ),
      }))
      .filter((g: any) => g.newCids.size > 0) // 过滤后无新增的组跳过
  ) || [];
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(notify): filter author comments from wechat notifications"
```

---

### 任务 9：前端 — isNew 高亮样式

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：在评论树渲染中添加 isNew 高亮**

在现有的评论树渲染代码中，为 `isNew === true` 的评论添加高亮样式。

在 `page.tsx` 中搜索 `comment-tree`、`comment-item` 或评论循环渲染代码，在每条评论的渲染容器中添加：

```tsx
{comment.isNew && (
  <span className="ml-1 px-1.5 py-0.5 text-xs rounded bg-orange-100 text-orange-600 font-medium">
    新
  </span>
)}
```

并且为评论项容器添加条件边框：

```tsx
className={`p-3 rounded ${comment.isNew ? 'border-l-3 border-orange-400 bg-orange-50/30' : ''}`}
```

- [ ] **步骤 2：验证前端构建**

```bash
cd /home/lrp/social_media_complete && docker compose build admin-dashboard 2>&1 | tail -3
```

预期：构建成功，无编译错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat(frontend): add isNew highlighting for new comments in comment tree"
```

---

### 任务 10：端到端验证

**文件：** 无需修改文件

- [ ] **步骤 1：重建所有容器**

```bash
cd /home/lrp/social_media_complete && docker compose build ts-api-gateway admin-dashboard && docker compose up -d
```

- [ ] **步骤 2：验证 API 正常运行**

```bash
sleep 10 && curl -s http://localhost:3001/api/v1/matrix/monitor/accounts | jq '.success'
```

预期：返回 `true`。

- [ ] **步骤 3：验证评论 API 返回 BigInt 正确序列化**

```bash
# 先获取一个 videoId
VIDEO_ID=$(curl -s http://localhost:3001/api/v1/matrix/monitor/videos | jq -r '.data[0].id')
curl -s "http://localhost:3001/api/v1/matrix/monitor/videos/$VIDEO_ID/comments" | jq '.success'
```

预期：返回 `true`，数据中包含 `isNew` 字段。

- [ ] **步骤 4：验证数据库迁移已应用**

```bash
docker compose exec postgres psql -U postgres -d social_media -c "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name LIKE 'platform_author%';"
```

预期：返回 `platform_author_id` 和 `platform_author_name` 两行。

- [ ] **步骤 5：Commit**

```bash
git add . && git commit -m "chore: end-to-end verification for comment incremental v2"
```
