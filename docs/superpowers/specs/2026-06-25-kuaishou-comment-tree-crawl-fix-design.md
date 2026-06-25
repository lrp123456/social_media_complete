# 快手评论树采集失效修复设计规格

**日期**: 2026-06-25
**状态**: 已确认
**范围**: 修复快手视频评论树（根评论）从未被采集的问题。根因为 Phase3 触发死锁——评论总数未变时永不进 Phase3，导致根评论树永久为 0。修复方式为在共享触发函数 `getCommentCrawlDecision` 新增"根评论缺失重试"分支，配合重试上限与诊断日志。

---

## 1. 背景

快手 `userId=22` 的评论树采集完全失效。DB 铁证：

- `comments` 表：快手全部视频 `level=1` 根评论 = 0（含 API 显示 56 条评论的视频）。
- `video_root_comment_counts` 表：0 条。
- `video_comment_counts` 表：0 条。
- 对比抖音 `userId=21` 同架构 `comments=68`，工作正常。
- 快手 `crawl_settings`：`mode=simple, enabled=true`，配置无误。

真实接口结构已确认（`/rest/cp/creator/comment/commentList` POST 响应）：

- 评论数组字段 = `data.list`。
- 根评论判据 = `replyTo === 0`。
- 分页游标 = `data.pcursor`，末页无 `pcursor`。
- 字段名：`commentId / content / authorName / authorId / likedCount / timestamp / subCommentCount`。

Simple 模式采集代码 `r.body?.data?.list` 字段路径**正确**，采集层本身未坏。问题在于 Phase3 流程从未被触发。

---

## 2. 根因

### 2.1 Phase3 触发死锁（唯一根因）

`getCommentCrawlDecision`（`apps/ts-api-gateway/src/services/commentCrawlRules.ts`）是 Phase1 决定"某视频是否进入 Phase3"的纯函数。现有逻辑只看评论总数变化：

1. 历史上某次这些视频首次 Phase3（卡顿 bug 期间）未采到根评论，写入 0 条。
2. 但 `reconcileVideosForUser` 用平台 API 的 `commentCount`（2/56/4/1…）覆盖写入 `Video.commentCount`。
3. 之后每轮 Phase1 对比：`currentCount(56) === storedCount(56)` → `comment_count_unchanged` → **不入队** → Phase3 永不触发。
4. 根评论树永久为 0，且无任何 Phase3 日志可查（流程根本没启动）。

函数只看评论总数、不看根评论数，无法发现"评论总数没变但根评论树为空"的状态。

### 2.2 被排除的假设

- **Simple 模式字段解析过窄**：经真实接口验证，`data.list` 路径正确，排除。
- **抽屉选择器/匹配**：上一轮已修复 `openSelectVideoDrawer`/`findAndClickVideoInDrawer`，但因 Phase3 不触发，未实战验证。本次修复让 Phase3 真正触发后可顺带验证。

### 2.3 附带小 bug

Simple 模式存储时 `create_time: comment.timestamp` 直接存毫秒（如 `1781529530551`），而 `parseCommentList` 对 `>1e12` 做了 `/1000` 归一化。Simple 模式漏了这步，导致时间戳错位。一并修复。

---

## 3. 设计决策

### 3.1 新增"根评论缺失重试"触发分支

在 `getCommentCrawlDecision` 的 `comment_count_unchanged` 判断之前插入新分支：

```text
storedCount 存在 且 currentCount === storedCount（评论数未变）时：
  if currentCount > 0 且 rootCommentCount === 0 且 retryCount < 5:
    → shouldQueue: true, isFirstCrawl: false, reason: 'root_comments_missing'
  else if currentCount > 0 且 rootCommentCount === 0 且 retryCount >= 5:
    → shouldQueue: false, reason: 'comment_count_unchanged'  // 放弃
  else:
    → comment_count_unchanged（保持原行为）
```

精准命中快手死锁场景。抖音/小红书因根评论已采到（`rootCommentCount>0`），新分支不触发，不受影响。

### 3.2 重试上限落地方案：Video 表新增字段

`Video` 表新增 `rootCommentRetryCount Int @default(0)`（需 prisma migration）。持久、可审计、重启不丢。上限 5 次：连续 5 次 Phase3 采到 0 条根评论后 `shouldQueue=false` 放弃，避免每次调度都重试卡顿。采到 ≥1 条则计数清零。

计数更新时机：
- Phase3 Simple 存储后，`commentsToStore.length > 0` → `rootCommentRetryCount = 0`。
- 否则（采空）→ `rootCommentRetryCount += 1`。

Phase1 只读 `rootCommentRetryCount`，不写（写由 Phase3 负责），与触发判断解耦。

### 3.3 三处调用点统一改造

`getCommentCrawlDecision` 新增两个入参 `rootCommentCount`、`retryCount`，三处调用统一传值：

- 抖音 `douyinCrawler.ts` Phase1 循环
- 快手 `kuaishouCrawler.ts` Phase1 循环
- 小红书 `xiaohongshuCrawler.ts` Phase1 循环

保证逻辑一致、未来不踩同样死锁。抖音/小红书因根评论已采到，此分支基本不触发，但代码统一更安全。

### 3.4 rootCommentCount 批量查询

Phase1 循环前一次性 `groupBy` 查出该用户所有视频的根评论 count（`Comment` 表 `level=1`），存 Map，循环里查 Map。1 次 DB 查询，避免 N 次（N≈20）逐个查询。

---

## 4. 改动范围

### 4.1 修改文件

1. **`prisma/schema.prisma`**
   - `Video` 模型新增 `rootCommentRetryCount Int @default(0) @map("root_comment_retry_count")`。
   - 生成 migration。

2. **`apps/ts-api-gateway/src/services/commentCrawlRules.ts`**
   - `CommentCrawlDecisionReason` 新增 `'root_comments_missing'`。
   - `getCommentCrawlDecision` 入参新增 `rootCommentCount: number`、`retryCount: number`。
   - 插入"根评论缺失重试"分支（含 retryCount>=5 放弃逻辑）。

3. **`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`**
   - Phase1 循环前批量查根评论 count Map。
   - 循环内 `getCommentCrawlDecision` 传 `rootCommentCount`、`retryCount`（从 `dbVideo.rootCommentRetryCount`）。
   - `root_comments_missing` 入队日志。

4. **`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`**
   - 同抖音 Phase1 改造。
   - `processCommentsQueueSimple`：
     - 存储后按 `commentsToStore.length` 更新 `Video.rootCommentRetryCount`（清零 / +1）。
     - 修复 `create_time` 毫秒归一化（`>1e12` 除 1000）。
     - 增加全链路诊断日志（见 4.3）。

5. **`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`**
   - 同抖音 Phase1 改造。

### 4.2 新增/扩展测试文件

- `apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts`
  - `root_comments_missing` 触发入队。
  - `retryCount >= 5` 放弃。
  - `rootCommentCount > 0` 不误触发。
  - `currentCount = 0` 不触发新分支。
  - 现有 4 种 reason 不回归。

### 4.3 诊断日志（Simple 模式全链路）

`processCommentsQueueSimple` 增加：

```text
[Simple] Phase3 start: awemeId, apiCommentCount, dbRootCommentCount, retryCount
[Simple] Drawer opened: awemeId, visible=true/false
[Simple] Video clicked: awemeId, matched=true/false, matchType
[Simple] CommentList captured: awemeId, responseCount, firstPageListLen, pcursor, bodyKeys, dataKeys
[Simple] Parse result: awemeId, parsedRootCount, filteredOut(non-root), storedNewCount
[Simple] Phase3 done: awemeId, success, storedCount, retryCountUpdated
```

关键：每次捕获 `commentList` 响应时记录 `bodyKeys`/`dataKeys`/首条评论 JSON 片段（截断 500 字符），即使字段结构将来变化也能从日志直接定位。

---

## 5. 数据流

```text
每轮监控 Phase1（抖音/快手/小红书）：
  对每个视频 v：
    currentCount     = 平台API评论总数
    storedCount      = DB Video.commentCount
    rootCommentCount = rootCountMap[v.id]            ← 批量查 Map
    retryCount       = dbVideo.rootCommentRetryCount

    decision = getCommentCrawlDecision({
      currentCount, storedCount, rootCommentCount, retryCount
    })

    分支：
      new_video_with_comments      → 入队（首次）
      new_video_without_comments   → 跳过
      comment_count_changed        → 入队（评论增加）
      root_comments_missing        → 入队（补采，retryCount<5）
                                     或跳过（retryCount>=5，放弃）   ← 新增
      comment_count_unchanged      → 跳过

  → reconcileVideosForUser 写库（rootCommentRetryCount 保留不动）

Phase3 Simple 每个视频：
  openSelectVideoDrawer → findAndClickVideoInDrawer → waitForCommentResponse(8s)
    ├─ 无响应：result.error，retryCount += 1，continue
    └─ 有响应：collectAllCommentResponses → data.list → 去重 → 存储
        ├─ storedCount > 0：retryCount = 0，success
        └─ storedCount = 0：retryCount += 1，success(空)

  写回 Video.rootCommentRetryCount
```

`rootCommentRetryCount` 在两处更新：Phase3 采空时 +1、采到时清 0。Phase1 只读不写。

---

## 6. 错误处理与边界

1. **retryCount 达上限**：`rootCommentRetryCount >= 5` → 不入队，记日志 `[Phase1] Root comments missing but retry limit reached — giving up`。
2. **rootCommentCount 批量查询失败**：try/catch，失败按空 Map 处理（`rootCommentCount` 视为 0，倾向于重试），不阻断 Phase1。
3. **Video 无 rootCommentRetryCount 字段（老数据）**：migration 默认值 0，老视频从 0 开始，符合"未采过→重试"预期。
4. **抖音/小红书误触发风险**：根评论已采到（`rootCommentCount>0`），新分支条件不满足，不会误入队。
5. **currentCount=0 的视频**：不触发新分支（`currentCount>0` 前置），无评论视频本就不进 Phase3。
6. **timestamp 毫秒归一化**：Simple 模式存储时 `comment.timestamp > 1e12 ? Math.floor(timestamp/1000) : timestamp`，与 `parseCommentList` 对齐。
7. **Phase3 单视频失败不阻塞队列**：已有 `continue` 保持，retryCount 仅在采到 0 条时 +1。

---

## 7. 测试与验证

### 7.1 单元测试

`apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts`：

- `root_comments_missing`：storedCount 存在、`currentCount===storedCount`、`currentCount>0`、`rootCommentCount===0`、`retryCount<5` → `shouldQueue=true, reason='root_comments_missing'`。
- `retryCount>=5` → `shouldQueue=false`（放弃）。
- `rootCommentCount>0` → 走 `comment_count_unchanged`（不误触发）。
- `currentCount=0` → 不触发新分支。
- 现有 4 种 reason 不回归。

### 7.2 运行时日志验证

触发快手监控后，日志应依次出现：

- `[Phase1] Root comments missing — enqueuing for retry`
- `[Simple] Phase3 start: ... retryCount`
- `[Simple] CommentList captured: ... bodyKeys, dataKeys, firstPageListLen`
- `[Simple] Parse result: ... parsedRootCount, storedNewCount`
- `[Simple] Phase3 done: ... retryCountUpdated`

### 7.3 DB 验证

- 修复后快手 `userId=22` 的 `comments` 表从 0 变为 >0（至少 `3xpxixudjituky2` 根评论被采到）。
- `video_root_comment_counts` / `video_comment_counts` 出现记录。
- `Video.rootCommentRetryCount` 在采到后归 0。

### 7.4 静态验证

- 三处 `getCommentCrawlDecision` 调用都传了 `rootCommentCount`、`retryCount`。
- prisma migration 生成 `rootCommentRetryCount` 字段。

---

## 8. 不在范围

- 不改 Phase1 视频列表采集/排序/截断。
- 不改完整模式（Deep）流程，仅 Simple 模式受益（当前快手配置即 simple）。
- 不采集子评论内容。
- 不改抖音/小红书现有正常逻辑（仅统一传参）。
- 不调整全局队列调度策略。

---

## 9. 成功标准

1. 快手 `userId=22` 视频的根评论树从 0 变为 >0（至少 `3xpxixudjituky2` 采到根评论）。
2. `getCommentCrawlDecision` 在评论总数未变但根评论为 0 时触发重试入队。
3. 连续 5 次采空后停止重试，不再卡顿。
4. Simple 模式全链路日志可定位 commentList 响应结构与解析结果。
5. 抖音/小红书不受影响（根评论已采到，新分支不触发）。
6. 新增/扩展单测通过，三处调用点统一传参。
