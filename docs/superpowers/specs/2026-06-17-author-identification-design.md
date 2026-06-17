# 作者识别与评论通知优化设计

## 目标

统一全平台的作者身份识别机制，确保：
1. 每个监控用户在 Phase1 时绑定平台作者 ID（`platformAuthorId`），带自愈校验
2. 评论入库时正确计算 `isAuthor` 字段
3. 通知只针对非作者评论触发，作者评论仅更新评论树
4. 修复手动触发无去重、视频号 `userUid` 存储错误等附带问题

## 背景

当前各平台作者识别状态：

| 平台 | `platformAuthorId` 绑定 | `isAuthor` 计算 | `userUid` 存储 | 评论解析 |
|------|------------------------|----------------|---------------|---------|
| 抖音 | ✅ Phase1 提取 | ⚠️ 增量有，首爬缺 | ✅ `user.uid` | ✅ 完整 |
| 快手 | ✅ Phase1 提取 | ❌ 硬编码 `false` | ✅ `authorId` | ✅ 完整 |
| 视频号 | ❌ 从未绑定 | ❌ 硬编码 `false` | ❌ 存的是头像 URL | ✅ 完整但字段错 |
| 小红书 | ❌ 从未绑定 | N/A | N/A | ❌ 仅轻量模式 |

通知过滤漏洞：
- `unifiedQueue.ts:296-323` 只过滤 level-2 作者回复，level-1 作者根评论仍触发通知
- 首爬 `commentGroups`（`douyinCrawler.ts:1697-1750`）完全不过滤作者评论

---

## 1. 作者 ID 绑定与自愈机制

### 1.1 各平台绑定来源

| 平台 | 绑定时机 | API 来源 | 提取字段 |
|------|---------|---------|---------|
| 抖音 | Phase1 视频列表 | `/item/list` 或 `/work_list` | `item.author.uid` |
| 快手 | Phase1 视频列表 | 视频列表 API | `video.authorId` |
| 视频号 | Phase1 视频列表 | `/post_list` 请求体中的 `_log_finder_id` | `finder_id` |
| 小红书 | Phase1 笔记列表 | 笔记列表 API | 笔记作者 ID（实现时探索 API 结构） |

### 1.2 自愈机制

每个监控周期 Phase1 开始时，从视频/笔记列表 API 提取作者 ID，与数据库 `platformAuthorId` 比对：

```
Phase1 提取 authorUid → 查 DB 中的 platformAuthorId
  ├─ 为空 → 首次绑定，写入 DB
  ├─ 一致 → 跳过（零开销）
  └─ 不一致 → 更新 DB + 日志告警 "作者 ID 变更"
```

抖音额外保险：即使 `platformAuthorId` 未绑定或过时，`label_type === 1` 仍能正确识别作者评论。

### 1.3 视频号特殊处理

`_log_finder_id` 存在于**请求参数**中而非响应体。爬虫层需要在构造 `post_list` 请求时捕获这个参数值并传出，供 Phase1 写入 `platformAuthorId`。

---

## 2. 评论 `isAuthor` 判断逻辑

### 2.1 各平台判断策略

| 平台 | 主判断 | 兜底判断 | 现状 → 改动 |
|------|--------|---------|-----------|
| 抖音 | `label_type === 1`（服务端权威标记） | `String(user.uid) === String(platformAuthorId)` | 增量路径已用 UID 比对 → 改为 label_type 优先；首爬路径缺失 → 补全 |
| 快手 | `String(comment.authorId) === String(platformAuthorId)` | 无 | 硬编码 `false` → 改为 ID 比对 |
| 视频号 | `String(comment.username) === String(platformAuthorId)` | 无 | 硬编码 `false` → 改为 ID 比对 |
| 小红书 | N/A（本次不实现评论解析） | N/A | 仅绑定作者 ID，不改评论逻辑 |

### 2.2 统一类型转换

所有平台的 ID 比对统一采用 `String()` 转换，不区分平台：

```
isAuthor = platformAuthorId && String(commentUserId) === String(platformAuthorId)
```

| 平台 | `commentUserId` | `platformAuthorId` | 统一转换 |
|------|----------------|-------------------|---------|
| 抖音 | `user.uid` (string) | `String?` | `String(user.uid) === String(platformAuthorId)` |
| 快手 | `authorId` (number) | `String?` | `String(authorId) === String(platformAuthorId)` |
| 视频号 | `username` (string) | `String?` | `String(username) === String(platformAuthorId)` |

### 2.3 抖音 `label_type` 字段保留

当前 `parseCommentList`（`douyinCrawler.ts:723`）解析评论时没有保留 `label_type` 和 `label_text` 字段。需要补全：

```
parseCommentList 返回的评论对象新增：
  label_type: c.label_type        // 1 = 作者, 0/undefined = 普通用户
  label_text: c.label_text        // "作者" 文本
```

抖音完整判断逻辑（适用于所有 level 评论）：
```
isAuthor = (label_type === 1)
         || (platformAuthorId && String(userUid) === String(platformAuthorId))
```

### 2.4 快手评论解析改动

快手评论 API 返回 `authorId` 字段（评论者的数字 ID）。当前 `kuaishouCrawler.ts:1562` 硬编码 `is_author: false`，改为：

```
isAuthor = platformAuthorId && String(comment.authorId) === String(platformAuthorId)
```

### 2.5 视频号评论解析改动

视频号评论 API 返回 `username` 字段（finder_id 格式 `v2_xxx@finder`）。两处改动：

1. **修复 `userUid` 存储**：`monitorDatabaseService.ts:551` 当前把头像 URL 存入 `userUid` → 改为存 `username`（finder_id）
2. **计算 `isAuthor`**：`tencentCrawler.ts:1131,1147` 硬编码 `false` → 改为 `String(username) === String(platformAuthorId)`

---

## 3. 通知过滤修复

### 3.1 当前漏洞

| 漏洞 | 位置 | 影响 |
|------|------|------|
| Level-1 作者评论未过滤 | `unifiedQueue.ts:296-323` | 作者发根评论仍触发通知 |
| 首爬 commentGroups 未过滤 | `douyinCrawler.ts:1697-1750` | 首次监控时作者评论全部触发通知 |
| 快手/视频号 `isAuthor` 永远 `false` | 各爬虫硬编码 | 即使补全了 `isAuthor`，通知过滤因 `userUid !== platformAuthorId` 判断仍然依赖 UID 比对 |

### 3.2 修复方案：统一通知过滤层

在 `unifiedQueue.ts` 构建 `commentGroups` 时，统一过滤逻辑，**不依赖 `platformAuthorId` 比对，改为依赖 Comment 对象上的 `isAuthor` 字段**：

```
当前逻辑（依赖 UID 比对）:
  g.newInGroup.filter(n => n.level === 2 && n.userUid !== platformAuthorId)
  g.subReplies.filter(s => s.userUid !== platformAuthorId)

修复后逻辑（依赖 isAuthor 字段）:
  g.newInGroup.filter(n => !n.isAuthor)
  g.subReplies.filter(s => !s.isAuthor)
  g.newInGroup.filter(n => !n.isAuthor)  // for newCids
```

好处：
- 过滤逻辑不依赖 `platformAuthorId` 是否已绑定——只要评论入库时 `isAuthor` 计算正确，通知就正确
- Level 1 和 Level 2 统一处理——作者评论无论层级都不触发通知
- 首爬路径同样适用——只要首爬时 `isAuthor` 计算正确（第 2 节已补全），通知自动正确

### 3.3 首爬 commentGroups 过滤

`douyinCrawler.ts:1697-1750` 首爬路径构建 `commentGroups` 时，当前不过滤作者评论。修复方案：在构建 `newInGroup` 时直接用 `!isAuthor` 过滤，与增量路径保持一致。

如果某个 group 过滤后 `newCids.size === 0`（全是作者评论），该 group 被移除（`unifiedQueue.ts:327` 已有此逻辑）。

### 3.4 通知触发条件

修复后通知触发条件：
- 至少有一个非作者的新评论（level 1 或 level 2）
- 作者评论仍写入评论树（`isAuthor=true` 标记），前端仍显示"作者"徽章
- 纯作者评论的视频不触发通知，但评论树已更新

---

## 4. 整体流程优化

### 4.1 P0：手动触发去重（本次修复）

`/monitor/accounts/:userId/trigger` 端点（`matrix.ts:1192`）直接入队，不检查是否已有同用户的 active job。日志显示用户 3 曾被连续触发 3 次，产生 3 个并发 job 抢同一窗口锁。

修复：入队前检查 `monitorQueue.getJobs(['active', 'waiting'])`，如果已有同 userId 的 job 则返回"任务已在队列中"，不重复入队。与调度器 dedup 逻辑一致。

### 4.2 P1：视频号 `userUid` 字段数据污染（本次修复）

`monitorDatabaseService.ts:551` 把头像 URL 存入 `userUid` 字段，而非用户 ID。修复后新数据会正确存入 `username`（finder_id）。历史脏数据不清理（头像 URL ≠ finder_id，无法回溯），新数据从此正确。

### 4.3 不在本次范围

| 问题 | 原因 |
|------|------|
| 小红书 Phase 2/3 评论解析 | 工作量大，需 DOM/API 逆向，单独立项 |
| 视频号 `_log_finder_id` 来源验证 | 需要实际抓包确认是从 Cookie 解析还是 API 返回 |
| 历史脏数据清理（视频号 userUid） | 无法回溯，新数据正确即可 |

---

## 涉及文件清单

| 文件 | 改动内容 |
|------|---------|
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | `parseCommentList` 补全 `label_type` 字段；首爬路径补全 `isAuthor` 计算；首爬 commentGroups 过滤作者评论 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | `is_author` 从硬编码 `false` 改为 ID 比对 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | `is_author` 从硬编码 `false` 改为 ID 比对；Phase1 提取 `_log_finder_id` 存入 `platformAuthorId` |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | Phase1 提取作者 ID 存入 `platformAuthorId`（仅绑定，不改评论逻辑） |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 修复视频号 `userUid` 存储（头像 URL → username） |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | 通知过滤从 UID 比对改为 `!isAuthor` 字段判断 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 手动触发端点补全去重逻辑 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 抖音 Phase1 自愈逻辑（已有绑定，补全变更检测） |
