# XHS 子评论采集修复设计

## 背景

小红书评论树采集中，子评论（回复评论的评论）无法正确采集。通过分析 API 响应和 DOM 结构，发现 7 个 bug。

## 测试用例

以笔记 `6a17d88d000000003601c4e2`（"这房子，我先替你们看了！🏠"）为例：
- 10 条根评论，共 21 条评论
- 根评论 `6a1d9768000000002701d126`（"这种房子贵"）有 1 条预加载子评论 "面宽太窄 应该也会很具性价比"
- 根评论 `6a1c60cc000000002b00399f`（"一直不太理解北美区房子为啥都喜欢两套客餐厅"）有 1 条预加载子评论 + 1 条需展开获取的子评论
- 展开按钮 DOM: `<div class="show-more">展开 1 条回复</div>`

以笔记 `6a17d855000000003700f7e5`（"舍不得离开：湖景石屋🏡"）为例：
- 首次 API 返回 10 条评论，`has_more=true`
- 3 次滚动无新数据后退出，但实际还有更多评论

## Bug 清单

| # | 文件 | 行号 | Bug | 根因 |
|---|------|------|-----|------|
| 1 | `xiaohongshuCrawler.ts` buildCommentTree() | L936 | `item.comments` 应为 `item.sub_comments` | 字段名错误，预加载子评论从未被提取 |
| 2 | `xiaohongshuCrawler.ts` scrollLoadRootComments() | L861 | 返回 `getCollectedItems()` 调用 `parseVideoItem()` | `parseVideoItem` 只保留 `aweme_id/description/create_time/comment_count/metrics`，丢弃 `sub_comment_count`/`sub_comment_has_more`/`sub_comments` 等字段 |
| 3 | `xiaohongshuCrawler.ts` expandSubCommentsForRoots() | L879 | `getByText('展开')` 范围过宽 | 匹配到非目标元素或找不到元素 |
| 4 | `xiaohongshuCrawler.ts` expandSubCommentsForRoots() | L886 | `getByText('展开更多回复')` 在 DOM 中不存在 | 实际 DOM 是 `<div class="show-more">展开 N 条回复</div>`，没有 "展开更多回复" 文本 |
| 5 | `xiaohongshuCrawler.ts` expandSubCommentsForRoots() | — | 点击展开按钮后未等待 `/comment/sub/page` 响应 | 子评论 API 响应可能在 `buildCommentTree()` 读取时还未到达 |
| 6 | `xiaohongshuCrawler.ts` buildCommentTree() | L970 | `sub.root_id` 在 sub/page 响应中不存在 | sub/page API 响应中无 `root_id` 字段，需从请求 URL 的 `root_comment_id` 参数提取 |
| 7 | `xiaohongshuCrawler.ts` scrollLoadRootComments() | L838 | `noNewItemsStreak >= 3` 在 `hasMore=true` 时也退出 | `maxNoNewItems=3` 过于激进，图片重的笔记需要更多滚动才能触发懒加载 |

## API 结构

### `/api/sns/web/v2/comment/page` 响应

```json
{
  "data": {
    "comments": [
      {
        "id": "根评论ID",
        "content": "评论内容",
        "user_info": { "user_id": "...", "nickname": "..." },
        "like_count": "0",
        "create_time": 1780324200000,
        "ip_location": "浙江",
        "sub_comments": [          // ← 预加载子评论数组
          {
            "id": "子评论ID",
            "content": "子评论内容",
            "user_info": { ... },
            "like_count": "0",
            "create_time": 1780372213000,
            "target_comment": {     // ← 回复目标（可能是根评论也可能是另一条子评论）
              "id": "目标评论ID",
              "user_info": { "user_id": "...", "nickname": "..." }
            },
            "note_id": "笔记ID"
          }
        ],
        "sub_comment_has_more": false,  // ← 是否有更多子评论需展开
        "sub_comment_cursor": "游标",    // ← 展开子评论的分页游标
        "sub_comment_count": "1",        // ← 子评论总数
        "note_id": "笔记ID"
      }
    ],
    "cursor": "根评论分页游标",
    "has_more": true
  }
}
```

### `/api/sns/web/v2/comment/sub/page` 响应

请求 URL 参数: `note_id=X&root_comment_id=Y&num=10&cursor=Z`

```json
{
  "data": {
    "comments": [
      {
        "id": "子评论ID",
        "content": "子评论内容",
        "user_info": { ... },
        "like_count": "0",
        "create_time": 1780373502000,
        "target_comment": {
          "id": "回复目标评论ID",
          "user_info": { "user_id": "...", "nickname": "..." }
        },
        "note_id": "笔记ID"
        // 注意：没有 root_id 字段！需从请求 URL 的 root_comment_id 参数获取
      }
    ],
    "cursor": "子评论分页游标",
    "has_more": false
  }
}
```

### DOM 结构

```html
<div class="comments-container">
  <div class="parent-comment">
    <div id="comment-{根评论ID}" class="comment-item">
      <!-- 根评论内容 -->
    </div>
    <div class="reply-container">
      <div class="list-container">
        <div id="comment-{子评论ID}" class="comment-item comment-item-sub">
          <!-- 预加载子评论 -->
        </div>
      </div>
      <!-- 展开按钮（仅有更多子评论时出现） -->
      <div class="show-more">展开 N 条回复</div>
    </div>
  </div>
  ...
</div>
```

关键点：
- 展开按钮是 `.show-more`，位于 `.reply-container` 内
- 点击后触发 `/comment/sub/page` API，新子评论追加到 `.list-container`
- 点击后 `.show-more` 消失，如果 `has_more=true` 则可能出现新的 `.show-more`

## 修复方案

### Fix 1: buildCommentTree() — 预加载子评论字段名

```typescript
// 修改前 (L936):
if (item.comments && Array.isArray(item.comments)) {

// 修改后:
if (item.sub_comments && Array.isArray(item.sub_comments)) {
```

### Fix 2: scrollLoadRootComments() — 返回原始评论

```typescript
// 修改前 (L861):
return interceptor.getCollectedItems(pattern);

// 修改后:
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

返回类型从 `any[]`（实际为 `VideoInfo[]`）变为真正的 `any[]`（原始评论对象，保留所有字段）。

### Fix 3 + Fix 4 + Fix 5: expandSubCommentsForRoots() — 选择器与等待

```typescript
async expandSubCommentsForRoots(newPage: Page, rootComments: any[]): Promise<void> {
  const interceptor = this.commentInterceptor as RequestInterceptor;
  const subPattern = '/api/sns/web/v2/comment/sub/page';

  for (const root of rootComments) {
    const subCount = parseInt(root.sub_comment_count || '0', 10);
    if (subCount <= 0) continue;

    const hasMoreSub = root.sub_comment_has_more === true;
    if (!hasMoreSub) continue;  // 所有子评论已预加载，无需展开

    const rootCid = root.id;
    if (!rootCid) continue;

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

      // 在根评论的 .reply-container 内查找 .show-more 按钮
      const replyContainer = rootContainer.locator('..').locator('.reply-container').first();
      // 或从 parent-comment 容器查找
      const parentComment = newPage.locator(`.parent-comment:has(#comment-${rootCid})`).first();
      const showMoreBtn = parentComment.locator('.show-more').first();

      // 点击展开，最多 10 次分页
      for (let i = 0; i < 10; i++) {
        if (!(await showMoreBtn.isVisible().catch(() => false))) {
          break;  // 没有更多展开按钮
        }

        const prevSubCount = interceptor.getResponseCount(subPattern);
        await showMoreBtn.click();
        await HumanActions.wait(newPage, 500, 1000);

        // 等待 /comment/sub/page 响应到达
        const gotNew = await interceptor.waitForNewResponse(subPattern, prevSubCount, 8000);
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
          break;  // 没有更多子评论了
        }
      }
    } catch (err: any) {
      logger.warn({ rootCid, error: err.message }, '[XHS-Phase3] Failed to expand sub-comments');
    }
  }
}
```

关键改进：
- 使用 `.show-more` CSS 选择器替代 `getByText('展开')`
- 通过 `.parent-comment:has(#comment-{rootCid})` 精确定位根评论的父容器
- 点击后使用 `waitForNewResponse()` 等待 `/comment/sub/page` 响应
- 检查响应的 `has_more` 判断是否继续展开
- 移除了不存在的 `getByText('展开更多回复')` 循环

### Fix 6: buildCommentTree() — sub/page 根评论关联

```typescript
// 解析子评论 /comment/sub/page
const subResponses = interceptor.getResponses('/api/sns/web/v2/comment/sub/page');
for (const resp of subResponses) {
  // 从请求 URL 提取 root_comment_id
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
      rootId: rootCommentId,           // ← 从 URL 参数获取
      parentId: sub.target_comment?.id || undefined,
      level: 2,
      replyToName: sub.target_comment?.user_info?.nickname || '',
      is_author: sub.show_tags?.includes('is_author') || false,
    });
  }
}
```

### Fix 7: scrollLoadRootComments() — 滚动耐心度

```typescript
// 修改前:
const maxNoNewItems = 3;
// ...
if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {

// 修改后:
// 根据 hasMore 动态调整耐心度
// ...
const hasMore = lastResp?.hasMore;
const maxNoNewItems = hasMore ? 5 : 3;

if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {
  // ...
}

// 在滚动循环内增加 fallback：
if (noNewItemsStreak >= 3 && hasMore) {
  logger.info({ attempt: scrollAttempts }, '[XHS-Phase3] Trying aggressive CDP scroll fallback');
  await HumanActions.cdpSmartScroll(newPage, ['.comments-container', '.list-container'], 600, 'down');
  await HumanActions.wait(newPage, 2000, 3000);
}
```

## 影响范围

仅修改 `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` 一个文件：
- `scrollLoadRootComments()` — 返回值改为原始评论，增加滚动耐心度
- `expandSubCommentsForRoots()` — 重写选择器和等待逻辑
- `buildCommentTree()` — 修复字段名 + 根评论关联

不涉及 `interceptor.ts` 或其他爬虫文件。

## 测试验证

1. 部署后触发笔记 `6a17d88d000000003601c4e2` 的评论采集
2. 检查日志：
   - `scrollLoadRootComments` 应加载所有根评论（has_more=false 时停止）
   - `expandSubCommentsForRoots` 应对 `sub_comment_has_more=true` 的根评论点击 `.show-more`
   - 应看到 `/comment/sub/page` 响应被拦截
   - `buildCommentTree` 输出的 `totalComments` 应大于 `rootCount`
3. 检查数据库：子评论的 `rootId` 不为空，正确关联到根评论
4. 验证笔记 `6a17d855000000003700f7e5`：滚动加载应获取超过 10 条根评论（如果确实有更多）
