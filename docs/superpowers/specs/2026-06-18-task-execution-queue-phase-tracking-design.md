# 任务执行队列与阶段追踪系统设计

- **日期**: 2026-06-18
- **状态**: 待实现
- **范围**: `apps/ts-api-gateway`（后端阶段追踪 + DB + API + crawler 选择器插桩）、`apps/admin-dashboard`（前端常驻队列 Tab + 详情视图）
- **非范围**: 监控/发布/回复的业务逻辑变更、BullMQ 调度策略变更、窗口锁重构

## 1. 背景与问题

### 1.1 现状

系统已有统一执行队列 `unifiedQueue.ts`，将监控(monitor)、发布(publish)、回复(reply)三类任务合并到同一 BullMQ 队列，通过 WindowMutex 保证同一浏览器窗口串行执行。

三类任务的阶段追踪能力差异显著：

| 维度 | 监控 (Monitor) | 发布 (Publish) | 回复 (Reply) |
|------|---------------|---------------|-------------|
| 阶段划分 | ✅ Phase1→Phase2→Phase3 | ✅ PublisherState 状态机 | ❌ 无 |
| 进度回调 | ✅ `job.updateProgress` | ❌ 未调用 | ❌ 未调用 |
| 数据库追踪 | ✅ MonitorStatus + OperationLog | ✅ OperationLog | ❌ 仅 `replyStatus` 三态 |
| 前端展示 | ✅ 进度条 + phase/step | ✅ StatusPill 四态 | ❌ 无阶段标签 |

### 1.2 问题

1. **回复评论执行"黑盒"**：`executeReplyAction()`（monitorService.ts:1430）是一个无中间状态报告的单体函数。`replyStatus` 只有 `none/pending/sent/failed`，无法反映执行到哪一步。
2. **无统一执行队列视图**：前端只有用户管理/发布管理/数据监控三个 Tab，没有统一的"当前在执行什么"的视图。
3. **无执行历史持久化**：BullMQ `removeOnComplete:100` 仅内存缓存，重启丢失。无法事后分析"某个回复为什么失败"。
4. **选择器降级不可见**：crawler 内部选择器尝试（主选择器→备选）没有记录，调试回复失败时无法知道是哪一层选择器没命中。

### 1.3 现有可复用基础

- `unifiedQueue.ts` 已统一三类任务，BullMQ `job.updateProgress()` 机制现成
- `replyDebugLogger.ts` 已在三个 crawler 中有 43 个 `snap(label, extra)` 调用点（抖音15/快手18/视频号10），覆盖所有关键步骤，仅 debug 模式生效
- `SystemStatus.isDebugMode` 字段已有，前端 ToggleSwitch 已可控制
- 前端 `StatusPill` 组件（7种 tone + icon/dot）可直接复用

## 2. 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 前端布局 | 常驻简略条 + 独立队列 Tab（方案 C+） | 常驻条在任何 Tab 都能看到摘要不丢信息；完整视图在独立 Tab 不挤占工作区 |
| 历史持久化 | 新建 `TaskExecution` + `TaskExecutionStep` 表 | BullMQ 内存缓存重启丢失；需要按执行 ID 查询详情、按类型/时间筛选 |
| 历史保留 | 10 天自动清理 | 平衡存储成本与排查需求，DOM 快照同步清理 |
| 选择器插桩 | 全量插桩（方案 A） | 用户要求完整记录选择器命中/降级链路 |
| 插桩开关 | 受 debug 模式控制 | 正常运行零开销；排查时开启 debug 即可看完整链路 |
| 插桩入口 | 新建 `taskExecutionRecorder.ts` + 升级 `snap()` 闭包 | 43 个现有调用点不动，改实现不改调用点，风险低 |
| 阶段粒度 | 回复6阶段/监控3阶段/发布4阶段 | 覆盖各任务类型的关键里程碑 |
| 前端实时性 | 3s 轮询活跃任务 | 复用现有 `useActiveMonitorTasks` 的轮询模式 |

## 3. 数据库模型

### 3.1 新增表：TaskExecution

一次任务执行的完整记录。

```prisma
model TaskExecution {
  id              String   @id @default(cuid())
  taskId          String   // 对应 BullMQ jobId
  taskType        String   // 'monitor' | 'publish' | 'reply'
  platform        String   // 'douyin' | 'kuaishou' | 'tencent'
  userId          Int?
  windowId        String
  status          String   @default("running")  // 'running' | 'completed' | 'failed' | 'cancelled'
  currentPhase    String?  // 当前阶段名（如 "执行回复"）
  phaseIndex      Int?     // 当前阶段序号（1-based）
  totalPhases     Int?     // 总阶段数
  progressPercent Int?     // 0-100
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  durationMs      Int?
  errorMessage    String?  @db.Text
  isDebugMode     Boolean  @default(false)  // 是否在 debug 模式下执行
  createdAt       DateTime @default(now())  // 用于10天清理

  steps           TaskExecutionStep[]

  @@index([taskType, createdAt])
  @@index([status, createdAt])
  @@index([userId, createdAt])
}
```

### 3.2 新增表：TaskExecutionStep

单个执行步骤（仅 debug 模式记录）。

```prisma
model TaskExecutionStep {
  id              String   @id @default(cuid())
  executionId     String   // FK → TaskExecution
  phase           String   // 所属阶段名
  stepIndex       Int      // 步骤序号
  label           String   // 步骤标签（如 "点击目标视频卡片"）
  status          String   // 'success' | 'failed' | 'fallback'
  durationMs      Int?
  selectorTries   Json?    // [{selector, hit, isPrimary}, ...]
  mouseAction     String?  // 如 "click(412,287)"
  extra           Json?    // 其他上下文（URL、轮询次数等）
  snapshotPath    String?  // DOM 快照文件路径
  createdAt       DateTime @default(now())

  execution       TaskExecution @relation(fields: [executionId], references: [id], onDelete: Cascade)

  @@index([executionId, stepIndex])
}
```

### 3.3 自动清理

定时任务（复用现有调度器模式），每天 03:00 执行：

- 删除 `TaskExecution` 中 `createdAt < now() - 10 days` 的记录（级联删除 steps）
- 删除 `data/reply_debug/` 下 10 天前的快照目录

## 4. 后端阶段追踪

### 4.1 阶段定义

三种任务类型的阶段命名规范，通过 `job.updateProgress` 上报。

**回复评论（6 阶段）：**

| 序号 | 阶段名 | 内容 | 百分比区间 |
|------|--------|------|-----------|
| 1 | 准备 | 连接指纹浏览器、查询评论和视频的 DB 信息 | 0-10% |
| 2 | 导航 | 导航到平台的评论管理页面 | 10-25% |
| 3 | 定位视频 | 在评论管理页选择/切换到目标视频 | 25-40% |
| 4 | 等待评论 | 轮询等待评论列表加载完成 | 40-55% |
| 5 | 执行回复 | 定位目标评论、输入回复文本、点击发送 | 55-95% |
| 6 | 完成 | 确认结果、执行退出策略 | 95-100% |

**视频监控（3 阶段，已有，保持）：** Phase1 采集视频 → Phase2 采集评论 → Phase3 汇总

**视频发布（4 阶段，补充）：** 登录 → 上传 → 填写信息 → 发布确认

### 4.2 taskExecutionRecorder.ts（新建）

核心插桩组件，路径：`apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`

暴露四个函数：

- `startExecution(task, job)` — 创建 TaskExecution 记录，读取 `SystemStatus.isDebugMode` 写入 `isDebugMode` 字段，内部缓存 `job` 引用用于后续 `updatePhase` 调用 `job.updateProgress`，返回 `executionId`
- `updatePhase(executionId, phaseIndex, phaseName, percent, detail?)` — 更新 `currentPhase/phaseIndex/progressPercent`，通过缓存的 `job` 引用调用 `job.updateProgress`
- `recordSelectorTry(executionId, label, data)` — debug 关闭时空操作（零开销）；debug 开启时写入 `TaskExecutionStep` + 触发 DOM 快照保存
- `finishExecution(executionId, status, errorMessage?)` — 更新 `status/completedAt/durationMs/errorMessage`

`executionId` 传递路径：`unifiedQueue.worker` → `startExecution` 返回 → `executeReplyAction(task, replyData, executionId)` 新增参数 → crawler 的 `replyToComment(..., executionId)` → snap 闭包捕获 → `recordSelectorTry(executionId, ...)`。

### 4.3 snap() 闭包升级

现有 43 个 `snap(label, extra)` 调用点不动，升级闭包实现：

- 旧逻辑：`if (isDebugMode) saveDebugSnapshot(file)`
- 新逻辑：`if (isDebugMode) { saveDebugSnapshot(file); recordSelectorTry(executionId, label, {...}) }`

选择器信息提取：`extra` 字段已有的上下文信息直接映射到 `selectorTries` JSON。对于硬编码选择器的 `page.evaluate` 调用，在 evaluate 返回值中增加选择器尝试结果（命中/未命中），通过 extra 传递给 `recordSelectorTry`。

### 4.4 unifiedQueue worker 改造

三个任务分支都增加执行记录：

- 任务开始：`executionId = await startExecution(task)`
- 阶段边界：`await updatePhase(executionId, phaseIndex, phaseName, percent, detail)`
- 任务结束：`await finishExecution(executionId, 'completed' | 'failed' | 'cancelled', errorMessage)`

具体改造：
- **回复任务**：在 `executeReplyAction` 的 6 个阶段边界插桩
- **监控任务**：已有 `job.updateProgress`，补充 `startExecution`/`finishExecution`
- **发布任务**：在 `publisher.publish` 前后补充阶段上报

### 4.5 新增 API 端点

路径：`apps/ts-api-gateway/src/routes/matrix.ts`

- `GET /matrix/queue/active` — 活跃任务列表（实时，读 BullMQ active/waiting + 关联 TaskExecution 进度）
- `GET /matrix/queue/history?page=1&limit=20&taskType=&status=` — 历史任务列表（分页，读 TaskExecution 表）
- `GET /matrix/queue/executions/:id` — 单个执行详情（含 steps，debug 模式下有选择器详情）

## 5. 前端实现

### 5.1 新增"执行队列" Tab + 常驻简略条

修改文件：`apps/admin-dashboard/src/app/matrix/page.tsx`

Tab 类型扩展为 `'users' | 'publish' | 'monitor' | 'queue'`，Tab 栏增加第四个 Tab"执行队列"，带红色角标显示活跃任务数。

**常驻简略条** — 在 Tab 内容区上方，所有 Tab 都显示：
- 收起状态：一行摘要，格式 `⚡ 执行队列 [3] │ [监控 Phase2·60%] [回复 执行回复·80%] [发布 上传·30%] │ 查看全部 →`
- 活跃任务为 0 时隐藏
- 点击跳转到 queue Tab

**queue Tab 完整视图**（新组件 `QueueTab`）：
- 顶部统计卡（执行中/今日完成/失败/排队中）
- 任务列表：每个任务卡片显示类型标签(颜色)+用户+平台+阶段进度条+详情
- 点击任务卡片跳转详情视图

### 5.2 任务详情视图

新组件 `ExecutionDetail`：
- **头部**：执行 ID（`TaskExecution.id`，醒目展示）+ 类型标签 + 用户/平台 + 时间 + 耗时
- **阶段时间线**：阶段节点显示每个阶段耗时，当前阶段高亮
- **详细步骤列表**（仅 `isDebugMode=true` 的任务有数据）：每步显示阶段标签+步骤标签+状态(✓/⚠降级/✗)+耗时；展开区显示选择器尝试链（主✗→备1✗→备2✓，命中绿色、未命中红色删除线）、鼠标坐标、轮询详情
- **DOM 快照缩略图**（debug 模式，点击可放大）
- `isDebugMode=false` 时：只展示阶段时间线，提示"该任务未在 debug 模式下执行，无详细步骤"

### 5.3 数据获取 Hooks

修改文件：`apps/admin-dashboard/src/hooks/useApi.ts`

- `useActiveQueueTasks()` — GET /matrix/queue/active, 3s 轮询
- `useQueueHistory(filters)` — GET /matrix/queue/history, 分页
- `useExecutionDetail(id)` — GET /matrix/queue/executions/:id

### 5.4 颜色规范

复用现有 StatusPill 体系：

| 任务类型 | 标签色 | 色值 |
|---------|--------|------|
| 视频监控 | 绿 | `#10b981` |
| 回复评论 | 橙 | `#f59e0b` |
| 视频发布 | 紫 | `#6366f1` |

## 6. Debug 模式控制

### 6.1 控制流

任务开始时读取 `SystemStatus.isDebugMode` → 写入 `TaskExecution.isDebugMode`：
- `false`：阶段边界只调 `job.updateProgress`，不写 `TaskExecutionStep`，不保存 DOM 快照
- `true`：全量记录选择器尝试、步骤详情、DOM 快照到 `TaskExecutionStep`

### 6.2 前端展示判断

详情视图根据 `TaskExecution.isDebugMode` 判断：
- `true` → 展示完整步骤列表 + 选择器链 + 快照
- `false` → 只展示阶段时间线 + 提示文案

## 7. 错误处理

| 场景 | 处理 |
|------|------|
| 任务执行失败 | `status = 'failed'`，记录 errorMessage，保留已记录的 steps |
| 任务超时 | 同上，errorMessage = "回复超时: 超过 300s" |
| 任务取消 | `status = 'cancelled'` |
| DB 写入失败 | 不影响主流程，logger.warn 记录（与现有 OperationLog 一致） |
| 快照保存失败 | 跳过快照，继续记录文字步骤 |

## 8. 测试策略

- **后端单元测试**：`taskExecutionRecorder`（debug 开/关行为验证）、阶段边界上报
- **前端组件测试**：`QueueTab` 渲染（活跃/空/多任务）、`ExecutionDetail` 展开/折叠
- **集成测试**：端到端跑一次回复任务（debug 开启），验证 DB 有完整 steps 记录

## 9. 涉及文件

### 后端（apps/ts-api-gateway）
- `prisma/schema.prisma` — 新增 TaskExecution + TaskExecutionStep 模型
- `src/lib/taskExecutionRecorder.ts` — 新建，核心插桩组件
- `src/lib/replyDebugLogger.ts` — 升级 snap() 闭包
- `src/services/unifiedQueue.ts` — worker 三个分支增加 startExecution/updatePhase/finishExecution
- `src/services/monitorService.ts` — `executeReplyAction` 增加 `executionId` 参数 + 6 阶段边界插桩
- `src/routes/matrix.ts` — 新增 3 个 API 端点
- `src/crawlers/douyinCrawler.ts` — 硬编码选择器 evaluate 返回值增加尝试结果
- `src/crawlers/kuaishouCrawler.ts` — 同上
- `src/crawlers/tencentCrawler.ts` — 同上

### 前端（apps/admin-dashboard）
- `src/app/matrix/page.tsx` — 新增 queue Tab + 常驻简略条
- `src/components/matrix/QueueTab.tsx` — 新建，队列完整视图
- `src/components/matrix/ExecutionDetail.tsx` — 新建，执行详情视图
- `src/hooks/useApi.ts` — 新增 3 个 hooks

### 定时清理
- 复用现有调度器，新增每日 03:00 清理任务（TaskExecution 表 + reply_debug 目录）
