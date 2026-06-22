# XHS 子评论采集修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复小红书评论树采集中子评论丢失的 7 个 bug，使预加载子评论、展开按钮点击、子评论 API 拦截和根评论关联全部正常工作。

**架构：** 仅修改 `xiaohongshuCrawler.ts` 一个文件中的 3 个方法：`buildCommentTree()`（字段名修复 + URL 参数提取）、`expandSubCommentsForRoots()`（选择器重写 + 响应等待）、`scrollLoadRootComments()`（原始数据返回 + 滚动耐心度提升）。

**技术栈：** TypeScript, Playwright (patchright), CDP, RequestInterceptor

---

## 文件结构

| 文件 | 修改内容 |
|------|---------|
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:810-980` | 3 个方法的修复 |

## 参考规范

`docs/superpowers/specs/2026-06-22-xhs-sub-comment-fix-design.md` — 包含完整的 API 响应结构、DOM 结构和每项修复的详细说明。

---

### 任务 1：buildCommentTree() — 预加载子评论提取 + sub/page 根评论关联（Bug 1 + Bug 6）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:908-980`

**上下文：** `buildCommentTree()` 从拦截器的两个 pattern 响应中构建评论树。根评论来自 `/comment/page`，子评论来自 `/comment/sub/page`。当前有两个 bug：(1) 预加载子评论检查 `item.comments` 但实际字段是 `item.sub_comments`；(2) sub/page 子评论使用 `sub.root_id` 但该字段不存在，需从请求 URL 的 `root_comment_id` 参数提取。

- [ ] **步骤 1：修改 buildCommentTree() 中预加载子评论的字段名**

在 `xiaohongshuCrawler.ts` 中，定位 `buildCommentTree()` 方法（约 L908-980）。找到根评论解析循环中检查预加载子评论的条件判断（约 L936）。

将：
```typescript
        if (item.comments && Array.isArray(item.comments)) {
          for (const sub of item.comments) {
```

改为：
```typescript
        if (item.sub_comments && Array.isArray(item.sub_comments)) {
          for (const sub of item.sub_comments) {
```

- [ ] **步骤 2：修改 buildCommentTree() 中 sub/page 子评论的根评论关联**

在同一个方法中，找到解析 `/comment/sub/page` 响应的循环（约 L957-977）。将整个 sub/page 解析块替换为从 URL 提取 `root_comment_id` 的版本。

将：
```typescript
    // 解析子评论 /comment/sub/page
    const subResponses = interceptor.getResponses('/api/sns/web/v2/comment/sub/page');
    for (const resp of subResponses) {
      const items = resp?.body?.data?.comments || resp?.body?.data?.items || [];
      for (const sub of items) {
        comments.push({
          cid: sub.id,
          text: sub.content,
          user_nickname: sub.user_info?.nickname || '',
          user_uid: sub.user_info?.user_id || '',
          digg_count: parseInt(sub.like_count || '0', 10),
          create_time: Math.floor((sub.create_time || 0) / 1000),
          reply_id: sub.target_comment?.id || sub.root_id || '0',
          rootId: sub.root_id || undefined,
          parentId: sub.target_comment?.id || sub.parent_id || undefined,
          level: 2,
          replyToName: sub.target_comment?.user_info?.nickname || '',
          is_author: sub.show_tags?.includes('is_author') || false,
        });
      }
    }
```

替换为：
```typescript
    // 解析子评论 /comment/sub/page
    const subResponses = interceptor.getResponses('/api/sns/web/v2/comment/sub/page');
    for (const resp of subResponses) {
      // 从请求 URL 提取 root_comment_id（响应体中无此字段）
      let rootCommentId: string | undefined;
      try {
        const url = new URL(resp.url);
        rootCommentId = url.searchParams.get('root_comment_id') || undefined;
      } catch {}

      const items = resp?.body?.data?.comments || [];
      for (const sub of items) {
        comments.push({
          cid: sub.id,
          text: sub.content,
          user_nickname: sub.user_info?.nickname || '',
          user_uid: sub.user_info?.user_id || '',
          digg_count: parseInt(sub.like_count || '0', 10),
          create_time: Math.floor((sub.create_time || 0) / 1000),
          reply_id: sub.target_comment?.id || rootCommentId || '0',
          rootId: rootCommentId,
          parentId: sub.target_comment?.id || undefined,
          level: 2,
          replyToName: sub.target_comment?.user_info?.nickname || '',
          is_author: sub.show_tags?.includes('is_author') || false,
        });
      }
    }
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "fix(xhs): fix pre-loaded sub_comments extraction and sub/page rootId association"
```

---

### 任务 2：expandSubCommentsForRoots() — 选择器重写 + 响应等待（Bug 3 + Bug 4 + Bug 5）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:864-906`

**上下文：** 当前 `expandSubCommentsForRoots()` 使用 `getByText('展开')` 和 `getByText('展开更多回复')` 定位展开按钮，但实际 DOM 中按钮是 `<div class="show-more">展开 N 条回复</div>`。按钮位于 `.parent-comment` 容器内（是根评论元素的兄弟节点），不在根评论元素内部。此外，点击后没有等待 `/comment/sub/page` API 响应。

**依赖：** 任务 1 已完成（`buildCommentTree()` 修复），但本任务的代码修改不依赖任务 1 的文件变更。

- [ ] **步骤 1：重写 expandSubCommentsForRoots() 方法**

在 `xiaohongshuCrawler.ts` 中，定位 `expandSubCommentsForRoots()` 方法（约 L864-906）。将整个方法替换为以下实现：

```typescript
  async expandSubCommentsForRoots(newPage: Page, rootComments: any[]): Promise<void> {
    logger.info({ totalRoots: rootComments.length }, '[XHS-Phase3] Expanding sub-comments');

    const interceptor = this.commentInterceptor as RequestInterceptor;
    const subPattern = '/api/sns/web/v2/comment/sub/page';

    for (const root of rootComments) {
      // 只处理 sub_comment_has_more=true 的根评论（预加载子评论已由 buildCommentTree 直接提取）
      const hasMoreSub = root.sub_comment_has_more === true;
      if (!hasMoreSub) continue;

      const rootCid = root.id;
      if (!rootCid) continue;

      logger.info({ rootCid, subCount: root.sub_comment_count }, '[XHS-Phase3] Expanding sub-comments for root');

      try {
        // 定位根评论容器
        const rootContainer = newPage.locator(`[id="comment-${rootCid}"]`).first();
        if (!(await rootContainer.isVisible().catch(() => false))) {
          logger.warn({ rootCid }, '[XHS-Phase3] Root comment container not visible, skipping');
          continue;
        }

        // 滚动到可见
        await rootContainer.scrollIntoViewIfNeeded();
        await HumanActions.wait(newPage, 500, 1000);

        // 通过 .parent-comment:has() 精确定位根评论的父容器，在其中查找 .show-more
        const parentComment = newPage.locator(`.parent-comment:has([id="comment-${rootCid}"])`).first();

        // 点击展开，最多 10 次分页
        for (let i = 0; i < 10; i++) {
          const showMoreBtn = parentComment.locator('.show-more').first();
          if (!(await showMoreBtn.isVisible().catch(() => false))) {
            break; // 没有更多展开按钮，子评论已全部加载
          }

          const prevSubRespCount = interceptor.getResponseCount(subPattern);
          await showMoreBtn.click();
          logger.info({ rootCid, iteration: i }, '[XHS-Phase3] Clicked .show-more');

          // 等待 /comment/sub/page 响应到达
          const gotNew = await interceptor.waitForNewResponse(subPattern, prevSubRespCount, 10000);
          if (!gotNew) {
            logger.warn({ rootCid, iteration: i }, '[XHS-Phase3] No sub/page response after click, stopping');
            break;
          }

          await HumanActions.wait(newPage, 1000, 2000);

          // 检查最新响应的 has_more
          const subResponses = interceptor.getResponses(subPattern);
          const lastSubResp = subResponses[subResponses.length - 1];
          const lastHasMore = lastSubResp?.hasMore;
          if (!lastHasMore) {
            break; // 没有更多子评论了
          }
        }
      } catch (err: any) {
        logger.warn({ rootCid, error: err.message }, '[XHS-Phase3] Failed to expand sub-comments');
      }
    }
  }
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "fix(xhs): rewrite expandSubCommentsForRoots with correct .show-more selector and response waiting"
```

---

### 任务 3：scrollLoadRootComments() — 原始数据返回 + 滚动耐心度（Bug 2 + Bug 7）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:810-862`

**上下文：** 当前 `scrollLoadRootComments()` 在 L861 返回 `interceptor.getCollectedItems(pattern)`，该方法内部调用 `parseVideoItem()` 仅保留 `aweme_id/description/create_time/comment_count/metrics`，丢弃了 `sub_comment_count/sub_comment_has_more/sub_comments` 等字段。这导致 `expandSubCommentsForRoots()` 收到的根评论对象缺少关键字段，无法判断哪些根评论需要展开子评论。

此外，`maxNoNewItems=3` 过于激进——对于图片较多的笔记，3 次滚动不足以触发懒加载，导致 `has_more=true` 时过早退出。

- [ ] **步骤 1：修改滚动循环中的耐心度逻辑**

在 `xiaohongshuCrawler.ts` 中，定位 `scrollLoadRootComments()` 方法（约 L810-862）。

将 L822 的固定 `maxNoNewItems`：
```typescript
    const maxNoNewItems = 3;
```

替换为动态值（移到循环内部，因为 `hasMore` 在循环中才能获取）：
```typescript
    // maxNoNewItems 在循环内根据 hasMore 动态设置
```

然后在循环体内（约 L834-845），替换停止条件逻辑：

将：
```typescript
      const responses = interceptor.getResponses(pattern);
      const lastResp = responses[responses.length - 1];
      const hasMore = lastResp?.hasMore;

      if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {
        if (!hasMore && items.length > 0) {
          logger.info({ totalItems: items.length }, '[XHS-Phase3] All root comments loaded');
        } else {
          logger.info({ noNewItemsStreak, totalItems: items.length }, '[XHS-Phase3] No new items streak limit reached');
        }
        break;
      }
```

替换为：
```typescript
      const responses = interceptor.getResponses(pattern);
      const lastResp = responses[responses.length - 1];
      const hasMore = lastResp?.hasMore;

      // Fix 7: hasMore=true 时增加耐心度（图片重的笔记需要更多滚动触发懒加载）
      const maxNoNewItems = hasMore ? 5 : 3;

      if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {
        if (!hasMore && items.length > 0) {
          logger.info({ totalItems: items.length }, '[XHS-Phase3] All root comments loaded');
        } else {
          logger.info({ noNewItemsStreak, totalItems: items.length, hasMore }, '[XHS-Phase3] No new items streak limit reached');
        }
        break;
      }

      // Fix 7: 连续 3 次无新数据但 hasMore=true 时，尝试更激进的 CDP 滚动
      if (noNewItemsStreak >= 3 && hasMore) {
        logger.info({ attempt: scrollAttempts, noNewItemsStreak }, '[XHS-Phase3] Trying aggressive CDP scroll fallback (hasMore=true)');
        try {
          await HumanActions.cdpSmartScroll(newPage, ['.comments-container', '.list-container'], 600, 'down');
        } catch {
          await HumanActions.humanScroll(newPage, 600, { minPause: 300, maxPause: 800 });
        }
        await HumanActions.wait(newPage, 2000, 3000);
      }
```

- [ ] **步骤 2：修改返回值为原始评论**

在 `scrollLoadRootComments()` 方法末尾（约 L861），将返回值从 `getCollectedItems()` 改为直接从拦截器响应中提取原始评论。

将：
```typescript
    return interceptor.getCollectedItems(pattern);
```

替换为：
```typescript
    // 返回原始评论对象（保留 sub_comment_count, sub_comment_has_more, sub_comments 等字段）
    const responses = interceptor.getResponses(pattern);
    const rawComments: any[] = [];
    const seen = new Set<string>();
    for (const resp of responses) {
      const items = resp?.body?.data?.comments || [];
      for (const item of items) {
        if (item.id && !seen.has(item.id)) {
          seen.add(item.id);
          rawComments.push(item);
        }
      }
    }
    return rawComments;
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "fix(xhs): return raw comments and improve scroll patience for hasMore=true"
```

---

## 验证

### 部署验证

1. 重建 Docker 镜像并部署：
```bash
docker compose build ts-api-gateway && docker compose up -d ts-api-gateway
```

2. 查看日志：
```bash
docker logs sm-ts-api --since 30m 2>&1 | grep -E "Phase3|expandSub|buildComment|sub_comment|scrollLoad|Root comments|show-more|sub/page"
```

### 预期日志（以笔记 `6a17d88d000000003601c4e2` 为例）

- `[XHS-Phase3] Loading root comments via scroll` — 开始加载根评论
- `[XHS-Phase3] Root comments batch loaded totalItems=10` — 首批 10 条根评论
- `[XHS-Phase3] Root comments batch loaded totalItems=16` — 滚动后加载更多根评论（如有）
- `[XHS-Phase3] All root comments loaded` — 所有根评论已加载
- `[XHS-Phase3] Expanding sub-comments totalRoots=16` — 开始展开子评论
- `[XHS-Phase3] Expanding sub-comments for root rootCid=6a1c60cc000000002b00399f` — 对有更多子评论的根评论执行展开
- `[XHS-Phase3] Clicked .show-more` — 成功点击展开按钮
- `[Interceptor] storeResponse STORE: pattern=/api/sns/web/v2/comment/sub/page` — 子评论 API 响应被拦截
- `[XHS-Phase3] Comments collected rootCount=16 totalComments=19` — totalComments > rootCount（包含子评论）

### 预期日志（以笔记 `6a17d855000000003700f7e5` 为例）

- `[XHS-Phase3] Root comments batch loaded totalItems=10` — 首批
- `[XHS-Phase3] Trying aggressive CDP scroll fallback (hasMore=true)` — 激进滚动 fallback
- `[XHS-Phase3] Root comments batch loaded totalItems=N` (N > 10) — 加载更多
- 或 `[XHS-Phase3] No new items streak limit reached hasMore=false` — 确实没有更多评论

### 数据库验证

```sql
SELECT cid, "rootId", "parentId", level, text
FROM "Comment"
WHERE "videoId" = '6a17d88d000000003601c4e2' AND level = 2
ORDER BY "create_time" DESC
LIMIT 10;
```

预期：子评论的 `rootId` 不为空，`level=2`，`parentId` 指向被回复的评论 ID。
