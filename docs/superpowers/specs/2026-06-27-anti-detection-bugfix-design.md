# 收口/反检测优化后两个缺陷的精准根因修复设计

- 日期：2026-06-27
- 范围：精准根因修复（不扩大到其他模块、不引入新状态机）
- 涉及模块：`apps/ts-api-gateway`（监控/回复任务调度、抖音回复流程）

## 背景

最近完成"收口/反检测优化"（probe bootstrap/teardown、enterStep/exitStep、selectorTries 迁移、Interceptor 收口、humanActions/registerPlatformPierce、三平台默认开启 v2）。收口后暴露两个缺陷：

### 缺陷 1：监控任务 1s 静默完成（实际失败）

- 现象：同一操作员控制的多个窗口中，若其中某个窗口执行任务时，其他任务"静默执行完成"，TaskExecution 标 `completed`，耗时约 1s，但实际未做任何抓取。
- 复现样本：
  - 执行 ID `cmqw2rva0000hvk2mrzblgwtk`，任务 ID `mon_1782547527954_8`，开始 2026/6/27 16:05:27，耗时 1s
  - 执行 ID `cmqw2q6l60009vk2mbyenwlob`，任务 ID `mon_1782547449297_9`，开始 2026/6/27 16:04:09，耗时 1s

### 缺陷 2：抖音回复评论卡在目标页面不结束

- 现象：回复评论任务一直处于 `running`，`durationMs` 为 null，前台耗时显示 `-`，始终卡在"要回复评论的指定页面"。
- 复现样本：执行 ID `cmqw2kdkq000tvk2mif332z3x`，任务 ID `reply_1782547178399_<base64 cid>`，开始 2026/6/27 15:59:38，耗时 `-`

## 根因

### 缺陷 1 根因

1. **连接失败吞错（主因）**：`apps/ts-api-gateway/src/services/monitorService.ts:942-949` 中 `executeMonitorCheck` 的 `bm.connect()` 失败时，catch 块执行 `return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false }` 而**没有 throw**。于是 `unifiedQueue.ts:390` 把 TaskExecution 标为 `completed`、BullMQ job 视为成功（不消耗 `attempts: 2` 重试）。所谓"1s 完成"即连接失败的耗时。多窗口并发时，连接串号/资源占用导致部分窗口 connect 快速失败，即表现为静默成功。
2. **锁未获取不检查（次因）**：`unifiedQueue.ts:261-265`（监控）、`:150-154`（回复）、`:188-192`（发布）三处拿到 `WindowMutex.tryAcquireOnce` 的 `null`（锁占用中）后未检查即继续执行，导致同窗口无锁裸跑，放大并发问题。

> 说明：`browserManager.ts:278` 的单例字段 `this.currentWindowId = windowId` 在并发 connect 时会被互相覆盖，是诱因之一，但**本次精准修复不改动 browser-core 单例**，仅通过让连接失败正确失败、不静默成功来消除现象。单例串号留作后续系统性加固项（见"非目标"）。

### 缺陷 2 根因

1. **99999 无界滚动（主因）**：`douyinCrawler.ts:3570-3572` `scrollCommentArea(page, 'top'|'bottom')` 调用 `HumanActions.cdpSmartScroll(page, selectors, 99999, 'up'|'down')`，向 CDP 发送 99999 像素的 wheel 事件。`cdpScroller.executeScroll` 按 60-150px/步 + 段间 60-200ms 拟人节奏执行，单次 `scrollCommentArea` 可耗时 20-60s。
2. **每轮重复归零（放大因）**：`scrollExpandAndFindTarget`（`douyinCrawler.ts:4953-5051`）在 30 轮循环里每轮开头（`:4960`）调用 `scrollCommentArea(page,'top')`，且 final sweep 前再次调用（`:5040`）。滚动进度被反复清零，30 轮可达 10-30 分钟，远超 `REPLY_TIMEOUT_MS = 5 * 60 * 1000`。
3. **无 step 级超时（兜底过粗）**：`replyToComment` 内部无 step 级超时，全靠 `unifiedQueue.ts:156-161` 外层 5min `Promise.race` 兜底。任务长时间 `running` 且 `durationMs` 为 null（`finishExecution` 未被调用），前台显示"耗时 -"。

> 说明：probe bootstrap/teardown、selectorTries 迁移、Interceptor 收口经核对**不是**卡死根因（非调试模式下 probe/recordSelectorTry 均为空操作；回复流程不使用 Interceptor）。本设计不改动这些模块。

## 设计

### 缺陷 1 修复

**改动文件：**
- `apps/ts-api-gateway/src/services/monitorService.ts:942-949`（`executeMonitorCheck` 的 connect catch 块）
- `apps/ts-api-gateway/src/services/unifiedQueue.ts:261-265`（监控分支 `tryAcquireOnce` null 检查）
- `apps/ts-api-gateway/src/services/unifiedQueue.ts:150-154`（回复分支补 null 检查）
- `apps/ts-api-gateway/src/services/unifiedQueue.ts:188-192`（发布分支补 null 检查）

**行为：**

1. `bm.connect()` 失败（含 60s 超时）：保留 `disconnectSession` 清理，随后**改为 throw**：
   `throw new Error('连接指纹浏览器失败: ' + connectErr.message)`。
   - 下游：`handleJob` catch → `finishExecution(executionId, 'failed', msg)` + 写 failure operationLog + `reportMonitorComplete(task.windowId, task.platform, false)` + BullMQ `attempts: 2`（5min backoff）重试。
2. `tryAcquireOnce` 返回 `null`：三处统一 `throw new Error('窗口锁占用中，跳过: ' + task.windowId)`，进入对应分支 catch → 标记 failed，不重复执行。

**不变：** 队列模型、`concurrency: 1`、重试配置、TaskExecution 状态机、`reportMonitorComplete` 调用点、`browserManager` 单例。

### 缺陷 2 修复

**改动文件：**
- `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:3561-3579`（`scrollCommentArea` 去无界化）
- `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:4953-5051`（`scrollExpandAndFindTarget` 单调向下 + 总预算）
- `apps/ts-api-gateway/src/services/monitorService.ts:2132`（`replyToComment` 调用处加 step 级超时）

**行为：**

1. **`scrollCommentArea` 去无界化（L3561）**
   - `'top'`：`cdpSmartScroll` 的 `totalAmount` 由 `99999` 改为有界常量 `SCROLL_BOUNDED_PX = 3000`；滚动后用一次 `page.evaluate` 读取容器 `scrollTop`，若 `scrollTop <= 0` 视为到顶即停；未到顶则再补一轮，最多 `SCROLL_MAX_ROUNDS = 8` 轮硬上限。本质：滚动量与"是否到顶"挂钩，不再盲发 99999。
   - `'bottom'`：同理有界 + 检测 `scrollTop + clientHeight >= scrollHeight` 即停。
   - `direction: number` 入参分支保留原行为。
   - `cdpSmartScroll` / `executeScroll` 内部拟人 segment 实现不改。
2. **`scrollExpandAndFindTarget` 单调向下 + 总预算（L4953）**
   - 删除循环内每轮开头的 `scrollCommentArea(page,'top')`（L4960），改为**仅在首次进入时滚到顶一次**（移到循环外）。
   - 删除 final sweep 前的 `scrollCommentArea(page,'top')`（L5040）。
   - 保留 `MAX_SCROLL = 30`，新增总时长预算 `FIND_TARGET_BUDGET_MS = 90_000`：每轮检查 `Date.now() - startT0`，超预算即 break 走 final sweep，并打日志 `[Reply::Find] Budget exceeded, early exit`。
3. **`replyToComment` step 级超时（monitorService.ts:2132）**
   - 将 `dy.replyToComment(page, replyTarget, replyData.text, executionId)` 包入 `Promise.race`，超时阈值 `REPLY_STEP_TIMEOUT_MS = 120_000`（2min），超时 reject `new Error('定位/执行回复超时')`。
   - 超时与 `replied=false` 都走 `throw new Error('抖音回复执行失败')` → `finishExecution(failed)`。
   - 外层 `REPLY_TIMEOUT_MS = 5min` 保留作最后防线，不改。

**不变：** triple-criteria 匹配逻辑、`findRootCommentByUsernameContent`/`expandRootRepliesIfNeeded`/`findSubCommentInRoot`、probe bootstrap/teardown、`safeCDPType` 拟人输入、`executeExitStrategy`、`cdpSmartScroll` 拟人节奏。

## 数据流

- 缺陷 1：`executeMonitorCheck` connect 失败 → throw → `handleJob` catch → `finishExecution(failed)` + `operationLog(failure)` + `reportMonitorComplete(false)` + BullMQ 重试。TaskExecution 终态 `failed`（不再是误标的 `completed`）。
- 缺陷 2：`replyToComment` 内 `scrollExpandAndFindTarget` 在 ≤90s 内必给结果（找到坐标 / null）→ 找到则继续发送；null 或 step 超时 → throw → `finishExecution(failed)`，`durationMs` 正常写入，前台耗时正常显示。

## 错误处理

- 缺陷 1：连接失败与锁占用都转为显式 `failed`，错误消息进入 `operationLog.details` / TaskExecution.error。重试由现有 BullMQ `attempts` 承担，不新增重试逻辑。
- 缺陷 2：滚动到顶/到底检测的 `page.evaluate` 失败时降级为"按有界量滚动一轮即返回"（不阻塞主流程）；step 超时消息明确，便于事后定位。

## 测试

### TS 单元测试（jest，`apps/ts-api-gateway`）

- `monitorService.connect-failure.test.ts`：mock `bm.connect` reject → 断言 `executeMonitorCheck` reject，错误消息含"连接指纹浏览器失败"，且 `disconnectSession` 被调用一次。
- `unifiedQueue.lock-null.test.ts`：mock `WindowMutex.tryAcquireOnce → null` → 断言 handleJob（monitor/reply/publish）抛"窗口锁占用中"且 `finishExecution(failed)` 被调用一次。
- `douyinCrawler.scrollBounded.test.ts`：mock `cdpSmartScroll` + `page.evaluate` 返回 `scrollTop=0` → 断言 `scrollCommentArea('top')` 只滚动有界量、快速返回，不出现 99999 入参。
- `douyinCrawler.findTargetBudget.test.ts`：mock 每轮耗时使总时长超 `FIND_TARGET_BUDGET_MS` → 断言 `scrollExpandAndFindTarget` 在预算内 break 返回 null（而非跑满 30 轮）。
- `monitorService.replyStepTimeout.test.ts`：mock `dy.replyToComment` 永挂 → 断言 `executeReplyAction` 抖音分支在 `REPLY_STEP_TIMEOUT_MS` 后 reject"定位/执行回复超时"。

### e2e 手动验证

- 用复现样本对应的真实窗口/评论 cid 触发：
  - 监控任务：确认 connect 失败时 TaskExecution 标 `failed`（非 completed），日志含错误，5min 后重试一次。
  - 抖音回复：确认任务在 ~2min 内 fail-fast，`durationMs` 写入，前台耗时正常显示，不再"耗时 -"。

## 非目标

- 不修复 `browserManager` 单例 `currentWindowId` 并发串号（留作后续系统性加固）。
- 不改动 probe / selectorTries / Interceptor 收口代码。
- 不引入窗口健康度/失败冷却状态机。
- 不调整队列 `concurrency`、重试次数、超时总阈值（5min/10min/15min）。
- 不改动 `cdpSmartScroll`/`executeScroll` 拟人节奏与快手/腾讯/小红书回复流程。
