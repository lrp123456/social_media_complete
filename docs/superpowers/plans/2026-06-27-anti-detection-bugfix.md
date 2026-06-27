# 反检测收口后静默成功/回复卡死根因修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复收口/反检测优化后的两个缺陷——监控任务连接失败时静默标 completed、抖音回复因 99999 无界滚动卡死不结束。

**Architecture:** 精准根因修复，不扩大范围。缺陷1让连接失败/锁未获取正确抛错并标 failed（复用现有 BullMQ 重试与 TaskExecution 状态机）；缺陷2将 `scrollCommentArea` 的 `'top'/'bottom'` 改为有界+到顶/到底即停、给 `scrollExpandAndFindTarget` 加总预算、给 `replyToComment` 调用加 step 级超时。

**Tech Stack:** TypeScript (ts-api-gateway, jest + ts-jest + supertest)、browser-core (HumanActions/cdpScroller)、Prisma。

**规格依据:** `docs/superpowers/specs/2026-06-27-anti-detection-bugfix-design.md`

---

## 文件结构

- 修改 `apps/ts-api-gateway/src/services/monitorService.ts` — `executeMonitorCheck` connect catch（L942-949）改 throw；`executeReplyAction` 抖音分支 `replyToComment` 调用（L2132）加 step 超时。
- 修改 `apps/ts-api-gateway/src/services/unifiedQueue.ts` — 监控(L261-265)/回复(L150-154)/发布(L188-192)三处 `tryAcquireOnce` null 检查。
- 修改 `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` — `scrollCommentArea`(L3561-3579) 去无界化；`scrollExpandAndFindTarget`(L4953-5051) 加总预算。
- 新增测试 `apps/ts-api-gateway/src/services/__tests__/connectFailure.test.ts`
- 新增测试 `apps/ts-api-gateway/src/services/__tests__/lockNullCheck.test.ts`
- 新增测试 `apps/ts-api-gateway/src/crawlers/__tests__/scrollBounded.test.ts`
- 新增测试 `apps/ts-api-gateway/src/crawlers/__tests__/findTargetBudget.test.ts`
- 新增测试 `apps/ts-api-gateway/src/services/__tests__/replyStepTimeout.test.ts`

---

## Task 1: 监控连接失败改为抛错（缺陷1主因）

**Files:**
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts:942-949`
- Test: `apps/ts-api-gateway/src/services/__tests__/connectFailure.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/ts-api-gateway/src/services/__tests__/connectFailure.test.ts`：

```typescript
import { executeMonitorCheck } from '../monitorService';

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({
    connect: jest.fn().mockRejectedValue(new Error('CDP connection refused')),
    disconnectSession: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/prisma', () => ({ prisma: {} }));

describe('executeMonitorCheck connect failure', () => {
  it('throws on connect failure instead of returning empty result', async () => {
    const task = { userId: 1, platform: 'douyin', windowId: 'fp_test', taskId: 'mon_test' } as any;
    await expect(executeMonitorCheck(task)).rejects.toThrow('连接指纹浏览器失败');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/connectFailure.test.ts`
Expected: FAIL（当前实现 return 而非 throw，测试期望 reject 会超时/失败）

- [ ] **Step 3: 修改实现**

将 `monitorService.ts:942-949` 的 catch 块改为 throw：

```typescript
  } catch (connectErr: any) {
    logger.error({ userId: task.userId, windowId: task.windowId, err: connectErr.message }, '连接指纹浏览器失败');
    onProgress?.({ phase: '连接', step: '连接失败', percent: 0, detail: connectErr.message });
    // 清理残留连接
    try { bm.disconnectSession(String(task.windowId), task.platform as any).catch(() => {}); } catch {}
    // 抛错：让 handleJob 标记 failed 并触发 BullMQ 重试，不再静默标 completed
    throw new Error('连接指纹浏览器失败: ' + connectErr.message);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/connectFailure.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/__tests__/connectFailure.test.ts
git commit -m "fix(monitor): 连接失败改为抛错，不再静默标 completed

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: tryAcquireOnce 返回 null 时抛错（缺陷1次因）

**Files:**
- Modify: `apps/ts-api-gateway/src/services/unifiedQueue.ts:150-154, 188-192, 261-265`
- Test: `apps/ts-api-gateway/src/services/__tests__/lockNullCheck.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/ts-api-gateway/src/services/__tests__/lockNullCheck.test.ts`：

```typescript
jest.mock('../../lib/redlock', () => ({
  WindowMutex: {
    tryAcquireOnce: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../taskExecutionRecorder', () => ({
  startExecution: jest.fn().mockResolvedValue('exec_test'),
  finishExecution: jest.fn().mockResolvedValue(undefined),
  updatePhase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/prisma', () => ({ prisma: { operationLog: { create: jest.fn() } } }));

describe('handleJob lock-null handling', () => {
  it('throws when window lock cannot be acquired (monitor)', async () => {
    const { handleJobForTest } = require('../unifiedQueue');
    const job = { id: 'j1', data: { taskType: 'monitor', taskId: 'mon_t', userId: 1, platform: 'douyin', windowId: 'fp_w' }, updateProgress: jest.fn() } as any;
    await expect(handleJobForTest(job)).rejects.toThrow('窗口锁占用中');
  });
});
```

> 注：`handleJob` 当前未导出。Step 3 会新增 `export async function handleJobForTest(job)` 薄包装供测试调用；若不希望导出内部函数，可改为导出 `handleJob` 本身。本计划采用导出 `handleJobForTest` 最小暴露。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/lockNullCheck.test.ts`
Expected: FAIL（`handleJobForTest` 不存在 / null 未被检查导致后续逻辑报错而非"窗口锁占用中"）

- [ ] **Step 3: 修改实现**

在 `unifiedQueue.ts` 的 `handleJob` 函数体末尾（`}` 闭合前，约 L419）之后新增测试导出：

```typescript
// 仅供单元测试调用
export async function handleJobForTest(job: Job<PlatformTask>): Promise<any> {
  return handleJob(job);
}
```

在三处 `tryAcquireOnce` 调用后补 null 检查。

**回复分支（L150-154 后插入）：**

```typescript
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
        taskId: task.taskId,
        taskType: 'reply',
        traceId: getTraceId(),
      });
      if (!handle) {
        throw new Error('窗口锁占用中，跳过: ' + task.windowId);
      }
```

**发布分支（L188-192 后插入）：**

```typescript
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
        taskId: task.taskId,
        taskType: 'publish',
        traceId: getTraceId(),
      });
      if (!handle) {
        throw new Error('窗口锁占用中，跳过: ' + task.windowId);
      }
```

**监控分支（L261-265 后插入）：**

```typescript
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
        taskId: task.taskId,
        taskType: 'monitor',
        traceId: getTraceId(),
      });
      if (!handle) {
        throw new Error('窗口锁占用中，跳过: ' + task.windowId);
      }
```

三处 catch 块已统一 `finishExecution(failed)` + `throw err`，新增抛错会正确进入这些路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/lockNullCheck.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts apps/ts-api-gateway/src/services/__tests__/lockNullCheck.test.ts
git commit -m "fix(queue): tryAcquireOnce 返回 null 时抛错，避免无锁裸跑

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: scrollCommentArea 去无界化（缺陷2主因）

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:3561-3579`
- Test: `apps/ts-api-gateway/src/crawlers/__tests__/scrollBounded.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/ts-api-gateway/src/crawlers/__tests__/scrollBounded.test.ts`：

```typescript
const cdpSmartScrollMock = jest.fn().mockResolvedValue(undefined);
const evaluateMock = jest.fn();

jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
    wait: jest.fn().mockResolvedValue(undefined),
  },
}));

import { DouyinCrawler } from '../douyinCrawler';

describe('scrollCommentArea bounded', () => {
  it('top: stops when scrollTop<=0, never passes 99999', async () => {
    // 第一轮 evaluate 返回已到顶
    evaluateMock.mockResolvedValue({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });
    const page = { evaluate: evaluateMock } as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'top');

    // cdpSmartScroll 入参不应出现 99999
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
    expect(cdpSmartScrollMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('bottom: stops when at bottom', async () => {
    evaluateMock.mockResolvedValue({ scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 });
    const page = { evaluate: evaluateMock } as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'bottom');
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
  });
});
```

> 注：`DouyinCrawler` 的构造签名以仓库实际为准；若构造需要参数，按现有 `getDouyinCrawler` 工厂调整。测试用 `(crawler as any).scrollCommentArea` 访问私有方法。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/__tests__/scrollBounded.test.ts`
Expected: FAIL（当前 `scrollCommentArea('top')` 传 99999，断言 `toBeLessThan(99999)` 失败）

- [ ] **Step 3: 修改实现**

将 `douyinCrawler.ts:3561-3579` 的 `scrollCommentArea` 改为：

```typescript
  private async scrollCommentArea(page: Page, direction: 'bottom' | 'top' | number): Promise<boolean> {
    const t0 = Date.now();
    const selectors = [
      '.douyin-creator-interactive-tabs-content',
      '[class*="tabs-content"][class*="top"]',
      '[class*="tabs-pane-active"]',
    ];

    const SCROLL_BOUNDED_PX = 3000;
    const SCROLL_MAX_ROUNDS = 8;

    // 数字入参：保持原有行为（已是有界值）
    if (typeof direction === 'number') {
      await HumanActions.cdpSmartScroll(page, selectors, Math.abs(direction), direction >= 0 ? 'down' : 'up');
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      logger.info({ direction, totalMs: Date.now() - t0 }, '[scrollCommentArea] Completed');
      return true;
    }

    // 'top' / 'bottom'：有界滚动 + 到顶/到底即停
    const dir = direction === 'top' ? 'up' : 'down';
    for (let round = 0; round < SCROLL_MAX_ROUNDS; round++) {
      await HumanActions.cdpSmartScroll(page, selectors, SCROLL_BOUNDED_PX, dir);
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

      // 读取容器滚动状态，判断是否到顶/到底
      let state: { scrollTop: number; scrollHeight: number; clientHeight: number } | null = null;
      try {
        state = await page.evaluate((sels: string[]) => {
          for (const s of sels) {
            const el = document.querySelector(s) as HTMLElement | null;
            if (el) return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
          }
          return null;
        }, selectors);
      } catch (evalErr: any) {
        // evaluate 失败：降级为按有界量滚动一轮即返回，不阻塞主流程
        logger.warn({ err: evalErr.message }, '[scrollCommentArea] state read failed, bounded return');
        break;
      }

      if (!state) break;
      if (direction === 'top' && state.scrollTop <= 0) break;
      if (direction === 'bottom' && state.scrollTop + state.clientHeight >= state.scrollHeight - 10) break;
    }

    logger.info({ direction, totalMs: Date.now() - t0 }, '[scrollCommentArea] Completed');
    return true;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/__tests__/scrollBounded.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/__tests__/scrollBounded.test.ts
git commit -m "fix(douyin): scrollCommentArea 去无界化，到顶/到底即停

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: scrollExpandAndFindTarget 加总预算（缺陷2放大因）

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:4953-5051`
- Test: `apps/ts-api-gateway/src/crawlers/__tests__/findTargetBudget.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/ts-api-gateway/src/crawlers/__tests__/findTargetBudget.test.ts`：

```typescript
jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    cdpSmartScroll: jest.fn().mockResolvedValue(undefined),
    wait: jest.fn().mockImplementation(() => new Promise(r => setTimeout(r, 50))),
  },
}));

import { DouyinCrawler } from '../douyinCrawler';

describe('scrollExpandAndFindTarget budget', () => {
  it('breaks within budget when search is slow (does not run full 30 rounds)', async () => {
    const crawler = new DouyinCrawler('fp_test') as any;
    // findRootCommentByUsernameContent 永远找不到，tryExpandMoreAndScroll 永远返回 true（不停滚）
    crawler.findRootCommentByUsernameContent = jest.fn().mockResolvedValue(null);
    crawler.tryExpandMoreAndScroll = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 4000)); // 每轮 4s
      return true;
    });
    crawler.finalSweepByUsernameContent = jest.fn().mockResolvedValue(null);
    crawler.scrollCommentArea = jest.fn().mockResolvedValue(true);

    const target = { username: 'u', text: 't', level: 1 } as any;
    const start = Date.now();
    const result = await crawler.scrollExpandAndFindTarget({} as any, target);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // 预算 90s，每轮 4s → 应在 ~24 轮内退出，远小于 30 轮的 120s
    expect(elapsed).toBeLessThan(100_000);
    expect(crawler.tryExpandMoreAndScroll.mock.calls.length).toBeLessThan(30);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/__tests__/findTargetBudget.test.ts`
Expected: FAIL（无预算，会跑满 30 轮约 120s，`elapsed < 100_000` 与 `calls.length < 30` 失败；jest 默认 5s 超时也会先触发）

- [ ] **Step 3: 修改实现**

在 `douyinCrawler.ts:4964` 附近（`const MAX_SCROLL = 30;` 之后）新增预算常量与循环内检查：

```typescript
    const MAX_SCROLL = 30;
    const FIND_TARGET_BUDGET_MS = 90_000;
    const startT0 = Date.now();
```

> `startT0` 已在 L4965 存在；若已存在则不重复声明，仅新增 `FIND_TARGET_BUDGET_MS`。

在 for 循环体开头（L4974 `for (...) {` 之后、`await snap?.('scroll_round_...')` 之前）插入预算检查：

```typescript
    for (let scrollRound = 0; scrollRound < MAX_SCROLL; scrollRound++) {
      if (Date.now() - startT0 > FIND_TARGET_BUDGET_MS) {
        logger.info({ scrollRound, elapsedMs: Date.now() - startT0 }, '[Reply::Find] Budget exceeded, early exit');
        break;
      }
      await snap?.('scroll_round_' + (scrollRound + 1));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/__tests__/findTargetBudget.test.ts --testTimeout=120000`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/__tests__/findTargetBudget.test.ts
git commit -m "fix(douyin): scrollExpandAndFindTarget 加 90s 总预算，超预算提前退出

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: replyToComment 调用加 step 级超时（缺陷2兜底）

**Files:**
- Modify: `apps/ts-api-gateway/src/services/monitorService.ts:2132`
- Test: `apps/ts-api-gateway/src/services/__tests__/replyStepTimeout.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/ts-api-gateway/src/services/__tests__/replyStepTimeout.test.ts`：

```typescript
jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({
    connect: jest.fn().mockResolvedValue({ browser: {}, page: { url: () => 'https://creator.douyin.com' } }),
    disconnectSession: jest.fn(),
  }),
}));

jest.mock('../taskExecutionRecorder', () => ({
  updatePhase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    comment: { findFirst: jest.fn().mockResolvedValue(null) },
    videoRootCommentCount: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

// mock douyinCrawler：replyToComment 永挂
const replyToCommentMock = jest.fn().mockImplementation(() => new Promise(() => {}));
jest.mock('../crawlers/douyinCrawler', () => ({
  getDouyinCrawler: () => ({
    navigateToCreatorHome: jest.fn(),
    navigateToCommentManage: jest.fn().mockResolvedValue(true),
    replyToComment: replyToCommentMock,
  }),
  DouyinCrawler: class {},
}));

import { executeReplyAction } from '../monitorService';

describe('executeReplyAction douyin step timeout', () => {
  it('rejects with timeout when replyToComment hangs', async () => {
    const task = { userId: 1, platform: 'douyin', windowId: 'fp_test', taskId: 'reply_test' } as any;
    const replyData = { videoId: 'v1', commentCid: 'c1', text: 'hi' };
    await expect(executeReplyAction(task, replyData, 'exec_test')).rejects.toThrow('定位/执行回复超时');
  }, 15000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/replyStepTimeout.test.ts`
Expected: FAIL（当前无 step 超时，`replyToComment` 永挂 → jest 超时，而非 reject"定位/执行回复超时"）

- [ ] **Step 3: 修改实现**

在 `monitorService.ts` 文件顶部常量区（与其他超时常量同区域，或在 `executeReplyAction` 内）新增：

```typescript
const REPLY_STEP_TIMEOUT_MS = 120_000; // replyToComment 单步超时（2min），外层 5min 之外的更细兜底
```

将 `monitorService.ts:2132` 的调用改为 `Promise.race`：

```typescript
      const replied = await Promise.race([
        dy.replyToComment(page, replyTarget, replyData.text, executionId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('定位/执行回复超时')), REPLY_STEP_TIMEOUT_MS),
        ),
      ]);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/replyStepTimeout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/__tests__/replyStepTimeout.test.ts
git commit -m "fix(reply): replyToComment 加 2min step 超时，避免永挂

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 全量回归与类型检查

**Files:** 无修改

- [ ] **Step 1: 运行全部新增测试**

Run: `cd apps/ts-api-gateway && npx jest src/services/__tests__/connectFailure.test.ts src/services/__tests__/lockNullCheck.test.ts src/crawlers/__tests__/scrollBounded.test.ts src/crawlers/__tests__/findTargetBudget.test.ts src/services/__tests__/replyStepTimeout.test.ts --testTimeout=120000`
Expected: 全部 PASS

- [ ] **Step 2: TypeScript 类型检查**

Run: `cd apps/ts-api-gateway && npx tsc --noEmit`
Expected: 无新增错误（已有的非相关错误可忽略，关注本次改动文件 `monitorService.ts`/`unifiedQueue.ts`/`douyinCrawler.ts` 无类型错误）

- [ ] **Step 3: 运行现有测试套件确认无回归**

Run: `cd apps/ts-api-gateway && npx jest --testTimeout=120000`
Expected: 无新增失败（监控/回复相关测试若因 mock 边界失败，按需调整 mock，不改业务行为）

- [ ] **Step 4: 提交（如有测试 mock 调整）**

```bash
git add -A
git commit -m "test: 回归修复后测试 mock 对齐

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（无调整则跳过此步）

---

## Task 7: e2e 手动验证

**Files:** 无修改

- [ ] **Step 1: 验证缺陷1**

用复现样本对应的真实窗口触发监控任务（connect 故意失败场景，如关闭指纹浏览器窗口）：
- 确认 TaskExecution 标 `failed`（非 `completed`）
- 日志含"连接指纹浏览器失败"
- `operationLog` 记 failure
- 5min 后 BullMQ 重试一次（`attempts: 2`）

- [ ] **Step 2: 验证缺陷2**

用复现样本的评论 cid 触发抖音回复：
- 确认任务在 ~2min 内 fail-fast（step 超时）或在 ~90s 内因预算退出
- `durationMs` 正常写入，前台耗时正常显示，不再"耗时 -"
- `scrollCommentArea` 日志显示 `totalMs` 显著下降（不再 20-60s）

- [ ] **Step 3: 记录验证结果**

将验证结果（执行 ID、耗时、状态）追加到本计划文件末尾或单独验证记录。
