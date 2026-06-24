# Phase3 触发规则与数据监控评论数口径统一设计规格

**日期**: 2026-06-24  
**状态**: 待用户审阅  
**范围**: 统一 Phase3 入队触发条件；统一数据监控评论总数展示口径

---

## 1. 背景

当前系统有两个评论数相关口径不一致问题：

1. Phase3 评论采集是否执行，不只取决于平台当前评论总数和上次存储的 `Video.commentCount` 是否变化；部分平台还会因为本地评论记录为空或快照为空而进入采集。
2. 数据监控页面未点击平台/账号卡片前显示的评论总数，与点击后详情页显示的评论数不一致。详情页使用 `Video.commentCount`，这是正确口径；列表卡片部分接口仍使用本地 `Comment` 表计数。

目标是把“是否采集”和“展示评论总数”的口径都统一到平台返回的视频评论总数，即 `Video.commentCount`。

---

## 2. 设计决策

### 2.1 Phase3 触发规则

**决策**：Phase3 是否入队只由视频的当前平台评论总数与上次存储评论总数决定；新视频是特例，评论数大于 0 时自动采集。

规则如下：

| 视频状态 | 条件 | 是否进入 Phase3 | `isFirstCrawl` |
|---|---|---:|---:|
| 新视频 | `comment_count > 0` | 是 | `true` |
| 新视频 | `comment_count === 0` | 否 | - |
| 已有视频 | `comment_count !== Video.commentCount` | 是 | `false` |
| 已有视频 | `comment_count === Video.commentCount` | 否 | - |

**理由**：
- 用户明确要求“是否进入第三阶段爬取流程只取决于当前视频评论总数是否相较上次有变化”。
- 用户确认“新视频评论数大于 0 自动采集”。
- 避免因为本地评论表或快照表缺失导致评论数没变也反复进入 Phase3。

### 2.2 本地评论和快照的职责

**决策**：本地 `comments` 表是否为空、`video_root_comment_counts` 快照是否存在，都不能决定是否进入 Phase3，也不能把增量任务反推为首次采集。

保留快照在 Phase3 内部的用途：
- 判断哪些根评论是新根评论；
- 判断哪些根评论的 `replyCount` 增加；
- 采集完成后更新根评论快照。

**理由**：
- Phase1 负责决定“是否采集”和“首次/增量”。
- Phase3 只负责“怎么采集”。
- 快照缺失是增量算法的降级/异常状态，不应改变 Phase1 的触发语义。

### 2.3 数据监控展示口径

**决策**：所有“总评论数”展示统一使用 `Video.commentCount` 或其聚合和；“新评论数/未读数”继续使用本地 `Comment.isNew`。

| 展示位置 | 字段 | 口径 |
|---|---|---|
| 平台聚合卡片 | `commentCount` | `sum(Video.commentCount)` |
| 账号监控卡片 | `totalComments` | `sum(Video.commentCount)` |
| 账号详情视频列表 | `video.commentCount` | `Video.commentCount` |
| 视频列表 | `commentCount` | `Video.commentCount` |
| 新评论数 | `newComments` / `newCommentCount` | 本地 `Comment.isNew = 1` |

**理由**：
- 点击后详情页已被确认是正确口径。
- `Comment` 表只代表系统已采集入库的评论，不等于平台评论总数。
- `newComments` 是已采集新增评论/未读提醒指标，应继续来自本地评论表。

---

## 3. 详细设计

### 3.1 抖音 Phase1 入队规则

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

当前需要调整两类逻辑：

1. 已有视频只在评论数变化时入队：
   - 从 `video.comment_count > dbVideo.commentCount` 改为 `video.comment_count !== dbVideo.commentCount`。
   - 这样如果平台评论总数减少，也会触发一次 Phase3，以便同步状态。
2. 删除“评论数未变但本地 comments 表为空则入队”的补偿逻辑。

保留新视频逻辑：
- `!dbVideo && video.comment_count > 0` 时入队，`isFirstCrawl: true`。
- `!dbVideo && video.comment_count === 0` 时不入队。

### 3.2 快手 Phase1 入队规则

**文件**：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

与抖音一致：

1. 已有视频只在 `video.comment_count !== dbVideo.commentCount` 时入队。
2. 删除“评论数未变但本地 comments 表为空则入队”的补偿逻辑。
3. 新视频评论数大于 0 仍自动进入首次采集。

### 3.3 小红书与腾讯 Phase1 入队规则确认

**文件**：
- `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

设计要求：
- 两个平台也应遵守同一规则。
- 如果现有代码只在新视频和评论数变化时入队，则保持现状。
- 如果存在“快照/评论表缺失也入队”的补偿逻辑，应一并删除。

### 3.4 Phase3 首次/增量判定

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

当前抖音深度采集内部存在类似逻辑：

```typescript
const lastSnapshots = await db.getRootCommentCounts(item.awemeId);
const isFirstCrawl = item.isFirstCrawl || lastSnapshots.size === 0;
```

需要改为：

```typescript
const lastSnapshots = await db.getRootCommentCounts(item.awemeId);
const isFirstCrawl = item.isFirstCrawl;
```

如果 `item.isFirstCrawl === false && lastSnapshots.size === 0`：
- 记录 warning，说明增量任务缺少根评论快照；
- 不切换为首次全量采集；
- 保持增量路径的语义，能处理的新增根评论继续处理，无法精确判断的子回复增量不强行展开。

其他平台如有类似“快照为空则首次采集”的判断，也按同样原则调整。

### 3.5 数据监控账号卡片评论总数

**文件**：`apps/ts-api-gateway/src/routes/matrix.ts`

接口：`GET /api/v1/matrix/monitor/accounts`

当前 `totalComments` 使用本地评论表计数：

```typescript
prisma.comment.count({ where: { video: { userId: user.id } } })
```

需要改为视频评论总数聚合：

```typescript
prisma.video.aggregate({
  where: { userId: user.id },
  _sum: { commentCount: true },
})
```

返回：

```typescript
totalComments: totalCommentSum._sum.commentCount ?? 0
```

保留 `newComments` 逻辑：

```typescript
prisma.comment.count({ where: { video: { userId: user.id }, isNew: 1 } })
```

### 3.6 其他监控接口

**文件**：`apps/ts-api-gateway/src/routes/matrix.ts`

以下接口当前口径正确，保持现状：

- `GET /api/v1/matrix/monitor/users`：平台聚合已使用 `sum(Video.commentCount)`。
- `GET /api/v1/matrix/monitor/videos`：视频列表已返回 `v.commentCount`。
- `GET /api/v1/matrix/monitor/accounts/:userId`：详情页视频列表已返回 `v.commentCount`。

---

## 4. 数据流

### 4.1 Phase3 触发数据流

```text
Phase1 获取视频列表
  └─ 平台 API 返回当前 comment_count
      ├─ 新视频 + comment_count > 0
      │   └─ 入队 Phase3，isFirstCrawl=true
      ├─ 已有视频 + comment_count !== Video.commentCount
      │   └─ 入队 Phase3，isFirstCrawl=false
      └─ 其他情况
          └─ 不入队 Phase3
```

`comments` 表和 `video_root_comment_counts` 表不参与上述入队判断。

### 4.2 数据监控展示数据流

```text
Video.commentCount
  ├─ 账号卡片 totalComments = sum(Video.commentCount)
  ├─ 平台卡片 commentCount = sum(Video.commentCount)
  ├─ 账号详情 video.commentCount = Video.commentCount
  └─ 视频列表 commentCount = Video.commentCount

Comment.isNew
  └─ newComments / newCommentCount
```

---

## 5. 错误处理与边界情况

1. **历史视频有 `Video.commentCount > 0` 但本地 `comments` 为空**  
   不自动进入 Phase3，除非后续平台评论总数变化。需要补采时应通过单独的手动修复/清空重建流程处理。

2. **增量任务缺少根评论快照**  
   记录 warning，不把任务改成首次采集。能通过当前评论列表识别的新根评论继续处理；不能可靠判断的子回复增量不强行展开。

3. **平台评论数减少**  
   因为采用 `!==`，减少也会进入 Phase3。采集结束后 `Video.commentCount` 同步为平台当前值，避免展示旧的较大数值。

4. **新评论数与总评论数不一致**  
   这是预期行为：新评论数来自本地已采集且未读的评论，总评论数来自平台 API。

---

## 6. 测试与验证

### 6.1 单元/静态验证

- 检查抖音、快手、小红书、腾讯的 Phase1 入队条件：
  - 新视频评论数大于 0 入队；
  - 已有视频仅在 `comment_count !== dbVideo.commentCount` 时入队；
  - 不存在 `comments.count === 0` 触发入队；
  - 不存在快照为空触发入队或强制首次采集。

### 6.2 API 验证

- 调用 `GET /api/v1/matrix/monitor/accounts`，确认账号卡片 `totalComments` 等于该用户所有视频 `Video.commentCount` 之和。
- 调用 `GET /api/v1/matrix/monitor/accounts/:userId`，确认详情页视频 `commentCount` 之和与账号卡片一致。
- 确认 `newComments` 仍只统计 `Comment.isNew = 1`。

### 6.3 手动监控验证

至少选择一个抖音或快手账号验证：

1. 新视频评论数大于 0：进入 Phase3 首次采集。
2. 已有视频评论数不变：不进入 Phase3。
3. 已有视频评论数变化：进入 Phase3 增量采集。

---

## 7. 不在范围内

- 新增历史缺失评论补采功能。
- 新增数据库字段区分展示评论数和触发评论数。
- 调整前端 UI 布局。
- 改变简单模式/深度模式的采集深度定义。

---

## 8. 成功标准

1. Phase3 入队只由新视频评论数大于 0 或已有视频评论总数变化触发。
2. 本地 `comments` 表为空不会触发 Phase3。
3. 根评论快照为空不会把增量任务改成首次采集。
4. 数据监控未点击卡片前的账号评论总数与点击后详情视频评论数之和一致。
5. `newComments` 继续表示本地新增/未读评论数量。
