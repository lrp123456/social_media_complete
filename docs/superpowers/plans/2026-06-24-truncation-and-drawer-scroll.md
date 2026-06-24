# 视频采集截断与抽屉滚动加载修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复抖音 Phase1 超额采集未截断、Phase3 抽屉滚动加载过早门控两个 bug，并把"截断前显式按时间倒序"统一到快手、小红书、腾讯。

**Architecture:** 新增一个纯函数 `truncateToNewest` 在 `commentCrawlRules.ts`，四家爬虫的 Phase1 截断都改为调用它（抖音额外在 `checkForUpdates` 内补截断）；抖音 `findAndClickVideoInDrawer` 删除 `没有更多视频` 过早门控，改为"滚动后真正耗尽判定"循环。纯函数走 TDD 单测，爬虫改动走构建+静态验证。

**Tech Stack:** TypeScript、Jest/ts-jest、Puppeteer/CDP（HumanActions）。

---

## File Structure

- **Create** `apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts` —— `truncateToNewest` 单测（也顺带覆盖既有 `getCommentCrawlDecision`）。
- **Modify** `apps/ts-api-gateway/src/services/commentCrawlRules.ts` —— 新增 `truncateToNewest` 纯函数。
- **Modify** `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` —— Phase1 截断 + 抽屉门控修复。
- **Modify** `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` —— 截断前显式倒序。
- **Modify** `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` —— 截断前显式倒序。
- **Modify** `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` —— 截断前显式倒序。

`truncateToNewest` 是唯一可单测的逻辑核心；爬虫改动是对该函数的调用 + 抽屉控制流重写。

---

## Task 1: `truncateToNewest` 纯函数 + 单测（TDD）

**Files:**
- Create: `apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts`
- Modify: `apps/ts-api-gateway/src/services/commentCrawlRules.ts`

- [ ] **Step 1: 写失败的单测**

创建 `apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts`：

```ts
import { truncateToNewest, getCommentCrawlDecision } from '../commentCrawlRules';

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

describe('getCommentCrawlDecision (regression)', () => {
  it('new video with comments queues first crawl', () => {
    const d = getCommentCrawlDecision({ currentCount: 5, storedCount: undefined });
    expect(d).toEqual({ shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' });
  });

  it('existing video unchanged count does not queue', () => {
    const d = getCommentCrawlDecision({ currentCount: 5, storedCount: 5 });
    expect(d).toEqual({ shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway exec jest src/services/__tests__/commentCrawlRules.test.ts`
Expected: FAIL —— `truncateToNewest is not a function`（尚未导出）。

- [ ] **Step 3: 实现 `truncateToNewest`**

在 `apps/ts-api-gateway/src/services/commentCrawlRules.ts` 末尾追加：

```ts
/**
 * 按 create_time 倒序取最新 limit 条。
 * create_time 缺失按 0 处理（排到末尾），不抛异常。不修改入参数组。
 */
export function truncateToNewest<T extends { create_time?: number }>(
  items: T[],
  limit: number,
): T[] {
  return [...items]
    .sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0))
    .slice(0, limit);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway exec jest src/services/__tests__/commentCrawlRules.test.ts`
Expected: PASS（5 个 truncateToNewest + 2 个 regression 全绿）。

- [ ] **Step 5: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/services/commentCrawlRules.ts apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts
git commit -m "feat: add truncateToNewest helper with tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 抖音 Phase1 截断

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:12`（import）
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1437`（`checkForUpdates` 截断）

- [ ] **Step 1: 扩展 import**

把 `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:12` 的：

```ts
import { getCommentCrawlDecision, getRootCidSetForIncremental, shouldCompareReplyCounts } from '../services/commentCrawlRules';
```

改为：

```ts
import { getCommentCrawlDecision, getRootCidSetForIncremental, shouldCompareReplyCounts, truncateToNewest } from '../services/commentCrawlRules';
```

- [ ] **Step 2: 在抓取后插入截断**

把 `douyinCrawler.ts:1437` 的：

```ts
    const videos = await this.fetchVideoListFromSource(page, source);
```

改为：

```ts
    let videos = await this.fetchVideoListFromSource(page, source);
    const fetchedCount = videos.length;
    videos = truncateToNewest(videos, this.maxMonitorVideos);
    logger.info({ userId, fetched: fetchedCount, monitored: videos.length, cap: this.maxMonitorVideos }, '[Phase1] Truncated to newest N videos');
```

说明：`let` 原地复用 `videos`，下游入队循环（1487 行）与 `reconcileVideosForUser`（1573 行）自动基于截断后的列表。1439 行起的诊断日志 `videoCount: videos.length` 会自然反映截断后的 20 条，无需改动。

- [ ] **Step 3: 构建验证**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过，无 TS 错误（`let videos` 重新赋值类型一致；`truncateToNewest` 已导出）。

- [ ] **Step 4: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyin): truncate Phase1 video list to newest maxMonitorVideos

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 抖音抽屉滚动加载门控修复

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:2825-2879`（`findAndClickVideoInDrawer`）

- [ ] **Step 1: 删除过早门控，改为固定 maxScrolls**

把 `douyinCrawler.ts:2825-2838` 的：

```ts
    // 检查"没有更多视频"标记（避免无意义滚动）
    const noMoreVideo = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="loading"]');
      for (const el of els) {
        if (el.textContent?.includes('没有更多视频')) return true;
      }
      return false;
    }).catch(() => false);

    if (noMoreVideo) {
      logger.info('[Drawer] 抽屉已无更多视频，跳过滚动');
    }

    const maxScrolls = noMoreVideo ? 0 : MAX_SCROLL_ATTEMPTS_DRAWER;
```

改为：

```ts
    const maxScrolls = MAX_SCROLL_ATTEMPTS_DRAWER;
```

- [ ] **Step 2: 替换滚动循环为"滚动后真正耗尽判定"**

把 `douyinCrawler.ts:2840` 起的整段 for 循环（从 `for (let scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {` 到对应的 `return false;` 结束，约 2840–2882 行）替换为：

```ts
    let lastContainerCount = -1;
    let noGrowthRounds = 0;

    for (let scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      const containerSelector = getSelector('drawer.video-item').css || '[class*="douyin-creator-interactive-list-items"] > div';
      const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
      const count = containerElements?.length ?? 0;

      if (containerElements && containerElements.length > 0) {
        logger.info({ count, scrollAttempt }, '[Drawer] Found video containers');

        for (const container of containerElements) {
          const containerText = container.text || '';

          if (!isDescriptionMatch(containerText, description)) continue;

          const clicked = await HumanActions.cdpClickNode(page, container.nodeId);
          if (clicked) {
            logger.info({ awemeId, matchType: 'description' }, '[Drawer] 匹配成功（描述前缀）');
            return true;
          }

          const reClicked = await this.tryClickMatchedContainer(page, description.toLowerCase(), description.toLowerCase().substring(0, 25));
          if (reClicked) return true;

          logger.warn({ awemeId }, '[Drawer] Match found but click failed — giving up');
          return false;
        }
      }

      if (scrollAttempt < maxScrolls) {
        logger.info({ scrollAttempt, containerCount: count }, '[Drawer] 未匹配，滚动加载更多');
        await this.scrollDrawerForMore(page, scrollAttempt);

        // count 为本次滚动前的容器数；滚动后可能触发新数据加载，
        // 但新数据要到下一轮 queryElementsWithInfo 才可见。
        // 因此需要 2 次连续无增长 + 哨兵确认，才判定真正耗尽。
        if (count === lastContainerCount) {
          noGrowthRounds++;
          const exhausted = await page.evaluate(() => {
            const els = document.querySelectorAll('[class*="loading"]');
            for (const el of els) {
              if (el.textContent?.includes('没有更多视频')) return true;
            }
            return false;
          }).catch(() => false);
          if (noGrowthRounds >= 2 && exhausted) {
            logger.info({ scrollAttempt, count }, '[Drawer] 滚动后无新视频且哨兵确认耗尽 — 停止');
            break;
          }
        } else {
          noGrowthRounds = 0;
        }
        lastContainerCount = count;
      }
    }

    logger.warn({ awemeId, maxScrolls }, '[Drawer] 滚动穷尽仍未匹配');
    return false;
```

注意：保留原有 `isDescriptionMatch`、`tryClickMatchedContainer`、`scrollDrawerForMore`、`HumanActions`、`getSelector` 的现有引用，不改动它们的实现。

- [ ] **Step 3: 静态验证 —— 确认门控已删除**

Run: `cd /home/lrp/social_media_complete && rg -n "noMoreVideo|maxScrolls = noMoreVideo" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
Expected: 无输出（`noMoreVideo` 变量与 `maxScrolls = noMoreVideo ? 0` 短路均已删除；仅 `没有更多视频` 字面量留在滚动后的 evaluate 中，这是预期的）。

- [ ] **Step 4: 构建验证**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过。

- [ ] **Step 5: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyin): scroll drawer until target found or truly exhausted

Remove premature 没有更多视频 gate that set maxScrolls=0 before any
scroll, so overflow videos in later cursor batches never loaded.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 快手截断前显式倒序

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:15`（import）
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:689`（slice）

- [ ] **Step 1: 扩展 import**

把 `kuaishouCrawler.ts:15` 的：

```ts
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

改为：

```ts
import { getCommentCrawlDecision, truncateToNewest } from '../services/commentCrawlRules';
```

- [ ] **Step 2: 截断改用纯函数**

把 `kuaishouCrawler.ts:689` 的：

```ts
    const sliced = filtered.slice(0, this.maxMonitorVideos);
```

改为：

```ts
    const sliced = truncateToNewest(filtered, this.maxMonitorVideos);
```

- [ ] **Step 3: 构建验证**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过。

- [ ] **Step 4: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "refactor(kuaishou): sort before truncating to newest maxMonitorVideos

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 小红书截断前显式倒序

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:6`（import）
- Modify: `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:261`（slice）

- [ ] **Step 1: 扩展 import**

把 `xiaohongshuCrawler.ts:6` 的：

```ts
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

改为：

```ts
import { getCommentCrawlDecision, truncateToNewest } from '../services/commentCrawlRules';
```

- [ ] **Step 2: 截断改用纯函数**

把 `xiaohongshuCrawler.ts:261` 的：

```ts
    const sliced = filteredItems.slice(0, this.maxMonitorVideos);
```

改为：

```ts
    const sliced = truncateToNewest(filteredItems, this.maxMonitorVideos);
```

- [ ] **Step 3: 构建验证**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过。

- [ ] **Step 4: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "refactor(xhs): sort before truncating to newest maxMonitorVideos

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 腾讯截断前显式倒序

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:9`（import）
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:942-953`（filter+slice）

- [ ] **Step 1: 扩展 import**

把 `tencentCrawler.ts:9` 的：

```ts
import { getCommentCrawlDecision } from '../services/commentCrawlRules';
```

改为：

```ts
import { getCommentCrawlDecision, truncateToNewest } from '../services/commentCrawlRules';
```

- [ ] **Step 2: 拆分 filter 与 truncate**

把 `tencentCrawler.ts:942-953` 的：

```ts
    // 先过滤非公开和评论已关闭的视频，再截断到 maxMonitorVideos
    const filteredVideos = enriched.filter(video => {
      if (video.commentClose === 1) {
        logger.debug({ exportId: video.exportId }, '[Phase1] Skipping video with comments closed');
        return false;
      }
      if (video.visibleType !== undefined && video.visibleType !== 1) {
        logger.info({ exportId: video.exportId, visibleType: video.visibleType }, '[Phase1] 过滤非公开视频（visibleType!=1）');
        return false;
      }
      return true;
    }).slice(0, this.maxMonitorVideos);
```

改为：

```ts
    // 先过滤非公开和评论已关闭的视频，再按 create_time 倒序截断到 maxMonitorVideos
    const publicVideos = enriched.filter(video => {
      if (video.commentClose === 1) {
        logger.debug({ exportId: video.exportId }, '[Phase1] Skipping video with comments closed');
        return false;
      }
      if (video.visibleType !== undefined && video.visibleType !== 1) {
        logger.info({ exportId: video.exportId, visibleType: video.visibleType }, '[Phase1] 过滤非公开视频（visibleType!=1）');
        return false;
      }
      return true;
    });
    const filteredVideos = truncateToNewest(publicVideos, this.maxMonitorVideos);
```

说明：下游 `for (const video of filteredVideos)` 不变，变量名 `filteredVideos` 保持一致。

- [ ] **Step 3: 构建验证**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过。

- [ ] **Step 4: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "refactor(tencent): sort before truncating to newest maxMonitorVideos

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 全量构建 + 测试 + 静态回归

**Files:** 无（仅验证）

- [ ] **Step 1: 运行全部单测**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway test`
Expected: 全绿，包含 Task 1 新增的 `commentCrawlRules.test.ts`。

- [ ] **Step 2: 全量构建**

Run: `cd /home/lrp/social_media_complete && pnpm --filter ts-api-gateway build`
Expected: 编译通过。

- [ ] **Step 3: 静态回归 —— 四家都已改用 truncateToNewest**

Run: `cd /home/lrp/social_media_complete && rg -n "truncateToNewest" apps/ts-api-gateway/src/crawlers`
Expected: 4 个文件各出现 import + 调用（抖音 import+调用、快手 import+调用、小红书 import+调用、腾讯 import+调用）。

- [ ] **Step 4: 静态回归 —— 抖音门控已清除**

Run: `cd /home/lrp/social_media_complete && rg -n "noMoreVideo" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
Expected: 无输出。

- [ ] **Step 5: 无需提交（验证步骤）**

若 Step 1–4 全通过，本任务完成，无需 git commit。

---

## Task 8: 手动运行时验证清单（交付给用户执行）

**Files:** 无（人工运行时验证）

- [ ] **Step 1: 重启服务**

Run: `cd /home/lrp/social_media_complete && docker compose restart sm-ts-api`
Expected: 容器正常启动。

- [ ] **Step 2: 触发抖音监控并观察截断日志**

在前端对 userId 21 触发监控，抓取日志：

Run: `docker logs --since 5m -f sm-ts-api 2>&1 | grep -E "Truncated to newest|Found videos with comment updates|Phase 3|Failed to click video|匹配成功|滚动加载更多"`

Expected:
- 出现 `[Phase1] Truncated to newest N videos` 且 `fetched` 24、`monitored` 20；
- `[Phase1] Found videos with comment updates` 的 `awemeIds` 只含最新 20 条内视频；
- 不再出现溢出旧视频（研发test/家居好物/法式，若已掉出最新 20）被当作 `new_video_with_comments` 入队。

- [ ] **Step 3: 观察抽屉滚动加载**

Expected: 日志出现 `[Drawer] 未匹配，滚动加载更多`，随后 `[Drawer] 匹配成功（描述前缀）`；不再出现 `Failed to click video`。Phase3 成功率从 0/3 提升。

- [ ] **Step 4: 第二次触发（无新增）验证不进入 Phase3**

再次触发监控（评论数无变化）：

Expected: 日志显示每个视频 `Comment count unchanged`，`commentsQueue` 为空，不进入 Phase 2/3。

- [ ] **Step 5: 新发布视频验证排序兜底**

发布一条新视频后触发监控：

Expected: 新视频排到最新 20 条最前，正常入队首爬；最旧 1 条掉出 20 被 `reconcileVideosForUser` 删除；新视频若落首屏外，抽屉滚动加载能找到并点击。

- [ ] **Step 6: 无需提交**

人工验证记录结果即可，无需 git commit。
