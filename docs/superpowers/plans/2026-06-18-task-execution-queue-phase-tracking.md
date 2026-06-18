# 任务执行队列与阶段追踪系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为回复评论/视频监控/视频发布三类任务增加阶段追踪和执行历史持久化，前端新增常驻队列简略条 + 独立队列 Tab + 执行详情视图（含选择器命中链路，debug 模式控制）。

**架构：** 后端复用 `unifiedQueue.ts` 的 BullMQ `job.updateProgress` 机制，新建 `TaskExecution` + `TaskExecutionStep` 两张表（10天自动清理），新建 `taskExecutionRecorder.ts` 作为统一插桩入口，升级现有 `snap()` 调用点。前端在 `matrix/page.tsx` 增加第四个 Tab + 常驻简略条，新建 `QueueTab`、`QueueBar` 和 `ExecutionDetail` 组件。

**技术栈：** Prisma + PostgreSQL + BullMQ + Express（后端）；Next.js 14 + React 18 + TanStack Query + Tailwind（前端）；Jest（后端测试）

**规格文档：** `docs/superpowers/specs/2026-06-18-task-execution-queue-phase-tracking-design.md`

---

## 文件结构

### 后端（apps/ts-api-gateway）

| 文件 | 职责 | 操作 |
|------|------|------|
| `prisma/schema.prisma` | 新增 TaskExecution + TaskExecutionStep 模型 | 修改 |
| `src/lib/taskExecutionRecorder.ts` | 统一插桩入口：start/updatePhase/recordSelectorTry/finish | 新建 |
| `src/lib/replyDebugLogger.ts` | 升级 snap 闭包，新增 executionId 参数从 crawler 传入 | 修改 |
| `src/services/unifiedQueue.ts` | worker 三分支增加 startExecution/updatePhase/finishExecution | 修改 |
| `src/services/monitorService.ts` | executeReplyAction 增加 executionId 参数 + 6阶段边界插桩 | 修改 |
| `src/routes/matrix.ts` | 新增 3 个队列 API 端点 | 修改 |
| `src/services/cleanupService.ts` | 新增每日清理定时任务 | 新建 |
| `src/lib/taskExecutionRecorder.test.ts` | recorder 单元测试 | 新建 |

### 前端（apps/admin-dashboard）

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/app/matrix/page.tsx` | 新增 queue Tab + 常驻简略条 | 修改 |
| `src/components/matrix/QueueTab.tsx` | 队列完整视图（统计+列表） | 新建 |
| `src/components/matrix/ExecutionDetail.tsx` | 执行详情视图 | 新建 |
| `src/components/matrix/QueueBar.tsx` | 常驻简略条组件 | 新建 |
| `src/hooks/useApi.ts` | 新增 3 个队列 hooks | 修改 |
| `src/types/queue.ts` | 队列相关 TypeScript 类型 | 新建 |

---

## 任务 1：数据库模型 — TaskExecution + TaskExecutionStep

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：在 schema.prisma 末尾追加两个模型**

在 `model LoginVerification` 的 `@@map("login_verifications")` 之后追加：

```prisma

// ============================================================
// 任务执行追踪（阶段进度 + debug 步骤记录）
// ============================================================

model TaskExecution {
  id              String   @id @default(cuid())
  taskId          String   // 对应 BullMQ jobId
  taskType        String   @db.VarChar(16) // 'monitor' | 'publish' | 'reply'
  platform        String   @db.VarChar(32)
  userId          Int?
  windowId        String   @db.VarChar(128)
  status          String   @default("running") @db.VarChar(16)
  currentPhase    String?  @db.VarChar(64)
  phaseIndex      Int?
  totalPhases     Int?
  progressPercent Int?
  startedAt       DateTime @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")
  durationMs      Int?     @map("duration_ms")
  errorMessage    String?  @map("error_message") @db.Text
  isDebugMode     Boolean  @default(false) @map("is_debug_mode")
  createdAt       DateTime @default(now()) @map("created_at")

  steps           TaskExecutionStep[]

  @@index([taskType, createdAt], name: "idx_task_exec_type_created")
  @@index([status, createdAt], name: "idx_task_exec_status_created")
  @@index([userId, createdAt], name: "idx_task_exec_user_created")
  @@map("task_executions")
}

model TaskExecutionStep {
  id              String   @id @default(cuid())
  executionId     String   @map("execution_id")
  phase           String   @db.VarChar(64)
  stepIndex       Int      @map("step_index")
  label           String   @db.VarChar(128)
  status          String   @db.VarChar(16) // 'success' | 'failed' | 'fallback'
  durationMs      Int?     @map("duration_ms")
  selectorTries   Json?    @map("selector_tries")
  mouseAction     String?  @map("mouse_action") @db.VarChar(128)
  extra           Json?
  snapshotPath    String?  @map("snapshot_path") @db.VarChar(512)
  createdAt       DateTime @default(now()) @map("created_at")

  execution       TaskExecution @relation(fields: [executionId], references: [id], onDelete: Cascade)

  @@index([executionId, stepIndex], name: "idx_task_step_exec_index")
  @@map("task_execution_steps")
}
```

- [ ] **步骤 2：生成迁移**

运行：`cd /home/lrp/social_media_complete && npx prisma migrate dev --name add_task_execution_tracking --schema prisma/schema.prisma`

预期：成功生成迁移，`task_executions` 和 `task_execution_steps` 表创建成功。

- [ ] **步骤 3：Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add TaskExecution and TaskExecutionStep models"
```

---

## 任务 2：taskExecutionRecorder.ts — 核心插桩组件

**文件：**
- 新建：`apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`
- 新建：`apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts`：

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockPrisma = {
  systemStatus: { findFirst: jest.fn() },
  taskExecution: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  },
  taskExecutionStep: { create: jest.fn() },
};

jest.mock('./prisma', () => ({ prisma: mockPrisma }));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { startExecution, updatePhase, recordSelectorTry, finishExecution } from './taskExecutionRecorder';
import type { ReplyTaskData } from '../services/unifiedQueue';

describe('taskExecutionRecorder', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const mockTask: ReplyTaskData = {
    taskType: 'reply', taskId: 'task-123', userId: 1, platform: 'douyin',
    windowId: 'win-1', fingerprintWindowId: 'fp-1',
    replyData: { videoId: 'v1', commentCid: 'c1', text: 'hi' },
  };
  const mockJob = { updateProgress: jest.fn() };

  it('startExecution creates record with isDebugMode from SystemStatus', async () => {
    mockPrisma.systemStatus.findFirst.mockResolvedValue({ isDebugMode: true });
    mockPrisma.taskExecution.create.mockResolvedValue({ id: 'exec-1' });
    const execId = await startExecution(mockTask, mockJob as any);
    expect(execId).toBe('exec-1');
    expect(mockPrisma.taskExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: 'task-123', taskType: 'reply', isDebugMode: true, status: 'running' }),
    });
  });

  it('updatePhase updates DB and calls job.updateProgress', async () => {
    await updatePhase('exec-1', 3, '定位视频', 30, '选择目标视频中');
    expect(mockPrisma.taskExecution.update).toHaveBeenCalled();
    expect(mockJob.updateProgress).toHaveBeenCalledWith({
      phase: '定位视频', step: '第 3 阶段', percent: 30, detail: '选择目标视频中',
    });
  });

  it('recordSelectorTry is no-op when debug disabled', async () => {
    mockPrisma.taskExecution.findUnique.mockResolvedValue({ isDebugMode: false });
    await recordSelectorTry('exec-1', 'label', { phase: 'test', selectors: [] });
    expect(mockPrisma.taskExecutionStep.create).not.toHaveBeenCalled();
  });

  it('recordSelectorTry writes step when debug enabled', async () => {
    mockPrisma.taskExecution.findUnique.mockResolvedValue({ isDebugMode: true });
    await recordSelectorTry('exec-1', 'click-btn', {
      phase: '执行回复',
      selectors: [{ selector: '.primary', hit: false, isPrimary: true }, { selector: '.fallback', hit: true, isPrimary: false }],
      mouseAction: 'click(412,287)',
    });
    expect(mockPrisma.taskExecutionStep.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executionId: 'exec-1', label: 'click-btn', status: 'fallback',
        selectorTries: [{ selector: '.primary', hit: false, isPrimary: true }, { selector: '.fallback', hit: true, isPrimary: false }],
      }),
    });
  });

  it('finishExecution updates status and computes durationMs', async () => {
    await finishExecution('exec-1', 'completed');
    expect(mockPrisma.taskExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-1' },
      data: expect.objectContaining({ status: 'completed', completedAt: expect.any(Date), durationMs: expect.any(Number) }),
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/lib/taskExecutionRecorder.test.ts --no-coverage 2>&1 | head -15`

预期：FAIL，报错 "Cannot find module './taskExecutionRecorder'"

- [ ] **步骤 3：实现 taskExecutionRecorder.ts**

创建 `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`：

```typescript
import type { Job } from 'bullmq';
import { prisma } from './prisma';
import { createLogger } from './logger';
import type { PlatformTask } from '../services/unifiedQueue';

const logger = createLogger('task-exec-recorder');
const jobCache = new Map<string, Job>();
const stepCounter = new Map<string, number>();
const startTimeCache = new Map<string, number>();

const TOTAL_PHASES: Record<string, number> = { reply: 6, monitor: 3, publish: 4 };

async function getDebugMode(): Promise<boolean> {
  try {
    const status = await prisma.systemStatus.findFirst();
    return status?.isDebugMode ?? false;
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to read isDebugMode, defaulting false');
    return false;
  }
}

export async function startExecution(task: PlatformTask, job: Job): Promise<string> {
  const isDebugMode = await getDebugMode();
  const execution = await prisma.taskExecution.create({
    data: {
      taskId: task.taskId,
      taskType: task.taskType,
      platform: (task as any).platform || 'unknown',
      userId: (task as any).userId ?? null,
      windowId: task.windowId,
      status: 'running',
      totalPhases: TOTAL_PHASES[task.taskType] ?? null,
      isDebugMode,
    },
  });
  jobCache.set(execution.id, job);
  startTimeCache.set(execution.id, Date.now());
  logger.info({ executionId: execution.id, taskId: task.taskId, taskType: task.taskType, isDebugMode }, 'Execution started');
  return execution.id;
}

export async function updatePhase(
  executionId: string,
  phaseIndex: number,
  phaseName: string,
  percent: number,
  detail?: string,
): Promise<void> {
  try {
    await prisma.taskExecution.update({
      where: { id: executionId },
      data: { currentPhase: phaseName, phaseIndex, progressPercent: percent },
    });
    const job = jobCache.get(executionId);
    if (job) {
      await job.updateProgress({ phase: phaseName, step: `第 ${phaseIndex} 阶段`, percent, detail });
    }
  } catch (err: any) {
    logger.warn({ executionId, error: err.message }, 'updatePhase failed (non-fatal)');
  }
}

export async function recordSelectorTry(
  executionId: string,
  label: string,
  data: {
    phase: string;
    selectors: Array<{ selector: string; hit: boolean; isPrimary: boolean }>;
    mouseAction?: string;
    extra?: Record<string, any>;
  },
): Promise<void> {
  try {
    const exec = await prisma.taskExecution.findUnique({
      where: { id: executionId },
      select: { isDebugMode: true },
    });
    if (!exec?.isDebugMode) return;

    const hits = data.selectors.filter(s => s.hit);
    const status = hits.length === 0 ? 'failed'
      : hits.some(s => !s.isPrimary) ? 'fallback' : 'success';

    const currentIdx = stepCounter.get(executionId) ?? 0;
    stepCounter.set(executionId, currentIdx + 1);

    await prisma.taskExecutionStep.create({
      data: {
        executionId,
        phase: data.phase,
        stepIndex: currentIdx,
        label,
        status,
        selectorTries: data.selectors as any,
        mouseAction: data.mouseAction ?? null,
        extra: (data.extra as any) ?? null,
      },
    });
  } catch (err: any) {
    logger.warn({ executionId, label, error: err.message }, 'recordSelectorTry failed (non-fatal)');
  }
}

export async function finishExecution(
  executionId: string,
  status: 'completed' | 'failed' | 'cancelled',
  errorMessage?: string,
): Promise<void> {
  try {
    const startedAt = startTimeCache.get(executionId);
    const durationMs = startedAt ? Date.now() - startedAt : null;
    await prisma.taskExecution.update({
      where: { id: executionId },
      data: { status, completedAt: new Date(), durationMs, errorMessage: errorMessage ?? null },
    });
  } catch (err: any) {
    logger.warn({ executionId, error: err.message }, 'finishExecution failed (non-fatal)');
  } finally {
    jobCache.delete(executionId);
    stepCounter.delete(executionId);
    startTimeCache.delete(executionId);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/lib/taskExecutionRecorder.test.ts --no-coverage 2>&1`

预期：PASS (5 tests)

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts
git commit -m "feat(queue): add taskExecutionRecorder for phase/step tracking"
```

---

## 任务 3：unifiedQueue worker 改造 — 三分支增加执行记录

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts`

- [ ] **步骤 1：添加导入和修改分支**

在文件顶部 `import` 段追加：
```typescript
import { startExecution, updatePhase, finishExecution } from '../lib/taskExecutionRecorder';
```

**回复分支（line 103-135）改造：新增 executionId 传递到 executeReplyAction：**
将：
```typescript
if (task.taskType === 'reply') {
  const { executeReplyAction } = await import('./monitorService');
  ...
  await Promise.race([
    executeReplyAction(task, task.replyData),
    ...
  ]);
}
```
改为：
```typescript
if (task.taskType === 'reply') {
  const { executeReplyAction } = await import('./monitorService');
  let handle: MutexHandle | null = null;
  let executionId: string | undefined;
  try {
    executionId = await startExecution(task, job);
    handle = await WindowMutex.acquireWithBackoff(task.windowId, {
      taskId: task.taskId, taskType: 'reply', traceId: getTraceId(),
    });
    await Promise.race([
      executeReplyAction(task, task.replyData, executionId),
      abortPromise(handle.signal),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`回复超时: 超过 ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS),
      ),
    ]);
    if (executionId) await finishExecution(executionId, 'completed');
    logger.info(`✅ 回复完成: ${task.taskId}`);
  } catch (err: any) {
    if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
    logger.error(`❌ 回复失败: ${task.taskId} - ${err.message}`);
    throw err;
  } finally {
    if (handle) await handle.release().catch(() => {});
  }
  return;
}
```

**发布分支（line 138-191）改造：**
在 `if (task.taskType === 'publish') {` 之后、`let handle` 之前增加：
```typescript
let executionId: string | undefined;
try {
  executionId = await startExecution(task, job);
```

在 `logger.info(`📤 发布任务开始: ${task.taskId} → ${task.platform}`);` 之后增加 updatePhase 调用：
```typescript
await updatePhase(executionId, 1, '登录', 10);
```

在 `const result = await Promise.race([` 之前增加：
```typescript
await updatePhase(executionId, 2, '上传', 40);
```

在 `const result = await Promise.race([` 之后、`await job.updateProgress` 行之后（如果存在）增加但不覆盖；实际上发布分支没有 updateProgress，在 `publisher.publish` 调用后增加：
```typescript
await updatePhase(executionId, 3, '填写信息', 70);
```

在 `await prisma.operationLog.create` 之后、success 判断前增加：
```typescript
await updatePhase(executionId, 4, '发布确认', 95);
```

在 catch 块中 `logger.error` 之前加：
```typescript
if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
```

在 try 块末尾、logger.info 之后加：
```typescript
if (executionId) await finishExecution(executionId, 'completed');
```

**监控分支（line 194-376）改造：**
在 `if (task.taskType === 'monitor') {` 之后、`let handle` 之前增加：
```typescript
let executionId: string | undefined;
try {
  executionId = await startExecution(task, job);
```

在 `logger.info(✅ 监控: ...)` 之前增加：
```typescript
if (executionId) await finishExecution(executionId, result.hasUpdate ? 'completed' : 'completed');
```

在 catch 块中 `logger.error` 之前加：
```typescript
if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
```

> 注意：发布和监控分支改动较多，请仔细比对现有 try-catch-finally 结构，确保 `executionId` 在正确的作用域定义，`startExecution` 在 try 块最前面（还在获取锁之前），`finishExecution` 在成功/失败路径各调用一次。

- [ ] **步骤 2：验证编译**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -30`

预期：无类型错误（或只有项目已有的 LSP 错误，没有新的）

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "feat(queue): add execution phase tracking to unified worker branches"

---

## 任务 4：executeReplyAction 6阶段边界插桩

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：修改函数签名 + 导入**

将 `executeReplyAction` 签名（line 1430-1433）从：
```typescript
export async function executeReplyAction(
  task: MonitorTask,
  replyData: { videoId: string; commentCid: string; text: string },
): Promise<void> {
```
改为：
```typescript
export async function executeReplyAction(
  task: MonitorTask,
  replyData: { videoId: string; commentCid: string; text: string },
  executionId?: string,
): Promise<void> {
```

在文件顶部增加导入：
```typescript
import { updatePhase, recordSelectorTry } from '../lib/taskExecutionRecorder';
```

- [ ] **步骤 2：在各阶段边界插入 updatePhase 调用**

在每个阶段的代码之前插入 updatePhase 调用。关键插入点如下：

**阶段1：准备 — 连接浏览器后（line 1435 之后）**
```typescript
  if (executionId) await updatePhase(executionId, 1, '准备', 5, '连接浏览器');
```

**阶段2：导航 — 各平台导航成功后**
抖音导航后（line 1508 之后 fail path 之前）：`if (executionId) await updatePhase(executionId, 2, '导航', 20, '已导航到评论管理页');`
快手导航后（line 1608 之后 fail path 之前）：同上
视频号导航后（line 1658 之后 fail path 之前）：同上

**阶段3：定位视频 — 各平台视频选择后**
抖音抽屉操作后（line 1529 之后）：`if (executionId) await updatePhase(executionId, 3, '定位视频', 35, '已选择目标视频');`
快手视频选择后（line 1619 之后）：同上
视频号视频切换后（line 1682 之后）：同上

**阶段4：等待评论 — 各平台轮询开始前**
抖音轮询前（line 1534 之前）：`if (executionId) await updatePhase(executionId, 4, '等待评论', 50, '等待评论列表加载');`
快手（在 replyToComment 内部处理，不需额外调用）
视频号（在 replyToComment 内部处理，不需额外调用）

**阶段5：执行回复 — 各平台 replyToComment 调用前**
抖音（line 1585 之前）：`if (executionId) await updatePhase(executionId, 5, '执行回复', 80, '正在执行回复操作');`
快手（line 1633 之前）：同上
视频号（line 1694 之前）：同上

**阶段6：完成 — 各平台成功路径上**
抖音（line 1587-1594 之间 replied 成功后）：`if (executionId) await updatePhase(executionId, 6, '完成', 100, '回复执行完成');`
快手（line 1635-1642 之间 replied 成功后）：同上
视频号（line 1695-1703 之间 replied 成功后）：同上

> 注意：插入 updatePhase 时不要破坏现有 try-catch 结构，updatePhase 内部已有错误保护。

- [ ] **步骤 3：传递 executionId 到三个 crawler 的 replyToComment**

修改抖音调用（line 1586）添加第二个参数传 executionId（先不改变 replyToComment 签名，通过 extra 参数传递）：
实际上 executeReplyAction 此时已有 executionId，需要用某种方式让它传递到 crawler 的 snap 闭包。

最佳方式：在 crawler 的 replyToComment 签名中增加可选的 executionId 参数，然后 snap 闭包使用它。

但这样要改三个 crawler 的签名。更简单的方式：让 `replyToComment` 的 extra 参数（通过 `snap` 的 extra）捎带 executionId。但 snap 闭包目前不接收 executionId。

更实际的做法：等到任务 5 升级 snap 时，让三个 crawler 的 `replyToComment` 新增 `executionId` 参数，在 crawler 内传给 snap 闭包。

**因此本步骤合并到任务 5 一起实现。**

- [ ] **步骤 4：验证编译**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -30`

预期：无新的类型错误（已有的 LSP 错误不相关）

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(reply): add 6-phase tracking to executeReplyAction"
```

---

## 任务 5：snap() 闭包升级 + crawler 传递 executionId

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/replyDebugLogger.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **步骤 1：修改 three crawler replyToComment 签名，增加 executionId 参数**

**douyinCrawler.ts** replyToComment（约 line 3029）：
```typescript
async replyToComment(
  page: Page,
  target: ReplyTarget,
  text: string,
  executionId?: string,
): Promise<boolean>
```

**kuaishouCrawler.ts** replyToComment 同理增加 `executionId?: string`
**tencentCrawler.ts** replyToComment 同理增加 `executionId?: string`

- [ ] **步骤 2：在 executeReplyAction 中传递 executionId**

修改抖音调用（line 1586）：
```typescript
const replied = await douyinCrawler.replyToComment(page, replyTarget, replyData.text, executionId);
```
修改快手调用（line 1634）和视频号调用（line 1695）同理。

- [ ] **步骤 3：升级三个 crawler 的 snap 闭包**

在每个 crawler 的 replyToComment 内，将 snap 闭包升级为：

```typescript
const snap = async (label: string, extra?: Record<string, any>) => {
  if (manifest) {
    stepIdx++;
    await saveDebugSnapshot({ page, stepLabel: label, sessionId, stepIndex: stepIdx, manifest, extra });
    if (executionId) {
      await recordSelectorTry(executionId, label, {
        phase: currentPhase,
        selectors: extra?.selectors || [],
        mouseAction: extra?.mouseAction,
        extra: extra?.context,
      }).catch(() => {});
    }
  }
};
```

注意：需要在文件中导入 `recordSelectorTry`：
在 douyinCrawler.ts 顶部导入：
```typescript
import { recordSelectorTry } from '../lib/taskExecutionRecorder';
```

同时需要确定 `currentPhase` 的来源——每阶段边界在 snap 调用前更新 currentPhase。

由于 updatePhase 已在 executeReplyAction 中调用，crawler 内部不需要重复 updatePhase，但 snap 闭包需要知道当前阶段名。最简单方式：在 snap 闭包上方维持一个本地变量 `let currentPhase = '';`，在关键步骤前手动设置。

在 snap 定义之前添加：
```typescript
let currentPhase = '';
```

在各阶段 snap 调用前设置 currentPhase（每个 crawler 约3-5处关键设置点，只在阶段切换处设置）：

抖音 cryCrawler 的 replyToComment 关键点示例：
```typescript
currentPhase = '导航'; await snap('reply_start');
// ... 导航操作后
currentPhase = '定位视频'; await snap('target_found', ...);
// ... 定位操作后
currentPhase = '等待评论'; await snap('...', ...);
// ... 轮询
currentPhase = '执行回复'; await snap('hover_target', ...);
// ... 回复操作
currentPhase = '完成';
```

对其他两个 crawler 做相同改造。

- [ ] **步骤 4：验证编译**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -30`

预期：无新的类型错误

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/lib/replyDebugLogger.ts \
  apps/ts-api-gateway/src/crawlers/douyinCrawler.ts \
  apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts \
  apps/ts-api-gateway/src/crawlers/tencentCrawler.ts \
  apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(reply): upgrade snap closure with recordSelectorTry for selector tracing"
```

---

## 任务 6：新增 API 端点

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：添加导入**

在文件顶部导入段追加：
```typescript
import { platformQueue } from '../services/unifiedQueue';
// platformQueue 别名，如果已导入 monitorQueue，两者实际上是一个对象
// 但为了清晰，统一使用 platformQueue
```

注意：文件顶部已有 `import { monitorQueue, ... } from '../services/monitorService';` 且 monitorQueue 就是 platformQueue。两种方式都可以用。这里为了统一，追加导入：
```typescript
import { platformQueue } from '../services/unifiedQueue';
```

- [ ] **步骤 2：添加 GET /matrix/queue/active 端点**

在文件末尾 `export default router;` 之前追加：

```typescript
// ============================================================
// 执行队列 API
// ============================================================

/** 获取活跃任务列表（统一三种任务类型） */
router.get('/queue/active', async (_req: Request, res: Response) => {
  try {
    const [active, waiting, delayed] = await Promise.all([
      platformQueue.getJobs(['active']),
      platformQueue.getJobs(['waiting']),
      platformQueue.getJobs(['delayed']),
    ]);

    const allJobs = [...active, ...waiting, ...delayed];
    const seen = new Set<string>();
    const tasks: any[] = [];

    for (const job of allJobs) {
      const bullJobId = job.id;
      const data = job.data as any;
      const taskId = data.taskId || bullJobId || '';
      if (seen.has(taskId)) continue;
      seen.add(taskId);

      let progress: any = null;
      try {
        const p = await job.progress;
        if (p && typeof p === 'object' && 'phase' in p) progress = p;
      } catch {}

      // 尝试从 DB 读取 execution 记录
      let executionId: string | undefined;
      let phaseIndex: number | undefined;
      let totalPhases: number | undefined;
      try {
        const exec = await prisma.taskExecution.findFirst({
          where: { taskId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, phaseIndex: true, totalPhases: true },
        });
        if (exec) {
          executionId = exec.id;
          phaseIndex = exec.phaseIndex ?? undefined;
          totalPhases = exec.totalPhases ?? undefined;
        }
      } catch {}

      tasks.push({
        executionId,
        taskId,
        taskType: data.taskType || 'unknown',
        platform: data.platform || 'unknown',
        status: await job.isActive() ? 'running' : 'queued',
        phaseIndex,
        totalPhases,
        progress,
      });
    }

    const running = tasks.filter(t => t.status === 'running').length;
    res.json({
      success: true,
      data: { total: tasks.length, running, queued: tasks.length - running, tasks },
    });
  } catch (err) {
    handleError(res, logger, err, '获取队列活跃任务失败');
  }
});

/** 获取历史执行记录 */
router.get('/queue/history', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const taskType = req.query.taskType as string | undefined;
    const status = req.query.status as string | undefined;

    const where: any = {};
    if (taskType) where.taskType = taskType;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.taskExecution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, taskId: true, taskType: true, platform: true, userId: true,
          status: true, currentPhase: true, phaseIndex: true, totalPhases: true,
          progressPercent: true, startedAt: true, completedAt: true, durationMs: true,
          errorMessage: true, isDebugMode: true, createdAt: true,
        },
      }),
      prisma.taskExecution.count({ where }),
    ]);

    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    handleError(res, logger, err, '获取队列历史失败');
  }
});

/** 获取单个执行详情（含 steps） */
router.get('/queue/executions/:id', async (req: Request, res: Response) => {
  try {
    const execution = await prisma.taskExecution.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!execution) {
      res.status(404).json({ success: false, error: '执行记录不存在' });
      return;
    }
    res.json({ success: true, data: execution });
  } catch (err) {
    handleError(res, logger, err, '获取执行详情失败');
  }
});
```

- [ ] **步骤 3：验证编译**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -30`

预期：无新的类型错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat(api): add queue active/history/detail endpoints"

---

## 任务 7：每日清理定时任务

**文件：**
- 新建：`apps/ts-api-gateway/src/services/cleanupService.ts`

- [ ] **步骤 1：创建 cleanupService.ts**

创建 `apps/ts-api-gateway/src/services/cleanupService.ts`：

```typescript
// cleanupService.ts - 每日自动清理过期的 TaskExecution 记录和调试快照
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('cleanup');
const DEBUG_DIR = path.resolve(process.cwd(), 'data', 'reply_debug');
const RETENTION_DAYS = 10;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天一次

async function cleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // 清理 DB 记录（TaskExecutionStep 通过 onDelete: Cascade 自动删除）
  const deleted = await prisma.taskExecution.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  logger.info({ deletedCount: deleted.count, cutoff }, '清理过期 TaskExecution 记录');

  // 清理快照目录
  try {
    if (fs.existsSync(DEBUG_DIR)) {
      const dirs = fs.readdirSync(DEBUG_DIR);
      let removedDirs = 0;
      for (const dir of dirs) {
        const dirPath = path.join(DEBUG_DIR, dir);
        try {
          const stat = fs.statSync(dirPath);
          if (stat.isDirectory() && stat.mtime < cutoff) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            removedDirs++;
          }
        } catch {}
      }
      logger.info({ removedDirs, cutoff }, '清理过期快照目录');
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, '清理快照目录失败');
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startCleanupScheduler(): void {
  logger.info('启动每日清理定时器');
  // 启动后先执行一次
  cleanup().catch(err => logger.error({ err: err.message }, '初始清理失败'));
  intervalHandle = setInterval(() => {
    cleanup().catch(err => logger.error({ err: err.message }, '定时清理失败'));
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
```

- [ ] **步骤 2：在主入口注册清理定时器**

找到 API gateway 的主入口文件（如 `apps/ts-api-gateway/src/index.ts` 或 `apps/ts-api-gateway/src/app.ts`），在启动后调用 `startCleanupScheduler()`。

检查入口文件位置：
```bash
ls apps/ts-api-gateway/src/index.ts apps/ts-api-gateway/src/app.ts 2>/dev/null
```

在入口文件的启动逻辑末尾添加：
```typescript
import { startCleanupScheduler } from './services/cleanupService';
startCleanupScheduler();
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/cleanupService.ts
git commit -m "feat(cleanup): add daily cleanup scheduler for expired records and snapshots"
```

---

## 任务 8：前端类型 + hooks

**文件：**
- 新建：`apps/admin-dashboard/src/types/queue.ts`
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：创建队列类型定义**

创建 `apps/admin-dashboard/src/types/queue.ts`：

```typescript
// 队列相关 TypeScript 类型

export type QueueTaskType = 'monitor' | 'publish' | 'reply';

export type QueueTaskStatus = 'running' | 'queued';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  phase: string;
  step?: string;
  percent: number;
  detail?: string;
}

export interface QueueTask {
  executionId?: string;
  taskId: string;
  taskType: QueueTaskType;
  platform: string;
  status: QueueTaskStatus;
  phaseIndex?: number;
  totalPhases?: number;
  progress?: TaskProgress | null;
}

export interface ActiveQueueData {
  total: number;
  running: number;
  queued: number;
  tasks: QueueTask[];
}

export interface ExecutionHistoryItem {
  id: string;
  taskId: string;
  taskType: QueueTaskType;
  platform: string;
  userId: number | null;
  status: ExecutionStatus;
  currentPhase: string | null;
  phaseIndex: number | null;
  totalPhases: number | null;
  progressPercent: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  isDebugMode: boolean;
  createdAt: string;
}

export interface HistoryData {
  items: ExecutionHistoryItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SelectorTry {
  selector: string;
  hit: boolean;
  isPrimary: boolean;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  phase: string;
  stepIndex: number;
  label: string;
  status: 'success' | 'failed' | 'fallback';
  durationMs: number | null;
  selectorTries: SelectorTry[] | null;
  mouseAction: string | null;
  extra: Record<string, any> | null;
  snapshotPath: string | null;
  createdAt: string;
}

export interface ExecutionDetail extends ExecutionHistoryItem {
  steps: ExecutionStep[];
}

// 任务类型对应的显示配置
export const TASK_TYPE_CONFIG: Record<QueueTaskType, { label: string; color: string; icon: string }> = {
  monitor: { label: '视频监控', color: '#10b981', icon: 'monitoring' },
  reply: { label: '回复评论', color: '#f59e0b', icon: 'message-square' },
  publish: { label: '视频发布', color: '#6366f1', icon: 'send' },
};

export const PHASE_LABELS: Record<string, string> = {
  reply: '准备 → 导航 → 定位视频 → 等待评论 → 执行回复 → 完成',
  monitor: 'Phase1 采集视频 → Phase2 采集评论 → Phase3 汇总',
  publish: '登录 → 上传 → 填写信息 → 发布确认',
};
```

- [ ] **步骤 2：在 useApi.ts 中新增 3 个 hooks**

在 `apps/admin-dashboard/src/hooks/useApi.ts` 末尾追加：

```typescript
// ============================================================
// 执行队列
// ============================================================

import type {
  ActiveQueueData,
  HistoryData,
  ExecutionDetail,
} from '../types/queue';

export function useActiveQueueTasks() {
  return useQuery<ActiveQueueData>({
    queryKey: ['queue', 'active'],
    queryFn: () =>
      api.get('/matrix/queue/active').then((r) => r.data.data as ActiveQueueData),
    refetchInterval: 3000,
    retry: 2,
    staleTime: 1000,
  });
}

export function useQueueHistory(params?: { page?: number; limit?: number; taskType?: string; status?: string }) {
  return useQuery<HistoryData>({
    queryKey: ['queue', 'history', params],
    queryFn: () =>
      api.get('/matrix/queue/history', { params }).then((r) => r.data.data as HistoryData),
    retry: 2,
  });
}

export function useExecutionDetail(id: string | null) {
  return useQuery<ExecutionDetail>({
    queryKey: ['queue', 'execution', id],
    queryFn: () =>
      api.get(`/matrix/queue/executions/${id}`).then((r) => r.data.data as ExecutionDetail),
    enabled: !!id,
    retry: 1,
  });
}
```

注意：如果 `useApi.ts` 末尾没有 `import type`，将 import 放在文件顶部已有的 import 段中。检查是否有 `import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';` 并在其后追加类型导入。

- [ ] **步骤 3：验证前端编译**

运行：`cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit 2>&1 | head -20`

预期：无新的类型错误

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/types/queue.ts apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat(frontend): add queue types and hooks for execution tracking"

---

## 任务 9：QueueBar 常驻简略条组件

**文件：**
- 新建：`apps/admin-dashboard/src/components/matrix/QueueBar.tsx`

- [ ] **步骤 1：创建 QueueBar 组件**

创建 `apps/admin-dashboard/src/components/matrix/QueueBar.tsx`：

```tsx
'use client';

import { useActiveQueueTasks } from '../../hooks/useApi';
import { TASK_TYPE_CONFIG, type QueueTask } from '../../types/queue';

interface QueueBarProps {
  onClickViewAll: () => void;
}

export default function QueueBar({ onClickViewAll }: QueueBarProps) {
  const { data, isLoading } = useActiveQueueTasks();
  const tasks = data?.tasks || [];
  const total = data?.total || 0;

  if (isLoading || total === 0) return null;

  return (
    <div
      onClick={onClickViewAll}
      className="flex items-center gap-3 px-4 py-2 mx-4 mb-2 rounded-lg bg-surface-container-high hover:bg-surface-container-higher cursor-pointer transition-colors"
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-lg">⚡</span>
        <span className="text-label-sm font-semibold text-on-surface">执行队列</span>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-error text-[10px] font-bold text-on-error">
          {total}
        </span>
      </div>

      <div className="h-4 w-px bg-outline-variant" />

      <div className="flex items-center gap-2 flex-1 overflow-x-auto no-scrollbar">
        {tasks.map((task: QueueTask) => {
          const config = TASK_TYPE_CONFIG[task.taskType] ?? { label: task.taskType, color: '#94a3b8', icon: 'help' };
          const phaseName = task.progress?.phase || task.taskType;
          const percent = task.progress?.percent ?? 0;
          return (
            <div
              key={task.taskId}
              className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-container"
              style={{ borderLeft: `3px solid ${config.color}` }}
            >
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white shrink-0"
                style={{ backgroundColor: config.color }}
              >
                {config.label}
              </span>
              <span className="text-xs text-on-surface-variant whitespace-nowrap">
                {phaseName} · {percent}%
              </span>
            </div>
          );
        })}
      </div>

      <span className="text-label-sm text-primary shrink-0">查看全部 →</span>
    </div>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/admin-dashboard/src/components/matrix/QueueBar.tsx
git commit -m "feat(frontend): add QueueBar persistent summary component"
```

---

## 任务 10：QueueTab 完整视图组件

**文件：**
- 新建：`apps/admin-dashboard/src/components/matrix/QueueTab.tsx`

- [ ] **步骤 1：创建 QueueTab 组件**

创建 `apps/admin-dashboard/src/components/matrix/QueueTab.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { useActiveQueueTasks, useQueueHistory } from '../../hooks/useApi';
import {
  TASK_TYPE_CONFIG,
  type QueueTask,
  type ExecutionHistoryItem,
  type ExecutionStatus,
} from '../../types/queue';
import ExecutionDetail from './ExecutionDetail';
import StatusPill from '../ui/StatusPill';

export default function QueueTab() {
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTaskType, setHistoryTaskType] = useState<string>('');
  const [historyStatus, setHistoryStatus] = useState<string>('');

  const { data: activeData } = useActiveQueueTasks();
  const { data: historyData } = useQueueHistory({
    page: historyPage,
    limit: 20,
    taskType: historyTaskType || undefined,
    status: historyStatus || undefined,
  });

  if (selectedExecutionId) {
    return (
      <ExecutionDetail
        executionId={selectedExecutionId}
        onBack={() => setSelectedExecutionId(null)}
      />
    );
  }

  const activeTasks = activeData?.tasks || [];
  const historyItems = historyData?.items || [];
  const totalHistory = historyData?.total || 0;
  const totalPages = Math.ceil(totalHistory / 20);

  const statusCount = (status: string) =>
    activeTasks.filter(t => t.status === status).length;

  return (
    <div className="max-w-6xl mx-auto px-4 pb-12">
      {/* 统计卡 */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: '执行中', value: statusCount('running'), color: '#f59e0b' },
          { label: '排队中', value: statusCount('queued'), color: '#64748b' },
          { label: '今日完成', value: activeData ? historyItems.filter(i => i.status === 'completed').length : 0, color: '#10b981' },
          { label: '失败', value: activeData ? historyItems.filter(i => i.status === 'failed').length : 0, color: '#ef4444' },
        ].map(stat => (
          <div key={stat.label} className="rounded-xl bg-surface-container p-4 text-center">
            <div className="text-title-lg font-bold" style={{ color: stat.color }}>{stat.value}</div>
            <div className="text-label-sm text-on-surface-variant">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 活跃任务 */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-title-md font-semibold mb-3">实时活跃</h2>
          <div className="space-y-2">
            {activeTasks.map((task: QueueTask) => {
              const config = TASK_TYPE_CONFIG[task.taskType];
              const percent = task.progress?.percent ?? 0;
              const phaseName = task.progress?.phase || '';
              return (
                <div
                  key={task.taskId}
                  className="rounded-xl bg-surface-container p-4 border border-outline-variant cursor-pointer hover:bg-surface-container-high transition-colors"
                  style={{ borderLeft: `4px solid ${task.status === 'running' ? '#f59e0b' : '#64748b'}` }}
                  onClick={() => task.executionId && setSelectedExecutionId(task.executionId)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-label-sm font-semibold px-2 py-0.5 rounded text-white"
                        style={{ backgroundColor: config?.color || '#94a3b8' }}
                      >
                        {config?.label || task.taskType}
                      </span>
                      <span className="text-label-md font-semibold">{task.platform}</span>
                    </div>
                    <span className="text-label-sm text-on-surface-variant">
                      {task.status === 'running' ? '▶ 执行中' : '⏳ 排队中'}
                    </span>
                  </div>
                  {percent > 0 && (
                    <div>
                      <div className="flex justify-between text-label-sm text-on-surface-variant mb-1">
                        <span>{phaseName}</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${percent}%`, backgroundColor: config?.color || '#94a3b8' }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 历史记录 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-title-md font-semibold">历史记录</h2>
          <div className="flex gap-2">
            <select
              className="rounded-lg bg-surface-container px-3 py-1.5 text-label-sm"
              value={historyTaskType}
              onChange={e => { setHistoryTaskType(e.target.value); setHistoryPage(1); }}
            >
              <option value="">全部类型</option>
              <option value="reply">回复评论</option>
              <option value="monitor">视频监控</option>
              <option value="publish">视频发布</option>
            </select>
            <select
              className="rounded-lg bg-surface-container px-3 py-1.5 text-label-sm"
              value={historyStatus}
              onChange={e => { setHistoryStatus(e.target.value); setHistoryPage(1); }}
            >
              <option value="">全部状态</option>
              <option value="completed">成功</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          {historyItems.map((item: ExecutionHistoryItem) => {
            const config = TASK_TYPE_CONFIG[item.taskType as keyof typeof TASK_TYPE_CONFIG];
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl bg-surface-container px-4 py-3 cursor-pointer hover:bg-surface-container-high transition-colors"
                onClick={() => setSelectedExecutionId(item.id)}
              >
                <span
                  className="text-label-sm font-semibold px-2 py-0.5 rounded text-white shrink-0"
                  style={{ backgroundColor: config?.color || '#94a3b8' }}
                >
                  {config?.label || item.taskType}
                </span>
                <span className="text-label-md flex-1">
                  {item.platform}{item.userId ? ` · 用户${item.userId}` : ''}
                </span>
                <span className="text-label-sm text-on-surface-variant">
                  {item.currentPhase || '-'}
                </span>
                <StatusPill
                  tone={item.status === 'completed' ? 'success' : item.status === 'failed' ? 'error' : 'warning'}
                >
                  {item.status === 'completed' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'cancelled' ? '已取消' : item.status}
                </StatusPill>
                <span className="text-label-sm text-on-surface-variant">
                  {item.durationMs ? `${(item.durationMs / 1000).toFixed(0)}s` : '-'}
                </span>
              </div>
            );
          })}
          {historyItems.length === 0 && (
            <div className="text-center py-8 text-on-surface-variant">暂无历史记录</div>
          )}
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            <button
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40"
              disabled={historyPage <= 1}
              onClick={() => setHistoryPage(p => p - 1)}
            >
              上一页
            </button>
            <span className="px-3 py-1 text-label-sm text-on-surface-variant">
              {historyPage} / {totalPages}
            </span>
            <button
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40"
              disabled={historyPage >= totalPages}
              onClick={() => setHistoryPage(p => p + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

注意：以上代码假设 `StatusPill` 的导入路径是 `../ui/StatusPill`。请根据项目实际路径确认。如果项目使用 `@` alias，可能需要改为 `@/components/ui/StatusPill`。

- [ ] **步骤 2：Commit**

```bash
git add apps/admin-dashboard/src/components/matrix/QueueTab.tsx
git commit -m "feat(frontend): add QueueTab full queue view component"

---

## 任务 11：ExecutionDetail 详情视图组件

**文件：**
- 新建：`apps/admin-dashboard/src/components/matrix/ExecutionDetail.tsx`

- [ ] **步骤 1：创建 ExecutionDetail 组件**

创建 `apps/admin-dashboard/src/components/matrix/ExecutionDetail.tsx`：

```tsx
'use client';

import { useExecutionDetail } from '../../hooks/useApi';
import { TASK_TYPE_CONFIG } from '../../types/queue';
import StatusPill from '../ui/StatusPill';

interface ExecutionDetailProps {
  executionId: string;
  onBack: () => void;
}

export default function ExecutionDetail({ executionId, onBack }: ExecutionDetailProps) {
  const { data, isLoading, error } = useExecutionDetail(executionId);

  if (isLoading) {
    return <div className="p-8 text-center text-on-surface-variant">加载中...</div>;
  }
  if (error || !data) {
    return (
      <div className="p-8 text-center">
        <p className="text-error mb-4">加载失败</p>
        <button onClick={onBack} className="text-primary underline">返回队列</button>
      </div>
    );
  }

  const config = TASK_TYPE_CONFIG[data.taskType as keyof typeof TASK_TYPE_CONFIG];
  const elapsed = data.durationMs ? `${(data.durationMs / 1000).toFixed(0)}s` : '-';

  return (
    <div className="max-w-4xl mx-auto px-4 pb-12">
      {/* 返回按钮 */}
      <button onClick={onBack} className="flex items-center gap-1 text-label-md text-primary mb-4 hover:underline">
        ← 返回队列
      </button>

      {/* 头部 */}
      <div className="rounded-xl bg-surface-container p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span
              className="text-label-md font-semibold px-2.5 py-1 rounded text-white"
              style={{ backgroundColor: config?.color || '#94a3b8' }}
            >
              {config?.label || data.taskType}
            </span>
            <span className="text-title-md font-semibold">{data.platform}</span>
          </div>
          <StatusPill
            tone={data.status === 'completed' ? 'success' : data.status === 'failed' ? 'error' : 'warning'}
          >
            {data.status === 'completed' ? '成功' : data.status === 'failed' ? '失败' : data.status === 'cancelled' ? '已取消' : '执行中'}
          </StatusPill>
        </div>
        <div className="grid grid-cols-2 gap-4 text-label-sm">
          <div>
            <span className="text-on-surface-variant">执行 ID：</span>
            <span className="font-mono text-xs">{data.id}</span>
          </div>
          <div>
            <span className="text-on-surface-variant">任务 ID：</span>
            <span className="font-mono text-xs">{data.taskId}</span>
          </div>
          <div>
            <span className="text-on-surface-variant">开始时间：</span>
            {new Date(data.startedAt).toLocaleString('zh-CN')}
          </div>
          <div>
            <span className="text-on-surface-variant">耗时：</span>
            {elapsed}
          </div>
          {data.errorMessage && (
            <div className="col-span-2">
              <span className="text-on-surface-variant">错误信息：</span>
              <span className="text-error">{data.errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {/* 阶段时间线 */}
      {data.totalPhases && (
        <div className="rounded-xl bg-surface-container p-5 mb-6">
          <h3 className="text-label-md font-semibold mb-3">阶段时间线</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {Array.from({ length: data.totalPhases }, (_, i) => {
              const idx = i + 1;
              const isPast = idx < (data.phaseIndex || 0);
              const isCurrent = idx === (data.phaseIndex || 0);
              return (
                <div key={i} className="flex items-center gap-2">
                  <div
                    className={`px-2.5 py-1 rounded-full text-label-sm font-medium ${
                      isPast ? 'bg-primary/20 text-primary' :
                      isCurrent ? 'bg-primary text-on-primary' :
                      'bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {idx}
                  </div>
                  {idx < data.totalPhases && <span className="text-outline-variant text-xs">→</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 详细步骤（仅 debug 模式） */}
      {data.isDebugMode ? (
        <div className="rounded-xl bg-surface-container p-5">
          <h3 className="text-label-md font-semibold mb-3">详细执行步骤</h3>
          {data.steps && data.steps.length > 0 ? (
            <div className="space-y-2">
              {data.steps.map((step) => (
                <div key={step.id} className="rounded-lg bg-surface-container-high p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-label-sm font-medium">{step.label}</span>
                      {step.status === 'success' && <span className="text-success text-xs">✓</span>}
                      {step.status === 'fallback' && <span className="text-warning text-xs">⚠ 降级</span>}
                      {step.status === 'failed' && <span className="text-error text-xs">✗</span>}
                    </div>
                    <span className="text-label-sm text-on-surface-variant">
                      {step.durationMs ? `${step.durationMs}ms` : ''}
                    </span>
                  </div>

                  {/* 选择器尝试链 */}
                  {step.selectorTries && step.selectorTries.length > 0 && (
                    <div className="mt-1.5 text-label-sm font-mono">
                      {step.selectorTries.map((st: { selector: string; hit: boolean; isPrimary: boolean }, i: number) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className={st.hit ? 'text-success' : 'text-error line-through'}>
                            {st.isPrimary ? '主' : `备${i}`}
                          </span>
                          <span className={st.hit ? 'text-success' : 'text-error'}>{st.selector}</span>
                          <span>{st.hit ? '✓' : '✗'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {step.mouseAction && (
                    <div className="mt-1 text-label-sm text-on-surface-variant">🖱 {step.mouseAction}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-on-surface-variant text-label-sm">该任务执行过程中未记录步骤（无关键操作）</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-surface-container p-5">
          <p className="text-on-surface-variant text-label-sm">
            该任务未在 debug 模式下执行，无详细步骤。开启调试模式后重新执行可查看选择器命中链路。
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/admin-dashboard/src/components/matrix/ExecutionDetail.tsx
git commit -m "feat(frontend): add ExecutionDetail view component with phase timeline and selector chain"
```

---

## 任务 12：matrix/page.tsx 集成 — queue Tab + 常驻条

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：导入新组件**

在文件顶部 import 段追加：
```tsx
import QueueTab from '../../components/matrix/QueueTab';
import QueueBar from '../../components/matrix/QueueBar';
```

- [ ] **步骤 2：扩展 Tab 类型 + 状态**

将 line 135：
```tsx
const [activeTab, setActiveTab] = useState<'users' | 'publish' | 'monitor'>('users');
```
改为：
```tsx
const [activeTab, setActiveTab] = useState<'users' | 'publish' | 'monitor' | 'queue'>('users');
```

- [ ] **步骤 3：在 Tab 栏增加"执行队列"按钮**

在现有 Tab 按钮组（发布管理之后、数据监控之前或之后）增加：
```tsx
<button
  className={cn(
    'flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all relative',
    activeTab === 'queue'
      ? 'bg-primary/10 text-primary shadow-sm'
      : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
  )}
  onClick={() => setActiveTab('queue')}
>
  <MaterialIcon icon="list" size="sm" />
  执行队列
</button>
```

- [ ] **步骤 4：在常驻简略条**

在 `<div>...</div>`（内容区容器）内部、Tab 条件渲染之前增加：
```tsx
{/* 常驻执行队列简略条 */}
<QueueBar onClickViewAll={() => setActiveTab('queue')} />
```

确保 QueueBar 在所有 Tab 上都可见——它应该在 `<div className="max-w-6xl mx-auto px-4 pb-12">` 内部或其外层。

最佳位置：在 `<div className="px-4 pt-4 pb-2">` (Tab 栏容器) 之后、`{activeTab === 'users' && ...}` 条件渲染之前。

- [ ] **步骤 5：增加 queue Tab 的条件渲染**

在 `{activeTab === 'users' && <UsersTab />}` 等条件渲染块之后或之前增加：
```tsx
{activeTab === 'queue' && <QueueTab />}
```

- [ ] **步骤 6：验证前端编译**

运行：`cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit 2>&1 | head -20`

预期：无新的类型错误

- [ ] **步骤 7：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat(frontend): add queue tab and persistent QueueBar to matrix page"

---

## 自检

### 1. 规格覆盖度
- ✅ 数据库模型：TaskExecution + TaskExecutionStep（任务1）
- ✅ 后端阶段追踪：回复6阶段（任务4）、监控3阶段（任务3）、发布4阶段（任务3）
- ✅ taskExecutionRecorder.ts 统一插桩入口（任务2）
- ✅ snap() 闭包升级 + recordSelectorTry（任务5）
- ✅ Debug 模式控制：recordSelectorTry 在 isDebugMode=false 时零开销（任务2）
- ✅ 10天自动清理：cleanupService（任务7）
- ✅ API 端点：active/history/detail（任务6）
- ✅ 前端常驻简略条 QueueBar（任务9）
- ✅ 前端完整队列 Tab QueueTab（任务10）
- ✅ 前端执行详情视图 ExecutionDetail（任务11）
- ✅ matrix/page.tsx 集成（任务12）
- ✅ 执行 ID 展示：ExecutionDetail 头部显示 data.id（任务11）

### 2. 占位符扫描
无 TODO、待定、未完成章节。

### 3. 类型一致性检查
- `taskType`: `'monitor' | 'publish' | 'reply'` — 在 Prisma、后端 API、前端类型中一致
- `status`: `'running' | 'completed' | 'failed' | 'cancelled'` — 全栈一致
- `selectorTries`: `Array<{ selector: string; hit: boolean; isPrimary: boolean }>` — recorder 与前端一致
- `startExecution(task, job)` → `Promise<string>` — 任务2→任务3调用一致
- `updatePhase(executionId, phaseIndex, phaseName, percent, detail?)` — 任务2→任务4调用一致
- `recordSelectorTry(executionId, label, data)` — 任务2→任务5调用一致
- `finishExecution(executionId, status, errorMessage?)` — 任务2→任务3调用一致
- `executeReplyAction(task, replyData, executionId?)` — 任务4→任务5参数名一致

```

```

```

```

```
