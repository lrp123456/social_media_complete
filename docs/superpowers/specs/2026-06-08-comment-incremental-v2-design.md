# 评论增量检测 v2 — 设计规格

> 版本：v1.0 | 日期：2026-06-08
> 基于 v3.0.0 comment-crawler-enhancement，改造检测逻辑为精准增量模式

---

## 零、目标与问题

### 现状问题

当前 `checkForUpdates` 通过比较 `Video.commentCount`（评论总数，含回复）来判断是否有新评论。如果总数增加，`processCommentsQueue` 爬取前 N 条根评论。

**缺陷**：如果只有回复增加而根评论没变，旧逻辑会漏掉新增的回复评论。同时，在评论列表排序并非按时间倒序的平台（如快手），爬取前 N 条根评论可能爬不到新增的那条。

### 新方案核心思路

1. **首次全量采集**：新视频发现后立即爬取完整评论树（根评论 + 展开所有子回复），记录每条根评论的 `subCommentCount`
2. **两阶段增量检测**：先比较总数 → 若变则进入评论页逐条对比 `subCommentCount` → 定位哪条根评论的回复增加了
3. **按需局部展开**：只展开有新增回复的那条根评论，按时间过滤提取新增
4. **作者评论过滤**：作者自己发的评论不标记为新增、不入企微通知

### 平台范围

- **抖音 + 快手**：全量采集 + 增量检测
- **小红书**：继续轻量统计模式，不做评论详情采集

---

## 一、数据库变更

### 1.1 User 表新增字段

```prisma
platformAuthorId   String?  @map("platform_author_id")    // 抖音uid / 快手userId
platformAuthorName String?  @map("platform_author_name")  // 作者昵称
```

来源：首次采集视频列表时从 API 响应提取：
- 抖音：`work_list`/`item_list` 中视频的 `author.uid`
- 快手：`work_list`/`photo_analysis` 中视频的 `userId`

### 1.2 VideoRootCommentCount 表（已建，本次启用）

```prisma
model VideoRootCommentCount {
  id         String   @id @default(uuid())
  videoId    String   @map("video_id")
  cid        String                      // 根评论 cid
  replyCount Int      @default(0) @map("reply_count")  // subCommentCount
  updatedAt  DateTime @default(now()) @updatedAt
  @@unique([videoId, cid])
}
```

用途：
- 首次采集时插入所有根评论的 `(videoId, cid, replyCount)`
- 后续检测时对比 `replyCount` 变化，定位有新增回复的根评论

### 1.3 不变的表

- `Comment`（已有 rootId/parentId/level/replyToName/isNew）
- `Video`（commentCount 仍用于第一阶段快速总数对比）
- `MonitorStatus`（lastCheckTime 用于时间过滤）

---

## 二、首轮全量采集流程

当 `checkForUpdates` 发现新视频（`!dbVideo` 或首次监控）：

```
checkForUpdates 发现新视频
  │
  ├─>>> 2.1 保存视频基本信息（commentCount 等）到 Video 表
  │
  ├─>>> 2.2 提取 authorId
  │    来源：抖音 work_list/item_list 的 author.uid
  │         快手 work_list/photo_analysis 的 userId
  │    写入 User.platformAuthorId / platformAuthorName
  │
  ├─>>> 2.3 导航到评论详情页，打开评论抽屉/面板
  │
  ├─>>> 2.4 拦截评论列表 API 响应
  │    抖音：/comment/list/select → { comments: [...] }
  │    快手：/rest/cp/comment/pc/list → { data: { list: [...] } }
  │
  ├─>>> 2.5 parseRootCommentSnapshots(comments)
  │    提取每条根评论的 { cid, text, replyCount }
  │    - 抖音：replyCount = comment.reply_comment_total
  │    - 快手：replyCount = entry.subCommentCount
  │    存入 VideoRootCommentCount 表
  │
  ├─>>> 2.6 expandAllReplies(page) → 全量展开所有"查看N条回复"
  │
  ├─>>> 2.7 parseCommentTreeFromDOM(page)
  │    → 构建完整评论树（根评论 level=1 + 子回复 level=2）
  │
  ├─>>> 2.8 合并 API 数据（create_time, digg_count, user_uid）到 DOM 节点
  │
  ├─>>> 2.9 upsertCommentTree(awemeId, allComments)
  │    首次所有评论 isNew=0（非新增，只是初始数据）
  │
  └─>>> 2.10 首次采集不入企微通知（避免刷屏）
```

---

## 三、后续轮次增量检测流程

```
checkForUpdates 发现视频 commentCount 变化
  │
  ├─>>> 3.1 进入评论页，拦截评论列表 API
  │
  ├─>>> 3.2 loadRootCommentSnapshots(videoId)
  │    → 从 VideoRootCommentCount 取出上次记录的所有 root replyCount
  │
  ├─>>> 3.3 对比分析：
  │    a. API 返回的根评论总数 vs DB 中 rootCount（去重后的 root cid 数）
  │    b. 每条 root 的 replyCount vs DB 中的记录
  │
  ├─>>> 3.4 分类处理：
  │
  │   ┌─ 3.4a 根评论总数增加 → 新根评论
  │   │   • 按 createTime > lastCheckTime 过滤出新根评论
  │   │   • 存入 Comment（isNew=1, level=1）
  │   │   • 存入 VideoRootCommentCount（新记录的 replyCount）
  │   │   • expandRepliesForRoot 展开新根评论的子回复
  │   │   • 存入子回复（isNew=1, level=2, rootId=该根评论cid）
  │   │
  │   └─ 3.4b 某条 root 的 replyCount 增加 → 该 root 有新回复
  │       • 只对该 root 执行 expandRepliesForRoot(rootCid)
  │       • DOM 提取新回复节点
  │       • 按 createTime > lastCheckTime 过滤出新增回复
  │       • 过滤：userUid === platformAuthorId → 跳过
  │       • 存入 Comment（level=2, rootId=rootCid, isNew=1）
  │
  ├─>>> 3.5 更新 VideoRootCommentCount：
  │    更新有变化的 root 记录的 replyCount
  │    删除 DB 中已不存在的 rootCid 记录（根评论被删除）
  │
  ├─>>> 3.6 updateCommentCount(awemeId, newCount)
  │
  ├─>>> 3.7 企微通知：发送所有 isNew=1 的评论（排除作者评论）
  │
  └─>>> 3.8 前端刷新评论树 API，新评论自动出现并高亮（isNew=1）
```

---

## 四、作者评论过滤规则

解析每条评论时执行：

```typescript
const isAuthorComment = comment.userUid === user.platformAuthorId;
if (isAuthorComment) {
  // 不标记 isNew，不入企微通知
  // 仅更新 video.commentCount
  return; // 跳过通知和 isNew 标记
}
```

- 作者 ID `platformAuthorId` 在首轮采集时从视频列表 API 提取并存入 User 表
- 如果获取不到 `platformAuthorId`（如首次未提取），降级为不过滤作者评论
- 企微通知构建时：`notifications = newComments.filter(c => c.userUid !== platformAuthorId)`

---

## 五、按需展开回复

新增函数 `expandRepliesForRoot(page, rootCid)`：

```
expandRepliesForRoot(page, rootCid):
  1. 定位该 root 对应的 DOM 容器
     抖音：[data-cid="rootCid"] 所在评论区行
     快手：data-comment-id="rootCid" 所在评论区行
  2. 在该容器内找到"查看 N 条回复"按钮并点击
  3. 等待 DOM 渲染（reply-list / sub-comment-list 容器出现）
  4. 从 DOM 提取新回复节点：
     - content（回复文本）
     - replyToName（@某人）
     - createTime（从 API 合并）
     - userUid（作者判断）
  5. 过滤：userUid === platformAuthorId → 跳过
  6. 过滤：createTime > lastCheckTime → isNew=1
```

与已有的 `expandAllReplies` 的区别：只展开**一条根评论**下的回复，而非整个页面的全部。

---

## 六、API 数据提取规格

### 6.1 抖音

| 字段 | 来源路径 | 用途 |
|------|----------|------|
| `cid` | `comment.cid` | 根评论唯一标识 |
| `text` | `comment.text` | 前端展示 |
| `replyCount` | `comment.reply_comment_total` | 后续对比检测 |
| `createTime` | `comment.create_time` | 时间过滤 |
| `userUid` | `comment.user.uid` | 判断是否作者 |
| `userNickname` | `comment.user.nickname` | 前端展示 |

只取 `reply_id === '0'` 的条目（根评论）。API 拦截 URL：`/comment/list/select`

### 6.2 快手

| 字段 | 来源路径 | 用途 |
|------|----------|------|
| `cid` | `entry.commentId` | 根评论唯一标识 |
| `text` | `entry.content` | 前端展示 |
| `replyCount` | `entry.subCommentCount` | 后续对比检测 |
| `createTime` | `entry.timestamp` | 时间过滤（注意毫秒/秒转换） |
| `userUid` | `entry.authorId` | 判断是否作者 |
| `userNickname` | `entry.authorName` | 前端展示 |

只取 `replyTo === 0` 的条目（根评论）。API 拦截 URL：`/rest/cp/comment/pc/list`

### 6.3 作者 ID 提取

| 平台 | 来源 | 路径 |
|------|------|------|
| 抖音 | work_list/item_list video | `video.author.uid`、`video.author.nickname` |
| 快手 | work_list/photo_analysis | `item.userId`、`item.userName` |

---

## 七、前端展示

调用 `GET /api/v1/matrix/monitor/videos/:id/comments` 返回评论树：

- **isNew=1**：高亮标记（橙色左侧边框 + "新"标签）
- **isNew=0**：正常展示
- 首次全量采集：全部 isNew=0，无高亮
- 作者评论：后端已过滤，前端不做额外处理
- 已读标记：`POST /videos/:id/read-all` 将 isNew 批量置 0

---

## 八、错误处理与容错

| 场景 | 处理 |
|------|------|
| API 拦截超时 | 重试 1 次（5s 超时），仍失败则跳过该视频，记录 warning 日志 |
| "查看回复"按钮 DOM 不存在 | 可能无回复或 DOM 结构变化，跳过该 root，不报错 |
| `subCommentCount` 变小 | 用户可能删除了回复，仍展开重新采集，不标记 isNew |
| `VideoRootCommentCount` 未匹配 | 首次采集或数据丢失，全量重建 snapshots |
| 根评论被删除 | 全量重建时删除 DB 中不存在的 rootCid 记录 |
| API 返回格式变化 | 解析失败 catch，记录 warning，降级为计数对比模式 |
| `platformAuthorId` 获取失败 | 降级为不过滤作者评论 |

---

## 九、文件变更范围

| 文件 | 变更内容 |
|------|----------|
| `prisma/schema.prisma` | User 新增 `platformAuthorId`、`platformAuthorName` |
| `douyinCrawler.ts` | 新增 `parseRootCommentSnapshots`、`expandRepliesForRoot`；重构 `checkForUpdates` 和首轮采集流程；作者评论过滤 |
| `kuaishouCrawler.ts` | 同上，快手版本的对应实现 |
| `menuNavigator.ts` | 可能新增评论页导航定位辅助 |
| `monitorDatabaseService.ts` | 新增 `upsertRootCommentCounts`、`loadRootCommentSnapshots`、`deleteStaleRootCounts` |
| `monitorService.ts` | 通知过滤作者评论 |
| `wechatBotService.ts` | 通知构建时排除 authorId 评论 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 新增 isNew 高亮样式 |

**不需要变更**：`interceptor.ts`、`exitStrategy.ts`、小红书相关代码、调度器核心逻辑、`monitor.ts`/`matrix.ts` 评论 API 路由。

---

## 十、不变更的部分

- 当前评论树 API（GET/POST 端点）不变
- 企微通知模板卡片格式不变（已实现的 text_notice + button_interaction）
- 调度器 `pendingTaskCount` + `scheduleAfterCompletion` 机制不变
- 跨源 ID 归一化（description+createTime）不影响评论检测
