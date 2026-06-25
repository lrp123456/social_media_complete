# 快手评论树采集修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复快手视频评论树（根评论）从未被采集的问题，根因为 Phase3 触发死锁

**架构：** 在共享触发函数 `getCommentCrawlDecision` 新增"根评论缺失重试"分支，配合重试上限（5次）与诊断日志。Phase1 批量查询根评论 count，Phase3 Simple 模式更新 retryCount。

**技术栈：** TypeScript, Prisma ORM, PostgreSQL, Jest

---

## 文件结构

### 核心文件

| 文件 | 职责 |
|------|------|
| `prisma/schema.prisma` | 数据库模型定义，新增 `rootCommentRetryCount` 字段 |
| `apps/ts-api-gateway/src/services/commentCrawlRules.ts` | Phase1 决策纯函数，新增 `root_comments_missing` 分支 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音爬虫 Phase1 传参改造 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫 Phase1 传参 + Phase3 retryCount 更新 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 小红书爬虫 Phase1 传参改造 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 腾讯爬虫 Phase1 传参改造 |

### 测试文件

| 文件 | 职责 |
|------|------|
| `apps/ts-api-gateway/src/services/commentCrawlRules.test.ts` | 决策函数单元测试（合并后唯一测试文件） |

---

## 任务 1：Prisma Schema 新增 rootCommentRetryCount 字段

**文件：**
- 修改：`prisma/schema.prisma:37-55`

- [ ] **步骤 1：修改 Video 模型添加新字段**

```prisma
model Video {
  id           String   @id
  userId       Int      @map("user_id")
  description  String   @default("")
  createTime   BigInt   @map("create_time")
  commentCount Int      @default(0) @map("comment_count")
  metrics      String   @default("{}") // JSON
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  isPinned     Boolean  @default(false) @map("is_pinned")
  rootCommentRetryCount Int @default(0) @map("root_comment_retry_count")  // 新增

  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  comments Comment[]

  @@index([userId], name: "idx_videos_user_id")
  @@index([userId, createTime(sort: Desc)], name: "idx_videos_user_id_create_time")
  @@map("videos")
}
```

- [ ] **步骤 2：重新生成 Prisma Client**

运行：`cd /home/lrp/social_media_complete && npx prisma generate`
预期：`✔ Generated Prisma Client` 成功

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add prisma/schema.prisma
git commit -m "feat(db): add rootCommentRetryCount to Video model"
```

---

## 任务 2：commentCrawlRules 新增 root_comments_missing 分支

**文件：**
- 修改：`apps/ts-api-gateway/src/services/commentCrawlRules.ts:1-45`

- [ ] **步骤 1：编写失败的测试**

在 `apps/ts-api-gateway/src/services/commentCrawlRules.test.ts` 中添加新测试用例：

```typescript
describe('root_comments_missing 新分支', () => {
  it('queues when comment count unchanged but root comments missing and retry under limit', () => {
    const result = getCommentCrawlDecision({
      currentCount: 56,
      storedCount: 56,
      rootCommentCount: 0,
      retryCount: 0,
    });
    expect(result).toEqual({
      shouldQueue: true,
      isFirstCrawl: false,
      reason: 'root_comments_missing',
    });
  });

  it('does not queue when retryCount reaches limit (gives up)', () => {
    const result = getCommentCrawlDecision({
      currentCount: 56,
      storedCount: 56,
      rootCommentCount: 0,
      retryCount: 5,
    });
    expect(result).toEqual({
      shouldQueue: false,
      isFirstCrawl: false,
      reason: 'comment_count_unchanged',
    });
  });

  it('does not trigger when rootCommentCount > 0', () => {
    const result = getCommentCrawlDecision({
      currentCount: 56,
      storedCount: 56,
      rootCommentCount: 10,
      retryCount: 0,
    });
    expect(result).toEqual({
      shouldQueue: false,
      isFirstCrawl: false,
      reason: 'comment_count_unchanged',
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest --testPathPattern=commentCrawlRules.test.ts --no-coverage`
预期：FAIL，报错 `root_comments_missing` 不在类型中

- [ ] **步骤 3：修改 commentCrawlRules.ts 实现新分支**

```typescript
export type CommentCrawlDecisionReason =
  | 'new_video_with_comments'
  | 'new_video_without_comments'
  | 'comment_count_changed'
  | 'comment_count_unchanged'
  | 'root_comments_missing';  // 新增

/** 根评论缺失重试上限 */
export const ROOT_COMMENT_RETRY_LIMIT = 5;

export interface CommentCrawlDecision {
  shouldQueue: boolean;
  isFirstCrawl: boolean;
  reason: CommentCrawlDecisionReason;
}

export function getCommentCrawlDecision(input: {
  currentCount: number;
  storedCount: number | null | undefined;
  rootCommentCount?: number;  // 新增
  retryCount?: number;        // 新增
}): CommentCrawlDecision {
  const currentCount = Number(input.currentCount || 0);
  const storedCount = input.storedCount;
  const rootCommentCount = input.rootCommentCount ?? 0;
  const retryCount = input.retryCount ?? 0;

  if (storedCount === null || storedCount === undefined) {
    if (currentCount > 0) {
      return { shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' };
    }
    return { shouldQueue: false, isFirstCrawl: false, reason: 'new_video_without_comments' };
  }

  if (currentCount !== storedCount) {
    return { shouldQueue: true, isFirstCrawl: false, reason: 'comment_count_changed' };
  }

  // 评论总数未变，但根评论缺失且未达重试上限 → 触发补采
  if (currentCount > 0 && rootCommentCount === 0 && retryCount < ROOT_COMMENT_RETRY_LIMIT) {
    return { shouldQueue: true, isFirstCrawl: false, reason: 'root_comments_missing' };
  }

  return { shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest --testPathPattern=commentCrawlRules.test.ts --no-coverage`
预期：PASS，所有测试通过

- [ ] **步骤 5：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/services/commentCrawlRules.ts apps/ts-api-gateway/src/services/commentCrawlRules.test.ts
git commit -m "feat(rules): add root_comments_missing decision branch"
```

---

## 任务 3：抖音爬虫 Phase1 传参改造

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1453-1495`

- [ ] **步骤 1：在 Phase1 循环前添加批量查询 rootCommentCount**

在 `const dbVideos = await db.getVideosByUserId(userId);` 之后添加：

```typescript
const dbVideos = await db.getVideosByUserId(userId);

// 批量查询根评论 count（level=1），用于判断 root_comments_missing
let rootCountMap = new Map<string, number>();
try {
  const rootCounts = await prisma.comment.groupBy({
    by: ['videoId'],
    where: { videoId: { in: dbVideos.map(v => v.id) }, level: 1 },
    _count: { id: true },
  });
  rootCountMap = new Map(rootCounts.map(r => [r.videoId, r._count.id]));
} catch (err) {
  logger.warn({ err: (err as Error).message }, '[Phase1] Failed to batch query root comment counts, defaulting to 0');
}
```

- [ ] **步骤 2：修改 getCommentCrawlDecision 调用传入新参数**

```typescript
for (const video of videos) {
  const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
  const decision = getCommentCrawlDecision({
    currentCount: video.comment_count,
    storedCount: dbVideo?.commentCount,
    rootCommentCount: dbVideo ? (rootCountMap.get(dbVideo.id) ?? 0) : 0,  // 新增
    retryCount: dbVideo?.rootCommentRetryCount ?? 0,  // 新增
  });
  // ... 后续逻辑不变
}
```

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): pass rootCommentCount to decision function"
```

---

## 任务 4：快手爬虫 Phase1 传参改造

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1295-1335`

- [ ] **步骤 1：在 Phase1 循环前添加批量查询 rootCommentCount**

在 `const dbVideos = await db.getVideosByUserId(userId);` 之后添加：

```typescript
const dbVideos = await db.getVideosByUserId(userId);

// 批量查询根评论 count（level=1），用于判断 root_comments_missing
let rootCountMap = new Map<string, number>();
try {
  const rootCounts = await prisma.comment.groupBy({
    by: ['videoId'],
    where: { videoId: { in: dbVideos.map(v => v.id) }, level: 1 },
    _count: { id: true },
  });
  rootCountMap = new Map(rootCounts.map(r => [r.videoId, r._count.id]));
} catch (err) {
  logger.warn({ err: (err as Error).message }, '[Phase1] Failed to batch query root comment counts, defaulting to 0');
}
```

- [ ] **步骤 2：修改 getCommentCrawlDecision 调用传入新参数**

```typescript
for (const video of videos) {
  const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
  const decision = getCommentCrawlDecision({
    currentCount: video.comment_count,
    storedCount: dbVideo?.commentCount,
    rootCommentCount: dbVideo ? (rootCountMap.get(dbVideo.id) ?? 0) : 0,  // 新增
    retryCount: dbVideo?.rootCommentRetryCount ?? 0,  // 新增
  });
  // ... 后续逻辑不变
}
```

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): pass rootCommentCount to decision function"
```

---

## 任务 5：小红书爬虫 Phase1 传参改造

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:662-711`

- [ ] **步骤 1：在 Phase1 循环前添加批量查询 rootCommentCount**

在 `const dbVideos = await db.getVideosByUserId(userId);` 之后添加：

```typescript
const dbVideos = await db.getVideosByUserId(userId);

// 批量查询根评论 count（level=1），用于判断 root_comments_missing
let rootCountMap = new Map<string, number>();
try {
  const rootCounts = await prisma.comment.groupBy({
    by: ['videoId'],
    where: { videoId: { in: dbVideos.map(v => v.id) }, level: 1 },
    _count: { id: true },
  });
  rootCountMap = new Map(rootCounts.map(r => [r.videoId, r._count.id]));
} catch (err) {
  logger.warn({ err: (err as Error).message }, '[XHS-Light] Failed to batch query root comment counts, defaulting to 0');
}
```

- [ ] **步骤 2：修改 getCommentCrawlDecision 调用传入新参数**

```typescript
const decision = getCommentCrawlDecision({
  currentCount: video.comment_count,
  storedCount: dbVideo.commentCount,
  rootCommentCount: rootCountMap.get(dbVideo.id) ?? 0,  // 新增
  retryCount: dbVideo.rootCommentRetryCount ?? 0,  // 新增
});
```

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xiaohongshu): pass rootCommentCount to decision function"
```

---

## 任务 6：腾讯爬虫 Phase1 传参改造

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:925-963`

- [ ] **步骤 1：在 Phase1 循环前添加批量查询 rootCommentCount**

在 `const dbVideos = await db.getVideosByUserId(userId);` 之后添加：

```typescript
const dbVideos = await db.getVideosByUserId(userId);

// 批量查询根评论 count（level=1），用于判断 root_comments_missing
let rootCountMap = new Map<string, number>();
try {
  const rootCounts = await prisma.comment.groupBy({
    by: ['videoId'],
    where: { videoId: { in: dbVideos.map(v => v.id) }, level: 1 },
    _count: { id: true },
  });
  rootCountMap = new Map(rootCounts.map(r => [r.videoId, r._count.id]));
} catch (err) {
  logger.warn({ err: (err as Error).message }, '[Phase1] Failed to batch query root comment counts, defaulting to 0');
}
```

- [ ] **步骤 2：修改 getCommentCrawlDecision 调用传入新参数**

```typescript
for (const video of filteredVideos) {
  const encodedId = video.exportId.replace(/\//g, '_');
  const dbVideo = dbVideos.find(v => v.id === encodedId);
  const newCount = video.commentCount ?? 0;
  const decision = getCommentCrawlDecision({
    currentCount: newCount,
    storedCount: dbVideo?.commentCount,
    rootCommentCount: dbVideo ? (rootCountMap.get(dbVideo.id) ?? 0) : 0,  // 新增
    retryCount: dbVideo?.rootCommentRetryCount ?? 0,  // 新增
  });
  // ... 后续逻辑不变
}
```

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): pass rootCommentCount to decision function"
```

---

## 任务 7：快手 Phase3 Simple 更新 retryCount

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:3194-3266`

- [ ] **步骤 1：修复 timestamp 毫秒归一化**

在存储评论时，将 `create_time: comment.timestamp || 0` 改为：

```typescript
// timestamp 归一化：>1e12 视为毫秒，转换为秒
const normalizedTime = comment.timestamp > 1e12 ? Math.floor(comment.timestamp / 1000) : (comment.timestamp || 0);
await db.upsertComment(item.awemeId, {
  cid: String(comment.commentId),
  text: comment.content || '',
  user_nickname: comment.authorName || '',
  user_uid: String(comment.authorId) || '',
  digg_count: comment.likedCount || 0,
  create_time: normalizedTime,  // 使用归一化后的时间戳
  reply_id: '0',
});
```

- [ ] **步骤 2：采到根评论时重置 retryCount**

在 `if (commentsToStore.length > 0)` 分支内，存储评论后添加：

```typescript
// 采到根评论，重置 retryCount
await prisma.video.update({
  where: { id: item.awemeId },
  data: { rootCommentRetryCount: 0 },
});
logger.info({ awemeId: item.awemeId }, '[Simple] Root comment retry count reset to 0');
```

- [ ] **步骤 3：采空时 retryCount +1**

在 `else` 分支（`commentsToStore.length === 0`）添加：

```typescript
// 采空，retryCount +1
await prisma.video.update({
  where: { id: item.awemeId },
  data: { rootCommentRetryCount: { increment: 1 } },
});
logger.info({ awemeId: item.awemeId }, '[Simple] Root comment retry count incremented');
```

- [ ] **步骤 4：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): update retryCount in Phase3 Simple mode"
```

---

## 任务 8：合并测试文件并扩展测试用例

**文件：**
- 删除：`apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts`
- 修改：`apps/ts-api-gateway/src/services/commentCrawlRules.test.ts`

- [ ] **步骤 1：删除重复的测试文件**

```bash
rm /home/lrp/social_media_complete/apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts
```

- [ ] **步骤 2：更新现有测试文件，添加完整测试用例**

```typescript
import {
  getCommentCrawlDecision,
  getRootCidSetForIncremental,
  shouldCompareReplyCounts,
  truncateToNewest,
  ROOT_COMMENT_RETRY_LIMIT,
} from './commentCrawlRules';

describe('getCommentCrawlDecision', () => {
  describe('原有 4 种 reason（回归测试）', () => {
    it('queues a new video with comments as first crawl', () => {
      expect(getCommentCrawlDecision({ currentCount: 3, storedCount: null })).toEqual({
        shouldQueue: true,
        isFirstCrawl: true,
        reason: 'new_video_with_comments',
      });
    });

    it('does not queue a new video with zero comments', () => {
      expect(getCommentCrawlDecision({ currentCount: 0, storedCount: null })).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'new_video_without_comments',
      });
    });

    it('queues an existing video when comment count increases', () => {
      expect(getCommentCrawlDecision({ currentCount: 8, storedCount: 5 })).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'comment_count_changed',
      });
    });

    it('queues an existing video when comment count decreases', () => {
      expect(getCommentCrawlDecision({ currentCount: 2, storedCount: 5 })).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'comment_count_changed',
      });
    });

    it('does not queue an existing video when comment count is unchanged', () => {
      expect(getCommentCrawlDecision({ currentCount: 5, storedCount: 5, rootCommentCount: 5 })).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });
  });

  describe('root_comments_missing 新分支', () => {
    it('queues when comment count unchanged but root comments missing and retry under limit', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });

    it('queues when retryCount is below limit', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: ROOT_COMMENT_RETRY_LIMIT - 1,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });

    it('does not queue when retryCount reaches limit (gives up)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: ROOT_COMMENT_RETRY_LIMIT,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger when rootCommentCount > 0 (normal unchanged)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 10,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger when currentCount is 0', () => {
      const result = getCommentCrawlDecision({
        currentCount: 0,
        storedCount: 0,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger for new video (storedCount is null)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: null,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: true,
        reason: 'new_video_with_comments',
      });
    });

    it('defaults rootCommentCount and retryCount to 0 when undefined', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });
  });
});

describe('truncateToNewest', () => {
  it('returns the newest N items sorted by create_time desc', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
      { id: '3', create_time: 200 },
      { id: '4', create_time: 500 },
      { id: '5', create_time: 400 },
    ];
    const result = truncateToNewest(items, 3);
    expect(result.map((i) => i.id)).toEqual(['4', '5', '2']);
  });

  it('returns all items (sorted) when fewer than limit', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
    ];
    const result = truncateToNewest(items, 20);
    expect(result.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('treats missing create_time as 0 (sorted to end) without throwing', () => {
    const items: Array<{ id: string; create_time?: number }> = [
      { id: '1', create_time: 100 },
      { id: '2' },
      { id: '3', create_time: 50 },
    ];
    const result = truncateToNewest(items, 20);
    expect(result.map((i) => i.id)).toEqual(['1', '3', '2']);
  });

  it('returns empty array for empty input', () => {
    expect(truncateToNewest([], 20)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
    ];
    const snapshot = items.map((i) => ({ ...i }));
    truncateToNewest(items, 1);
    expect(items).toEqual(snapshot);
  });
});

describe('snapshot fallback helpers', () => {
  it('uses last snapshot cids when snapshots exist', () => {
    const lastSnapshots = new Map<string, number>([
      ['root-a', 0],
      ['root-b', 2],
    ]);
    const dbAllCids = new Set<string>(['root-a', 'root-c']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }, { cid: 'root-c' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a', 'root-b']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(true);
  });

  it('falls back to local comment cids when snapshots are missing', () => {
    const lastSnapshots = new Map<string, number>();
    const dbAllCids = new Set<string>(['root-a', 'old-sub-reply']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(false);
  });
});
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest --testPathPattern=commentCrawlRules.test.ts --no-coverage`
预期：PASS，所有 19 个测试通过

- [ ] **步骤 4：Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/services/commentCrawlRules.test.ts
git rm apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts
git commit -m "test(rules): consolidate and extend commentCrawlRules tests"
```

---

## 任务 9：运行 Prisma Migration

**文件：**
- 创建：`prisma/migrations/YYYYMMDDHHMMSS_add_root_comment_retry_count/`

- [ ] **步骤 1：生成 migration**

运行：`cd /home/lrp/social_media_complete && npx prisma migrate dev --name add_root_comment_retry_count`
预期：migration 生成成功

- [ ] **步骤 2：验证 migration 文件**

检查 `prisma/migrations/` 目录下新生成的 migration 文件，确认包含：
```sql
ALTER TABLE "videos" ADD COLUMN "root_comment_retry_count" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **步骤 3：Commit**

```bash
cd /home/lrp/social_media_complete
git add prisma/migrations/
git commit -m "feat(db): add rootCommentRetryCount migration"
```

---

## 任务 10：最终验证

- [ ] **步骤 1：运行所有单元测试**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest --no-coverage`
预期：所有测试通过

- [ ] **步骤 2：TypeScript 编译检查**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit`
预期：无编译错误（已存在的错误除外）

- [ ] **步骤 3：Commit 最终状态**

```bash
cd /home/lrp/social_media_complete
git add -A
git commit -m "chore: final verification for kuaishou comment tree fix"
```

---

## 自检清单

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| prisma schema 新增 rootCommentRetryCount | 任务 1 |
| getCommentCrawlDecision 新增 root_comments_missing 分支 | 任务 2 |
| 抖音 Phase1 传参改造 | 任务 3 |
| 快手 Phase1 传参改造 | 任务 4 |
| 小红书 Phase1 传参改造 | 任务 5 |
| 腾讯 Phase1 传参改造 | 任务 6 |
| 快手 Phase3 Simple 更新 retryCount | 任务 7 |
| 测试文件合并与扩展 | 任务 8 |
| Prisma migration | 任务 9 |
| 最终验证 | 任务 10 |

### 占位符扫描

✅ 无 "待定"、"TODO"、"后续实现" 等占位符
✅ 所有代码步骤都包含完整代码块
✅ 所有测试都有具体断言

### 类型一致性

✅ `rootCommentRetryCount` 在所有文件中拼写一致
✅ `ROOT_COMMENT_RETRY_LIMIT` 常量在所有引用中一致
✅ `CommentCrawlDecisionReason` 类型在所有文件中一致

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-25-kuaishou-comment-tree-crawl-fix.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
