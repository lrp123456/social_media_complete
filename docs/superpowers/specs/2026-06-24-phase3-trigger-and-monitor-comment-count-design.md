# Phase3 触发规则、简单模式新增评论与数据监控评论数口径统一设计规格

**日期**: 2026-06-24  
**状态**: 待用户复审  
**范围**: 统一 Phase3 入队触发条件；明确简单模式新增根评论/回复能力边界；统一数据监控评论总数展示口径

---

## 1. 背景

当前系统有三个评论数和评论处理相关口径不一致问题：

1. Phase3 评论采集是否执行，不只取决于平台当前评论总数和上次存储的 `Video.commentCount` 是否变化；部分平台还会因为本地评论记录为空或快照为空而进入采集。
2. 简单模式需要更清晰地区分“采集新增根评论”和“采集子回复/楼中楼回复”，同时保留对新增根评论的通知、AI 回复建议和人工回复能力。
3. 数据监控页面未点击平台/账号卡片前显示的评论总数，与点击后详情页显示的评论数不一致。详情页使用 `Video.commentCount`，这是正确口径；列表卡片部分接口仍使用本地 `Comment` 表计数。

目标是：

- 把“是否采集”和“展示评论总数”的口径统一到平台返回的视频评论总数，即 `Video.commentCount`。
- 把简单模式定位为“低成本采集新增根评论 + 支持回复新增根评论”，而不是完整评论树采集。

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

Phase3 已经被 Phase1 触发后，可以使用本地 `comments.cid` 集合做**幂等去重**和**已入库判断**。这不属于 Phase3 触发条件，也不改变 `isFirstCrawl` 语义。

保留快照在 Phase3 内部的用途：
- 判断哪些已有根评论的 `replyCount` 增加；
- 采集完成后更新根评论快照；
- 删除已不存在的根评论快照。

**理由**：
- Phase1 负责决定“是否采集”和“首次/增量”。
- Phase3 只负责“怎么采集、怎么去重、怎么入库”。
- 快照缺失是增量算法的降级/异常状态，不应改变 Phase1 的触发语义。

### 2.3 `!==` 触发的抖动处理

**决策**：接受平台 API 单次异常值导致的少量误触发，不增加 debounce 或多次确认机制。

Phase3 与数据库写入必须保持幂等：
- 评论入库使用 `cid` 去重/upsert；
- 通知只应基于本轮识别出的新增评论组，而不是直接基于 `newCount - oldCount`；
- `Video.commentCount` 最终同步为平台当前返回值。

**理由**：
- 平台评论数减少也需要同步，不能只用 `>`。
- 少量多采一次的成本可接受。
- 增加防抖会延迟真实评论数变化，且需要额外状态，不符合当前 bugfix 范围。

### 2.4 简单模式新增评论与回复能力边界

**决策**：简单模式只采集新增根评论，不采集子回复/楼中楼；但简单模式必须支持对新增根评论的通知、AI 回复建议和人工/快捷回复。

| 能力 | 简单模式是否支持 | 说明 |
|---|---:|---|
| 采集新增根评论 | 是 | 简单模式核心能力 |
| 对新增根评论发送企微通知 | 是 | 复用 `commentGroups` 通知链路 |
| 对新增根评论生成 AI 回复建议 | 是 | `newInGroup` 中的根评论应进入现有建议生成流程 |
| 人工/快捷回复新增根评论 | 是 | 只回复 `level=1` 根评论 |
| 采集子回复/楼中楼 | 否 | 保持为深度模式能力 |
| 针对子回复生成 AI 回复建议 | 否 | 简单模式不采集子回复 |
| 监控根评论 replyCount 变化 | 否 | 这是深度模式的快照增量职责 |

**理由**：
- 简单模式的价值是低成本、低风险、低耗时。
- 子回复采集需要展开评论树或调用子评论接口，会显著增加点击/滚动动作和风控风险。
- 运营最常见动作是处理新增根评论；完整评论树监控应由深度模式承担。

### 2.5 数据监控展示口径

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
- `newComments` 是已采集新增/未读评论指标，应继续来自本地评论表。

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

### 3.3 小红书 Phase1 入队规则

**文件**：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

已确认当前代码状态：

1. 已有笔记当前使用 `video.comment_count > dbVideo.commentCount`，需要改为 `video.comment_count !== dbVideo.commentCount`。
2. 当前构建 `commentsQueue` 时查询 `videoRootCommentCount`，并用 `!existingSnapshot` 决定 `isFirstCrawl`。需要删除这段快照查询。
3. `isFirstCrawl` 应由 Phase1 入队原因显式传递：
   - 新笔记入队时设置 `isFirstCrawl: true`；
   - 已有笔记评论数变化入队时设置 `isFirstCrawl: false`。

实现时可给 `updatedVideos` 临时结构增加 `isFirstCrawl` 字段，或直接在发现更新时构造 `commentsQueue`，但不能再用快照存在性反推首次/增量。

### 3.4 腾讯 Phase1 入队规则

**文件**：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

已确认当前代码状态：

1. 新视频 `newCount > 0` 时已入队，`isFirstCrawl: true`，保持。
2. 已有视频当前使用 `newCount > dbVideo.commentCount`，需要改为 `newCount !== dbVideo.commentCount`。
3. 当前未发现“本地 comments 为空”或“快照为空”触发入队的补偿逻辑，无需删除此类逻辑。

### 3.5 Phase3 首次/增量判定与快照缺失降级

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

1. 记录 warning，说明增量任务缺少根评论快照。
2. 不切换为首次全量采集。
3. 进入增量降级路径：
   - 查询当前视频本地已入库的 `comments.cid` 集合；
   - 新根评论识别使用 `currentSnapshots.cid NOT IN comments.cid`，而不是 `currentSnapshots.cid NOT IN lastSnapshots`；
   - 子回复识别继续使用已入库 `comments.cid` 去重；
   - 由于缺少旧 `replyCount`，不执行“旧根评论 replyCount 增加 → 定向展开该根评论”的判断；
   - 本轮结束时用当前根评论列表重建/更新 `video_root_comment_counts`，供下一轮恢复正常增量比较。

这样会使用 `comments` 表做 Phase3 内部幂等判断，但不会让 `comments` 表决定是否进入 Phase3，也不会把增量任务改成首次全量任务。

其他平台如有类似“快照为空则首次采集”的判断，也按同样原则调整。

### 3.6 简单模式新增根评论处理

**文件**：
- `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`
- `apps/ts-api-gateway/src/services/monitorService.ts`

简单模式的 Phase3 处理规则：

1. 打开目标视频/笔记评论入口。
2. 拉取当前可见根评论，最多处理 `maxRootComments` 条。
3. 查询该视频本地已有根评论 `comments.cid` 集合。
4. `cid` 不存在的根评论判定为本轮新增根评论。
5. 仅新增根评论入库：
   - `level = 1`；
   - `replyId = '0'`；
   - `subComments = []`；
   - 不创建子回复记录。
6. 为新增根评论构建统一 `commentGroups`：
   - `rootComment` 为该根评论；
   - `subReplies = []`；
   - `newInGroup = [rootComment]`。
7. `monitorService` 使用 `commentGroups` 触发企微通知、AI 回复建议和快捷/人工回复链路。
8. 如果本轮评论总数变化但没有发现新增根评论：
   - 记录日志；
   - 仍同步 `Video.commentCount`；
   - 不发送“新增根评论”通知。

### 3.7 简单模式回复能力

简单模式支持的是“回复新增根评论”，不是“采集评论下的回复”。

要求：

1. 新增根评论入库时必须保留后续回复所需字段：
   - `videoId`；
   - `cid`；
   - `text`；
   - `userNickname` / `userUid`；
   - `platform` 可通过视频所属用户解析；
   - `level = 1`、`replyId = '0'`。
2. `commentGroups.newInGroup` 中的根评论应进入现有通知和 AI 回复建议流程。
3. 快捷回复/人工回复只针对这些 `level=1` 根评论。
4. 简单模式不为子回复生成回复建议，也不展示“楼中楼新增”语义。

如果某个平台回复接口需要额外上下文（例如评论所在视频、窗口、平台、用户），应从现有 `Comment -> Video -> User` 关系补齐，而不是在简单模式额外采集子评论。

### 3.8 简单模式局限说明

简单模式需要明确接受以下局限：

1. 如果新增根评论不在当前可见的前 `maxRootComments` 条内，可能漏采。
2. 如果 `comment_count` 变化来自子回复增加，简单模式可能进入 Phase3 但找不到新增根评论。
3. 如果平台排序变化导致旧评论回到前排，简单模式会用 `cid` 去重避免重复通知。
4. 如果需要完整子回复监控、楼中楼新增提醒或根评论 replyCount 增量判断，应切换深度模式。

### 3.9 数据监控账号卡片评论总数

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

### 3.10 其他监控接口

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

### 4.2 简单模式新增根评论数据流

```text
Simple Phase3 已被触发
  └─ 拉取当前根评论列表（最多 maxRootComments）
      └─ 与本地 comments.cid 去重
          ├─ 新 cid：入库为 level=1 根评论
          │   └─ commentGroups.newInGroup=[rootComment]
          │       └─ 通知 + AI 回复建议 + 人工/快捷回复
          └─ 已存在 cid：跳过，不重复通知
```

简单模式不进入子回复展开链路。

### 4.3 深度模式增量去重数据流

```text
Deep Phase3 已被触发
  ├─ 正常增量：lastSnapshots + currentSnapshots 判断根评论 replyCount 变化
  ├─ 快照缺失降级：comments.cid 判断哪些评论尚未入库
  └─ 入库：cid upsert / 去重，结束后更新 root snapshots
```

### 4.4 数据监控展示数据流

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
   记录 warning，不把任务改成首次采集。使用本地 `comments.cid` 做已入库判断；无法通过旧 `replyCount` 精确定位的子回复增量不强行定向展开。本轮结束后更新快照，下一轮恢复正常增量路径。

3. **平台评论数减少**  
   因为采用 `!==`，减少也会进入 Phase3。采集结束后 `Video.commentCount` 同步为平台当前值，避免展示旧的较大数值。

4. **平台 API 临时抖动**  
   单次异常值可能导致一次额外 Phase3，这是可接受行为。幂等保护依赖 `cid` 去重/upsert 和新增评论组过滤，避免重复入库和重复通知。当前不新增 debounce。

5. **简单模式进入 Phase3 但没有新增根评论**  
   这可能由子回复增加、平台排序变化、评论删除后新增抵消、或新增根评论不在前 `maxRootComments` 条内导致。处理方式是记录日志、同步 `Video.commentCount`，不发送新增根评论通知。

6. **简单模式漏采较深位置的新根评论**  
   这是简单模式的性能/风险取舍。需要完整覆盖时使用深度模式或提高 `maxRootComments`。

7. **简单模式下用户需要回复子评论**  
   不支持。简单模式只对新增根评论生成回复建议和快捷/人工回复入口；子评论回复属于深度模式。

8. **视频删除、下架或超出监控范围**  
   `reconcileVideosForUser` 以当前可见视频列表为准：已在 DB 中但不在本轮可见列表中的视频会被删除，并从 `sum(Video.commentCount)` 中移除；如果本轮可见列表为空且 DB 有数据，会触发保护逻辑跳过删除，避免因平台 API 空响应误删全部视频。

9. **同一视频短时间连续触发 Phase3**  
   监控任务按现有队列/窗口串行机制执行；若仍发生连续触发，Phase3 必须通过 `cid` upsert 和已入库 cid 集合保持幂等。第二次任务如果没有识别到新增评论组，不应发送重复新增评论通知。

10. **新评论数与总评论数不一致**  
    这是预期行为：新评论数来自本地已采集且未读的评论，总评论数来自平台 API。

---

## 6. 测试与验证

### 6.1 单元/静态验证

- 检查抖音、快手、小红书、腾讯的 Phase1 入队条件：
  - 新视频评论数大于 0 入队；
  - 已有视频仅在 `comment_count !== dbVideo.commentCount` 时入队；
  - 不存在 `comments.count === 0` 触发入队；
  - 不存在快照为空触发入队或强制首次采集。
- 检查小红书不再用 `videoRootCommentCount.findFirst` 决定 `isFirstCrawl`。
- 检查腾讯已有视频从 `>` 改为 `!==`。
- 检查四个平台简单模式 `commentGroups`：
  - `rootComment.level = 1`；
  - `subReplies = []`；
  - `newInGroup` 只包含新增根评论；
  - 已存在 `cid` 不重复进入 `newInGroup`。

### 6.2 API 验证

- 调用 `GET /api/v1/matrix/monitor/accounts`，确认账号卡片 `totalComments` 等于该用户所有视频 `Video.commentCount` 之和。
- 调用 `GET /api/v1/matrix/monitor/accounts/:userId`，确认详情页视频 `commentCount` 之和与账号卡片一致。
- 确认 `newComments` 仍只统计 `Comment.isNew = 1`。

### 6.3 手动监控验证

至少选择一个抖音或快手账号验证：

1. 新视频评论数大于 0：进入 Phase3 首次采集。
2. 已有视频评论数不变：不进入 Phase3。
3. 已有视频评论数增加：进入 Phase3 增量采集。
4. 已有视频评论数从 N 变为 0：进入 Phase3，同步 `Video.commentCount = 0`，后续卡片评论总数减少。
5. 同一视频短时间连续触发 Phase3：不重复入库同一 `cid`，没有新增评论组时不重复通知。
6. 增量任务缺少根评论快照：不转为首次全量采集，本轮结束后重建快照。
7. 简单模式新增根评论：入库、发送通知、生成 AI 回复建议，并可执行人工/快捷回复。
8. 简单模式只有子回复增加：可触发 Phase3 并同步 `Video.commentCount`，但不发送新增根评论通知。

---

## 7. 不在范围内

- 新增历史缺失评论补采功能。
- 新增数据库字段区分展示评论数和触发评论数。
- 为平台 API 抖动新增 debounce、多次确认或阈值策略。
- 简单模式采集子回复/楼中楼回复。
- 简单模式对子回复生成 AI 回复建议或回复入口。
- 调整前端 UI 布局。
- 改变深度模式的完整评论树采集定义。

---

## 8. 成功标准

1. Phase3 入队只由新视频评论数大于 0 或已有视频评论总数变化触发。
2. 本地 `comments` 表为空不会触发 Phase3。
3. 根评论快照为空不会把增量任务改成首次采集。
4. 小红书和腾讯与抖音、快手使用一致的 Phase1 入队口径。
5. 简单模式只采集新增根评论，不采集子回复。
6. 简单模式新增根评论能进入通知、AI 回复建议和人工/快捷回复链路。
7. 数据监控未点击卡片前的账号评论总数与点击后详情视频评论数之和一致。
8. `newComments` 继续表示本地新增/未读评论数量。
9. 重复触发时依赖 `cid` upsert/去重保持幂等，不重复入库同一评论。
