# Phase3 Trigger, Simple Mode, and Monitor Comment Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisites:** `pnpm` installed, Node.js ≥18, Prisma Client generated (`pnpm prisma generate`), Jest/ts-jest configured for `ts-api-gateway`. For Task 9: a running local environment with database access and platform API credentials.

**Parallelization:** Tasks 2, 3, 4, 5 modify independent crawler files and can be executed in parallel. Task 6 is also independent of Tasks 2-5. Task 7 depends on all of Tasks 2-5. Tasks 8-9 depend on everything.

**Goal:** Make Phase3 crawl entry depend only on platform comment-count changes, keep simple mode focused on new root comments with reply support for those roots, and make monitor account cards use `sum(Video.commentCount)`.

**Architecture:** Add small pure helper modules for crawl decisions, snapshot fallback, and monitor account stats so the risky behavior is unit-tested outside crawler/browser code. Then update each platform crawler and monitor orchestration to use those helpers, return simple-mode `commentGroups` through the existing unified queue notification path, and remove direct crawler-level notification calls. Keep deep mode as the only mode that collects sub-replies.

**Tech Stack:** TypeScript, Jest/ts-jest, Prisma Client, Express routes, existing crawler classes, BullMQ unified queue.

---

## Scope Check

The spec touches one subsystem: comment monitoring. It spans crawler Phase1 decisions, Phase3 result propagation, and monitor API aggregation, but these are tightly coupled around one behavior change and can be implemented in one plan.

## File Structure Map

- Create `apps/ts-api-gateway/src/services/commentCrawlRules.ts`  
  Pure helpers for Phase1 queue decisions and deep-mode snapshot fallback decisions.

- Create `apps/ts-api-gateway/src/services/commentCrawlRules.test.ts`  
  Jest tests for new-video, unchanged-video, increased/decreased comment counts, and snapshot fallback behavior.

- Create `apps/ts-api-gateway/src/routes/monitorAccountStats.ts`  
  Prisma-backed helper for `/matrix/monitor/accounts` account-level `totalComments` and `newComments` stats.

- Create `apps/ts-api-gateway/src/routes/monitorAccountStats.test.ts`  
  Jest tests proving account `totalComments` uses `video.aggregate(... _sum.commentCount ...)` while `newComments` still uses `comment.count(... isNew: 1 ...)`.

- Modify `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`  
  Use count-change helper, remove “comments table empty” Phase1 backfill trigger, stop converting missing snapshots into first crawl, remove simple-mode direct notification call.

- Modify `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`  
  Use count-change helper, remove “comments table empty” Phase1 backfill trigger, remove simple-mode direct notification call.

- Modify `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`  
  Use count-change helper, carry `isFirstCrawl` from Phase1 reason, remove `videoRootCommentCount.findFirst` first-crawl inference, remove simple-mode direct notification call.

- Modify `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`  
  Use count-change helper, change existing-video comparison from `>` to `!==`, remove simple-mode direct notification call.

- Modify `apps/ts-api-gateway/src/services/monitorService.ts`  
  Preserve simple-mode `commentGroups` returned by crawlers and expose them via `_phase3Result`; continue updating `Video.commentCount` after simple-mode Phase3.

- Modify `apps/ts-api-gateway/src/services/unifiedQueue.ts`  
  Map queue item descriptions by either `awemeId` or `exportId`, so XHS/Tencent simple-mode notification cards include descriptions.

- Modify `apps/ts-api-gateway/src/routes/matrix.ts`  
  Use `getMonitorAccountCommentStats()` for `/matrix/monitor/accounts`.

---

### Task 1: Add Tested Crawl Decision Helpers

**Files:**
- Create: `apps/ts-api-gateway/src/services/commentCrawlRules.ts`
- Create: `apps/ts-api-gateway/src/services/commentCrawlRules.test.ts`

- [ ] **Step 1: Write failing tests for Phase1 decisions and snapshot fallback**

Create `apps/ts-api-gateway/src/services/commentCrawlRules.test.ts`:

```typescript
import {
  getCommentCrawlDecision,
  getRootCidSetForIncremental,
  shouldCompareReplyCounts,
} from './commentCrawlRules';

describe('getCommentCrawlDecision', () => {
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
    expect(getCommentCrawlDecision({ currentCount: 5, storedCount: 5 })).toEqual({
      shouldQueue: false,
      isFirstCrawl: false,
      reason: 'comment_count_unchanged',
    });
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

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts --runInBand
```

Expected: FAIL because `./commentCrawlRules` does not exist.

- [ ] **Step 3: Implement the helper module**

Create `apps/ts-api-gateway/src/services/commentCrawlRules.ts`:

```typescript
export type CommentCrawlDecisionReason =
  | 'new_video_with_comments'
  | 'new_video_without_comments'
  | 'comment_count_changed'
  | 'comment_count_unchanged';

export interface CommentCrawlDecision {
  shouldQueue: boolean;
  isFirstCrawl: boolean;
  reason: CommentCrawlDecisionReason;
}

export function getCommentCrawlDecision(input: {
  currentCount: number;
  storedCount: number | null | undefined;
}): CommentCrawlDecision {
  const currentCount = Number(input.currentCount || 0);
  const storedCount = input.storedCount;

  if (storedCount === null || storedCount === undefined) {
    if (currentCount > 0) {
      return { shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' };
    }
    return { shouldQueue: false, isFirstCrawl: false, reason: 'new_video_without_comments' };
  }

  if (currentCount !== storedCount) {
    return { shouldQueue: true, isFirstCrawl: false, reason: 'comment_count_changed' };
  }

  return { shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' };
}

export function shouldCompareReplyCounts(lastSnapshots: Map<string, number>): boolean {
  return lastSnapshots.size > 0;
}

export function getRootCidSetForIncremental(
  lastSnapshots: Map<string, number>,
  dbAllCids: Set<string>,
  currentSnapshots: Array<{ cid: string }>,
): Set<string> {
  if (lastSnapshots.size > 0) {
    return new Set(lastSnapshots.keys());
  }

  const currentRootCids = new Set(currentSnapshots.map((s) => s.cid));
  return new Set([...dbAllCids].filter((cid) => currentRootCids.has(cid)));
}
```

- [ ] **Step 4: Run the helper tests again**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit helper module and tests**

```bash
git add apps/ts-api-gateway/src/services/commentCrawlRules.ts apps/ts-api-gateway/src/services/commentCrawlRules.test.ts
git commit -m "test: add comment crawl decision helpers"
```

---

### Task 2: Apply Phase1 Rules to Douyin and Preserve Simple Results *(parallel with Tasks 3-5)*

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **Step 1: Import the crawl decision helper in Douyin crawler**

In `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`, add this import near the other service imports:

```typescript
import { getCommentCrawlDecision, getRootCidSetForIncremental, shouldCompareReplyCounts } from '../services/commentCrawlRules';
```

- [ ] **Step 2: Replace Douyin Phase1 queue decision logic**

In `checkForUpdates`, replace the new-video and existing-video comment-count branching with this logic inside the `for (const video of videos)` loop:

```typescript
const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
const decision = getCommentCrawlDecision({
  currentCount: video.comment_count,
  storedCount: dbVideo?.commentCount,
});

if (!dbVideo) {
  const existingVideo = await prisma.video.findUnique({ where: { id: video.aweme_id } });
  if (existingVideo && existingVideo.userId !== userId) {
    logger.warn({
      awemeId: video.aweme_id,
      description: video.description?.slice(0, 30),
      ownerUserId: existingVideo.userId,
      currentUserId: userId,
    }, '[Phase1] Video already exists under another user — skipping to prevent cross-user data leak');
    continue;
  }

  if (decision.shouldQueue) {
    logger.info({
      awemeId: video.aweme_id,
      description: video.description,
      commentCount: video.comment_count,
      reason: decision.reason,
    }, '[Phase1] New video with comments — enqueuing for initial fetch');
    commentsQueue.push({
      awemeId: video.aweme_id,
      description: video.description,
      createTime: video.create_time,
      oldCount: 0,
      newCount: video.comment_count,
      isFirstCrawl: decision.isFirstCrawl,
      _userId: userId,
      isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,
    });
  } else {
    logger.info({ awemeId: video.aweme_id, description: video.description, reason: decision.reason }, '[Phase1] New video with no comments — skipping');
  }

  if (video.authorUid) {
    await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
  }
  continue;
}

if (decision.shouldQueue) {
  const diff = video.comment_count - dbVideo.commentCount;
  logger.info({
    awemeId: video.aweme_id,
    description: video.description,
    oldCount: dbVideo.commentCount,
    newCount: video.comment_count,
    diff,
    reason: decision.reason,
  }, '[Phase1] Comment count changed — enqueuing for comment fetch (NO click on list page)');

  commentsQueue.push({
    awemeId: video.aweme_id,
    description: video.description,
    createTime: video.create_time,
    oldCount: dbVideo.commentCount,
    newCount: video.comment_count,
    isFirstCrawl: decision.isFirstCrawl,
    _userId: userId,
    isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,
  });
} else {
  logger.info({
    awemeId: video.aweme_id,
    current: video.comment_count,
    stored: dbVideo.commentCount,
    reason: decision.reason,
  }, '[Phase1] Comment count unchanged');
}
```

Remove the old block that queried:

```typescript
await prisma.comment.count({ where: { videoId: video.aweme_id } })
```

and enqueued `[Phase1] Existing video without comments — enqueuing for initial fetch`.

- [ ] **Step 3: Make Douyin deep-mode snapshot absence a fallback, not first crawl**

In `processCommentsQueue`, replace:

```typescript
const isFirstCrawl = item.isFirstCrawl || lastSnapshots.size === 0;
```

with:

```typescript
const isFirstCrawl = item.isFirstCrawl;
const snapshotFallback = !isFirstCrawl && lastSnapshots.size === 0;
if (snapshotFallback) {
  logger.warn({ awemeId: item.awemeId }, '[Tree] Incremental crawl missing root snapshots — using DB cid fallback without switching to first crawl');
}
```

Then replace the existing `dbRootCids` assignment in the incremental branch:

```typescript
const dbRootCids = new Set(lastSnapshots.keys());
```

with:

```typescript
const dbRootCids = getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots);
```

Finally replace the reply-count loop condition:

```typescript
if (lastCount !== undefined && snapshot.replyCount > lastCount) {
```

with:

```typescript
if (shouldCompareReplyCounts(lastSnapshots) && lastCount !== undefined && snapshot.replyCount > lastCount) {
```

- [ ] **Step 4: Remove Douyin simple-mode direct notification call**

In `processCommentsQueueSimple`, delete this line:

```typescript
await this.notifyNewComments(item.awemeId, commentsToStore);
```

Then delete the private `notifyNewComments()` method from `douyinCrawler.ts`:

```typescript
private async notifyNewComments(awemeId: string, comments: any[]): Promise<void> {
  try {
    const { monitorService } = await import('../services/monitorService');
    await monitorService.notifyNewComments(awemeId, comments);
  } catch (err: any) {
    logger.error({ awemeId, err: err.message }, '[Simple] Failed to notify new comments');
  }
}
```

- [ ] **Step 5: Preserve Douyin simple-mode `commentGroups` in monitor service**

In `apps/ts-api-gateway/src/services/monitorService.ts`, in `runDouyinCheck`, replace:

```typescript
await dy.processCommentsQueueSimple(page, filteredQueue, maxRootComments);
// Phase3 结束后更新 Video.commentCount
for (const q of filteredQueue) {
  await db.updateCommentCount(q.awemeId, q.newCount);
}
phase3Result = { results: filteredQueue.map(q => ({ awemeId: q.awemeId, success: true, error: undefined })), riskDetected: false };
```

with:

```typescript
const simpleResult = await dy.processCommentsQueueSimple(page, filteredQueue, maxRootComments);
// Phase3 结束后更新 Video.commentCount
for (const q of filteredQueue) {
  await db.updateCommentCount(q.awemeId, q.newCount);
}
phase3Result = { ...simpleResult, riskDetected: false };
```

- [ ] **Step 6: Run focused tests and TypeScript build**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts --runInBand
pnpm --filter ts-api-gateway build
```

Expected: test PASS and build exits with code 0.

- [ ] **Step 7: Commit Douyin changes**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix(douyin): gate phase3 on comment count changes"
```

---

### Task 3: Apply Phase1 Rules to Kuaishou and Preserve Simple Results *(parallel with Tasks 2, 4, 5)*

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **Step 1: Import the crawl decision helper in Kuaishou crawler**

Add near other imports in `kuaishouCrawler.ts`:

```typescript
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

- [ ] **Step 2: Replace Kuaishou Phase1 queue decision logic**

Inside the `for (const video of videos)` loop in `checkForUpdates`, use the same decision structure as Douyin, with Kuaishou field names:

```typescript
const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
const decision = getCommentCrawlDecision({
  currentCount: video.comment_count,
  storedCount: dbVideo?.commentCount,
});

if (!dbVideo) {
  const existingVideo = await prisma.video.findUnique({ where: { id: video.aweme_id } });
  if (existingVideo && existingVideo.userId !== userId) {
    logger.warn({
      awemeId: video.aweme_id,
      description: video.description?.slice(0, 30),
      ownerUserId: existingVideo.userId,
      currentUserId: userId,
    }, '[Phase1] Video already exists under another user — skipping to prevent cross-user data leak');
    continue;
  }

  if (decision.shouldQueue) {
    logger.info({
      awemeId: video.aweme_id,
      description: video.description,
      commentCount: video.comment_count,
      reason: decision.reason,
    }, '[Phase1] New kuaishou video with comments — enqueuing for initial fetch');
    commentsQueue.push({
      awemeId: video.aweme_id,
      description: video.description,
      createTime: video.create_time,
      oldCount: 0,
      newCount: video.comment_count,
      isFirstCrawl: decision.isFirstCrawl,
      _userId: userId,
      isPinned: video.isPinned || false,
    });
  } else {
    logger.info({ awemeId: video.aweme_id, description: video.description, reason: decision.reason }, '[Phase1] New kuaishou video with no comments — skipping');
  }

  if (video.authorUid) {
    await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
    logger.info({ userId, authorUid: video.authorUid }, '[Kuaishou Phase1] Synced platform author ID');
  }
  continue;
}

if (decision.shouldQueue) {
  const diff = video.comment_count - dbVideo.commentCount;
  logger.info({
    awemeId: video.aweme_id,
    description: video.description,
    oldCount: dbVideo.commentCount,
    newCount: video.comment_count,
    diff,
    reason: decision.reason,
  }, '[Phase1] Kuaishou comment count changed — enqueuing for comment fetch');

  commentsQueue.push({
    awemeId: video.aweme_id,
    description: video.description,
    createTime: video.create_time,
    oldCount: dbVideo.commentCount,
    newCount: video.comment_count,
    isFirstCrawl: decision.isFirstCrawl,
    _userId: userId,
    isPinned: video.isPinned || false,
  });
} else {
  logger.info({
    awemeId: video.aweme_id,
    current: video.comment_count,
    stored: dbVideo.commentCount,
    reason: decision.reason,
  }, '[Phase1] Kuaishou comment count unchanged');
}
```

Remove the old block that queried local `prisma.comment.count()` and logged `[Phase1] Existing kuaishou video without comments — enqueuing for initial fetch`.

- [ ] **Step 3: Remove Kuaishou simple-mode direct notification call**

In `processCommentsQueueSimple`, delete:

```typescript
await this.notifyNewComments(item.awemeId, commentsToStore);
```

Delete the private `notifyNewComments()` method at the bottom of `kuaishouCrawler.ts`.

- [ ] **Step 4: Preserve Kuaishou simple-mode `commentGroups` in monitor service**

In `runKuaishouCheck`, replace:

```typescript
await ks.processCommentsQueueSimple(page, filteredQueue, maxRootComments);
for (const q of filteredQueue) {
  await db.updateCommentCount(q.awemeId, q.newCount);
}
phase3Result = { results: filteredQueue.map(q => ({ awemeId: q.awemeId, success: true, error: undefined })), riskDetected: false };
```

with:

```typescript
const simpleResult = await ks.processCommentsQueueSimple(page, filteredQueue, maxRootComments);
for (const q of filteredQueue) {
  await db.updateCommentCount(q.awemeId, q.newCount);
}
phase3Result = { ...simpleResult, riskDetected: false };
```

- [ ] **Step 5: Run focused tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts kuaishouCrawler.test.ts --runInBand
pnpm --filter ts-api-gateway build
```

Expected: tests PASS and build exits with code 0.

- [ ] **Step 6: Commit Kuaishou changes**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix(kuaishou): gate phase3 on comment count changes"
```

---

### Task 4: Apply Rules to Xiaohongshu and Remove Snapshot-Based First-Crawl Inference *(parallel with Tasks 2, 3, 5)*

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts`
- Modify: `apps/ts-api-gateway/src/services/unifiedQueue.ts`

- [ ] **Step 1: Import the crawl decision helper in Xiaohongshu crawler**

Add near other imports in `xiaohongshuCrawler.ts`:

```typescript
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

- [ ] **Step 2: Carry `isFirstCrawl` in Xiaohongshu updated video entries**

Where `updatedVideos` is typed in `checkForUpdates`, change it to include `isFirstCrawl`:

```typescript
const updatedVideos: Array<{
  awemeId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
}> = [];
```

For the new-note branch, push:

```typescript
updatedVideos.push({
  awemeId: video.aweme_id,
  description: video.description,
  oldCount: 0,
  newCount: video.comment_count,
  isFirstCrawl: true,
});
```

For the existing-note changed branch, push:

```typescript
updatedVideos.push({
  awemeId: video.aweme_id,
  description: video.description,
  oldCount: dbVideo.commentCount,
  newCount: video.comment_count,
  isFirstCrawl: false,
});
```

- [ ] **Step 3: Replace Xiaohongshu `>` comparison with decision helper**

In the existing-note branch, replace:

```typescript
if (video.comment_count > dbVideo.commentCount) {
```

with:

```typescript
const decision = getCommentCrawlDecision({
  currentCount: video.comment_count,
  storedCount: dbVideo.commentCount,
});
if (decision.shouldQueue) {
```

Update the log message to include `reason: decision.reason` and use the text `[XHS-Light] Comment count changed — will notify (simple/deep mode)`.

- [ ] **Step 4: Remove Xiaohongshu snapshot lookup from queue construction**

Replace the current queue construction that calls `prisma.videoRootCommentCount.findFirst(...)` with:

```typescript
const commentsQueue: Array<{ exportId: string; description: string; oldCount: number; newCount: number; isFirstCrawl: boolean; isPinned: boolean }> = [];
for (const v of updatedVideos) {
  commentsQueue.push({
    exportId: v.awemeId,
    description: v.description,
    oldCount: v.oldCount,
    newCount: v.newCount,
    isFirstCrawl: v.isFirstCrawl,
    isPinned: awemeIdToIsPinned.get(v.awemeId) || false,
  });
  logger.info({ awemeId: v.awemeId, isFirstCrawl: v.isFirstCrawl }, '[XHS-Light] Queue item crawl mode from Phase1 decision');
}
```

- [ ] **Step 5: Remove Xiaohongshu simple-mode direct notification call**

In `processCommentsQueueSimple`, delete:

```typescript
await this.notifyNewComments(item.awemeId, commentsToStore);
```

Delete the private `notifyNewComments()` method from `xiaohongshuCrawler.ts`.

- [ ] **Step 6: Preserve Xiaohongshu simple-mode `commentGroups` in monitor service**

In `runXiaohongshuCheck`, replace:

```typescript
await xhs.processCommentsQueueSimple(page, xhsQueue, maxRootComments);
for (const q of filteredQueue) {
  await db.updateCommentCount(q.exportId, q.newCount);
}
phase3Result = { results: filteredQueue.map(q => ({ awemeId: q.exportId, success: true, error: undefined })) };
```

with:

```typescript
const simpleResult = await xhs.processCommentsQueueSimple(page, xhsQueue, maxRootComments);
for (const q of filteredQueue) {
  await db.updateCommentCount(q.exportId, q.newCount);
}
phase3Result = simpleResult;
```

- [ ] **Step 7: Make unified queue find descriptions by `awemeId` or `exportId`**

In `apps/ts-api-gateway/src/services/unifiedQueue.ts`, at **line 326** (just before `const commentGroups = phase3Result?.results`), add:

```typescript
const queueItemId = (q: any): string | undefined => q.awemeId ?? q.exportId;
```

Then at **line 354**, replace:

```typescript
description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
```

with:

```typescript
description: queue.find((q: any) => queueItemId(q) === r.awemeId)?.description || '',
```

**Why this is needed:** XHS and Tencent queue items use `exportId` instead of `awemeId`. Without this fix, their notification cards will have empty descriptions.

- [ ] **Step 8: Run focused tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts --runInBand
pnpm --filter ts-api-gateway build
```

Expected: test PASS and build exits with code 0.

- [ ] **Step 9: Commit Xiaohongshu changes**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "fix(xhs): derive first crawl from phase1 decision"
```

---

### Task 5: Apply Rules to Tencent and Preserve Simple Results *(parallel with Tasks 2-4)*

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **Step 1: Import the crawl decision helper in Tencent crawler**

Add near other imports in `tencentCrawler.ts`:

```typescript
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

- [ ] **Step 2: Replace Tencent existing-video `>` comparison**

In `checkForUpdates`, after `const newCount = video.commentCount ?? 0;`, add:

```typescript
const decision = getCommentCrawlDecision({
  currentCount: newCount,
  storedCount: dbVideo?.commentCount,
});
```

Keep the new-video branch behavior but use `decision.shouldQueue`:

```typescript
if (!dbVideo) {
  const existingVideo = await prisma.video.findUnique({ where: { id: video.exportId } });
  if (existingVideo && existingVideo.userId !== userId) {
    logger.warn({
      awemeId: video.exportId,
      ownerUserId: existingVideo.userId,
      currentUserId: userId,
    }, '[Phase1] Video already exists under another user — skipping to prevent cross-user data leak');
    continue;
  }

  if (decision.shouldQueue) {
    commentsQueue.push({
      exportId: video.exportId.replace(/\//g, '_'),
      description: video.desc?.description || '',
      createTime: video.createTime,
      oldCount: 0,
      newCount,
      isFirstCrawl: decision.isFirstCrawl,
      _userId: userId,
      isPinned: video.isPinned,
    });
  }
  continue;
}
```

Replace:

```typescript
if (newCount > dbVideo.commentCount) {
```

with:

```typescript
if (decision.shouldQueue) {
```

and keep the existing `commentsQueue.push(...)`, setting `isFirstCrawl: decision.isFirstCrawl`.

- [ ] **Step 3: Remove Tencent simple-mode direct notification call**

In `processCommentsQueueSimple`, delete:

```typescript
await this.notifyNewComments(item.exportId, commentsToStore);
```

Delete the private `notifyNewComments()` method from `tencentCrawler.ts`.

- [ ] **Step 4: Preserve Tencent simple-mode `commentGroups` in monitor service**

In `runTencentCheck`, replace the simple-mode block that discards the return value with:

```typescript
const simpleResult = await tc.processCommentsQueueSimple(page, filteredQueue, maxRootComments);
for (const q of filteredQueue) {
  await db.updateCommentCount(q.exportId, q.newCount);
}
phase3Result = simpleResult.results;
```

If the surrounding code expects `phase3Result` to be an array for Tencent, keep the final return shape as:

```typescript
_phase3Result: { results: phase3Result },
_queue: filteredQueue,
```

- [ ] **Step 5: Run focused tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- commentCrawlRules.test.ts --runInBand
pnpm --filter ts-api-gateway build
```

Expected: test PASS and build exits with code 0.

- [ ] **Step 6: Commit Tencent changes**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix(tencent): gate phase3 on comment count changes"
```

---

### Task 6: Add Tested Monitor Account Stats Helper and Use It in Matrix Route *(independent of Tasks 2-5, can run in parallel)*

**Files:**
- Create: `apps/ts-api-gateway/src/routes/monitorAccountStats.ts`
- Create: `apps/ts-api-gateway/src/routes/monitorAccountStats.test.ts`
- Modify: `apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **Step 1: Write failing tests for account comment stats**

Create `apps/ts-api-gateway/src/routes/monitorAccountStats.test.ts`:

```typescript
import { getMonitorAccountCommentStats } from './monitorAccountStats';

describe('getMonitorAccountCommentStats', () => {
  it('uses Video.commentCount sum for totalComments and Comment.isNew for newComments', async () => {
    const prisma = {
      video: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { commentCount: 42 } }),
      },
      comment: {
        count: jest.fn().mockResolvedValue(3),
      },
    } as any;

    await expect(getMonitorAccountCommentStats(prisma, 7)).resolves.toEqual({
      totalComments: 42,
      newComments: 3,
    });

    expect(prisma.video.aggregate).toHaveBeenCalledWith({
      where: { userId: 7 },
      _sum: { commentCount: true },
    });
    expect(prisma.comment.count).toHaveBeenCalledWith({
      where: { video: { userId: 7 }, isNew: 1 },
    });
  });

  it('returns zero totalComments when aggregate sum is null', async () => {
    const prisma = {
      video: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { commentCount: null } }),
      },
      comment: {
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;

    await expect(getMonitorAccountCommentStats(prisma, 8)).resolves.toEqual({
      totalComments: 0,
      newComments: 0,
    });
  });
});
```

- [ ] **Step 2: Run the stats test to verify it fails**

Run:

```bash
pnpm --filter ts-api-gateway test -- monitorAccountStats.test.ts --runInBand
```

Expected: FAIL because `./monitorAccountStats` does not exist.

- [ ] **Step 3: Implement the stats helper**

Create `apps/ts-api-gateway/src/routes/monitorAccountStats.ts`:

```typescript
import type { PrismaClient } from '@prisma/client';

export async function getMonitorAccountCommentStats(
  prisma: PrismaClient,
  userId: number,
): Promise<{ totalComments: number; newComments: number }> {
  const [totalCommentSum, newComments] = await Promise.all([
    prisma.video.aggregate({
      where: { userId },
      _sum: { commentCount: true },
    }),
    prisma.comment.count({
      where: { video: { userId }, isNew: 1 },
    }),
  ]);

  return {
    totalComments: totalCommentSum._sum.commentCount ?? 0,
    newComments,
  };
}
```

- [ ] **Step 4: Use the helper in `/matrix/monitor/accounts`**

In `apps/ts-api-gateway/src/routes/matrix.ts`, add this import near the top:

```typescript
import { getMonitorAccountCommentStats } from './monitorAccountStats';
```

In the `/monitor/accounts` handler, replace:

```typescript
const [totalComments, newComments, lastMonitorTime] = await Promise.all([
  prisma.comment.count({ where: { video: { userId: user.id } } }),
  prisma.comment.count({ where: { video: { userId: user.id }, isNew: 1 } }),
  prisma.monitorStatus.findFirst({
    where: { accountId: String(user.id), platform: user.platform },
    select: { lastCheckTime: true },
  }),
]);
```

with:

```typescript
const [commentStats, lastMonitorTime] = await Promise.all([
  getMonitorAccountCommentStats(prisma, user.id),
  prisma.monitorStatus.findFirst({
    where: { accountId: String(user.id), platform: user.platform },
    select: { lastCheckTime: true },
  }),
]);
```

Then replace returned fields:

```typescript
totalComments,
newComments,
```

with:

```typescript
totalComments: commentStats.totalComments,
newComments: commentStats.newComments,
```

- [ ] **Step 5: Run stats tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- monitorAccountStats.test.ts --runInBand
pnpm --filter ts-api-gateway build
```

Expected: test PASS and build exits with code 0.

- [ ] **Step 6: Commit monitor stats changes**

```bash
git add apps/ts-api-gateway/src/routes/monitorAccountStats.ts apps/ts-api-gateway/src/routes/monitorAccountStats.test.ts apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "fix(matrix): use video comment totals for monitor accounts"
```

---

### Task 7: Verify Simple Mode Notification and AI Suggestion Flow

**Files:**
- Modify if build requires it: `apps/ts-api-gateway/src/services/unifiedQueue.ts`
- Modify if build requires it: `apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **Step 1: Confirm simple-mode result shape reaches unified queue**

Inspect the final `_phase3Result` for all four simple-mode branches. The result shape must satisfy this condition in `unifiedQueue.ts`:

```typescript
phase3Result?.results?.some((r: any) =>
  r.success && r.commentGroups && r.commentGroups.length > 0
)
```

Expected shapes:

```typescript
// Douyin/Kuaishou/XHS final _phase3Result
{ results: [{ awemeId: 'video-id', success: true, commentGroups: [...] }], riskDetected?: false }

// Tencent final _phase3Result
{ results: [{ awemeId: 'encoded-video-id', success: true, commentGroups: [...] }] }
```

- [ ] **Step 2: Confirm simple-mode groups contain only root comments**

For each `processCommentsQueueSimple`, ensure generated groups match:

```typescript
{
  rootComment: {
    cid,
    text,
    userNickname,
    userUid,
    createTime,
    diggCount,
    level: 1,
    replyId: '0',
    isAuthor: false,
    subComments: [],
    imageUrls,
  },
  subReplies: [],
  newInGroup: [{
    cid,
    text,
    userNickname,
    userUid,
    createTime,
    diggCount,
    level: 1,
    replyId: '0',
    isAuthor: false,
    subComments: [],
    imageUrls,
  }],
}
```

If any platform omits `level: 1`, `replyId: '0'`, or `subReplies: []`, add those fields exactly as shown.

- [ ] **Step 3: Confirm no crawler imports non-existent `monitorService.notifyNewComments`**

Run:

```bash
rg -n "monitorService\.notifyNewComments|private async notifyNewComments|await this\.notifyNewComments" apps/ts-api-gateway/src/crawlers
```

Expected: no output.

- [ ] **Step 4: Run full ts-api-gateway tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- --runInBand
pnpm --filter ts-api-gateway build
```

Expected: all tests PASS and build exits with code 0.

- [ ] **Step 5: Commit simple-mode flow cleanup if files changed**

If Step 1 or Step 2 required edits, commit them:

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "fix: route simple mode comments through unified notifications"
```

If no files changed, do not create an empty commit.

---

### Task 8: End-to-End Static Verification

**Files:**
- No source files expected unless verification finds a defect.

- [ ] **Step 1: Search for removed Phase3 triggers**

Run (use `grep -rn` if `rg` is not available):

```bash
rg -n "Existing .*without comments|existingComments|comment\.count\(\{ where: \{ videoId|videoRootCommentCount\.findFirst|lastSnapshots\.size === 0" apps/ts-api-gateway/src/crawlers apps/ts-api-gateway/src/services
```

Expected remaining output:

- `lastSnapshots.size === 0` may appear only in logging/fallback checks, not in `item.isFirstCrawl || lastSnapshots.size === 0`.
- No `Existing ... without comments — enqueuing` log remains.
- No Phase1 `prisma.comment.count({ where: { videoId ... } })` remains as a trigger.
- No XHS queue construction uses `videoRootCommentCount.findFirst` to decide `isFirstCrawl`.

- [ ] **Step 2: Search for old `>` comment-count triggers**

Run:

```bash
rg -n "comment_count > dbVideo\.commentCount|newCount > dbVideo\.commentCount|video\.comment_count > dbVideo\.commentCount" apps/ts-api-gateway/src/crawlers
```

Expected: no output for Phase1 queue decisions. If output remains in a non-Phase1 context, inspect it and confirm it is not a Phase3 entry trigger.

- [ ] **Step 3: Search for direct simple-mode notification calls**

Run:

```bash
rg -n "notifyNewComments\(" apps/ts-api-gateway/src/crawlers apps/ts-api-gateway/src/services/monitorService.ts
```

Expected: no crawler-level simple-mode calls. `sendMonitorNotification` and `generateSuggestionsForNewComments` remain in `monitorService.ts`.

- [ ] **Step 4: Run repository build for touched apps**

Run:

```bash
pnpm --filter ts-api-gateway test -- --runInBand
pnpm --filter ts-api-gateway build
```

Expected: all tests PASS and build exits with code 0.

- [ ] **Step 5: Commit verification fixes if any were needed**

If Step 1-4 required fixes, commit exact changed files:

```bash
git add apps/ts-api-gateway/src
git commit -m "fix: complete comment monitor verification cleanup"
```

If no fixes were needed, do not create an empty commit.

---

### Task 9: Manual Runtime Verification Checklist

**Files:**
- No code changes expected.

- [ ] **Step 1: Start or rebuild the app stack**

**Prerequisites:** Ensure database is running, Prisma Client is generated (`pnpm prisma generate`), and platform API credentials are configured in environment variables.

Use the project's normal local runtime. If Docker is used for this deployment, run:

```bash
pnpm build:ts
```

Expected: TypeScript build succeeds.

If the operator environment requires Docker rebuild, run the existing project command used by the team instead of inventing a new compose flow. If neither works, check `package.json` scripts or ask the team for the standard local dev command.

- [ ] **Step 2: Verify monitor account totals API**

Call the accounts endpoint in the running environment:

```bash
curl -s http://localhost:3001/api/v1/matrix/monitor/accounts
```

Expected: each account `totalComments` equals the sum of that account’s video `commentCount` values from:

```bash
curl -s http://localhost:3001/api/v1/matrix/monitor/accounts/<USER_ID>
```

- [ ] **Step 3: Verify unchanged existing video does not enter Phase3**

Trigger one monitor run for a user whose platform comment counts have not changed.

Expected logs include Phase1 “comment count unchanged” messages and do not include Phase2/Phase3 processing for that unchanged video.

- [ ] **Step 4: Verify new video with comments enters first crawl**

Use a monitored account with a new visible video where platform `comment_count > 0`.

Expected logs:

```text
reason: new_video_with_comments
isFirstCrawl: true
```

Expected result: root comments are stored and `commentGroups` reaches notification flow.

- [ ] **Step 5: Verify existing video count change enters incremental crawl**

Use a monitored video whose platform count changed from the stored `Video.commentCount`.

Expected logs:

```text
reason: comment_count_changed
isFirstCrawl: false
```

Expected result: `Video.commentCount` updates to the platform count.

- [ ] **Step 6: Verify simple mode root-comment notification and reply support**

Set one platform to simple mode and trigger a run with at least one new root comment.

Expected:

- New root comments are inserted with `level = 1` and `replyId = '0'`.
- Notification card title includes `（简单模式）`.
- Card offers AI generation/send actions for the root comment cid.
- `generateSuggestionsForNewComments()` runs without error.

- [ ] **Step 7: Verify simple mode does not notify for only sub-reply changes**

Use a case where `comment_count` changes but no new root comment appears within `maxRootComments`.

Expected:

- Phase3 may run because the count changed.
- `Video.commentCount` updates.
- `commentGroups` is empty.
- No “new root comment” notification is sent.

- [ ] **Step 8: Record verification results**

Add a short note to the task/PR summary with:

```text
Verified:
- monitor account totalComments uses sum(Video.commentCount)
- unchanged existing videos skip Phase3
- new videos with comments enter first crawl
- existing changed videos enter incremental crawl
- simple mode notifies only for new root comments
```

No commit is needed for this checklist unless runtime verification required code changes.

---

## Plan Self-Review

### Spec Coverage

- Phase3 trigger based only on new-video-with-comments or existing comment-count change: Tasks 1-5 and 8.
- Remove local comments table empty trigger: Tasks 2 and 3, verified in Task 8.
- Remove snapshot existence as first-crawl trigger: Tasks 4 and 5, verified in Task 8.
- Snapshot fallback behavior: Task 2 helper usage and tests.
- `!==` jitter accepted with idempotency: Tasks 1, 7, and 8.
- Simple mode root comments only, with AI/manual reply support for roots: Tasks 2-5 preserve `commentGroups`; Task 7 verifies result shape; Task 9 validates runtime behavior.
- No simple-mode sub-reply collection: Task 7 static check and Task 9 runtime check.
- Monitor account total comments use `sum(Video.commentCount)`: Task 6.
- XHS and Tencent platform-specific confirmation: Tasks 4 and 5.
- Repeated trigger idempotency: Tasks 7-9.

### Placeholder Scan

This plan contains concrete file paths, commands, expected outputs, and code snippets. It does not use deferred implementation placeholders.

### Type Consistency

- `getCommentCrawlDecision()` returns `{ shouldQueue, isFirstCrawl, reason }` and all crawler snippets use those exact names.
- Snapshot helpers use `Map<string, number>` for `lastSnapshots`, matching `db.getRootCommentCounts()`.
- Simple-mode `commentGroups` retains `rootComment`, `subReplies`, and `newInGroup`, matching `unifiedQueue.ts` expectations.
- XHS/Tencent queue ID compatibility is handled through `queueItemId(q) => q.awemeId ?? q.exportId`.
