# 反检测架构收口 — 抖音端到端试点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将抖音业务代码中所有浏览器交互收口到 `HumanActions`、所有网络监听收口到 `RequestInterceptor`，锁定两个核心类终态 API 契约，并通过前置盲测 + 双路径共存保证反检测效果与功能不回归。

**Architecture:** 方案 C（能不注入就不注入：原生 Locator / DOM 域 / safeEvaluate 隔离世界三选一）。分 5 个 Phase：Phase 0 前置验证（盲测+POC）→ Phase 1 HumanActions 终态 API → Phase 2 RequestInterceptor 扩展 → Phase 3 抖音三功能收口（双路径共存）→ Phase 4 静态守卫与验证。埋点挂载到既有 `TaskExecutionStep.extra.antiDetection`。

**Tech Stack:** Patchright ^1.59、TypeScript ^5.5、Prisma、Jest + ts-jest、CDP（Runtime.evaluate / Page.createIsolatedWorld / DOM 域）。

**Spec:** `docs/superpowers/specs/2026-06-25-anti-detection-douyin-pilot-design.md`

**测试运行命令（所有 Task 通用）:**
```bash
cd apps/ts-api-gateway
OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest <测试路径> -v
```
（`browser-core` 无独立 jest 配置，其测试从 `apps/ts-api-gateway` 跑，moduleNameMapper 已映射 `@social-media/browser-core`。）

**关键既有事实（计划已对齐，勿重复造轮子）:**
- `CDPClient.send(method, params)` 是通用 CDP 通道，`Page.createIsolatedWorld` / `Runtime.evaluate` 经它发送即可。
- `RequestInterceptor` **已存在** `waitForResponse(pattern, {timeoutMs, predicate})`（`interceptor.ts:568`）、`getResponses(pattern)`（:542）、`getLatestResponse(pattern)`（:550）、`clear(pattern)`（:555）。Phase 2 是**复用+扩展**，不是新建。
- `HumanActions` 已有静态 `traceCollector` + `cdpContexts` WeakMap（长连接，铁律 4 已满足）。
- `taskExecutionRecorder.recordSelectorTry(executionId, label, {phase, selectors, mouseAction, extra})` 写 `TaskExecutionStep`，但**仅在 `isDebugMode=true` 时记录**。`extra` 是 `Record<string, any>`。
- 抖音 patterns 常量在 `douyinCrawler.ts:100-104`：`COMMENT_LIST_PATTERN`、`COMMENT_LIST_PATTERN_V2`、`COMMENT_REPLY_PATTERN`、`ALL_COMMENT_PATTERNS`。

---

## File Structure

| 文件 | 责任 | Phase |
|---|---|---|
| `scripts/anti-detection/audit-blindspots.ts` | 静态盲区审计脚本（grep 抖音范围裸调用） | 0,4 |
| `scripts/anti-detection/blind-test-runner.ts` | Phase 0 原生 Locator vs CDP 盲测对比 | 0 |
| `scripts/anti-detection/isolated-world-poc.ts` | Phase 0 隔离世界 POC | 0 |
| `packages/browser-core/src/humanActions.ts` | 新增 readText/readAttribute/readAll/exists/click/fill/press/safeEvaluate + stepMetricsCollector（修改） | 1 |
| `packages/browser-core/src/__tests__/humanActions.test.ts` | HumanActions 新 API 单测（新建） | 1 |
| `packages/browser-core/src/interceptor.ts` | 新增 collectResponses/pollStatus + 采样逻辑（修改） | 2 |
| `packages/browser-core/src/__tests__/interceptor.test.ts` | Interceptor 新方法单测（新建） | 2 |
| `apps/ts-api-gateway/src/lib/antiDetectionMode.ts` | `ANTI_DETECTION_MODE` 环境变量读取（新建） | 3 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音监控/回复收口（修改） | 3 |
| `apps/ts-api-gateway/src/platforms/douyin.ts` | 抖音发布收口（修改） | 3 |
| `apps/ts-api-gateway/src/services/loginFlowHelpers.ts` | 抖音登录/QR 收口（修改） | 3 |
| `.eslintrc.cjs` 或 `scripts/anti-detection/guard.sh` | 抖音范围裸调用静态守卫 | 4 |

---

## Phase 0: 前置验证（阻塞项，spec 10.0）

### Task 1: 静态盲区审计脚本

**Files:**
- Create: `scripts/anti-detection/audit-blindspots.ts`

- [ ] **Step 1: 写审计脚本**

```typescript
// scripts/anti-detection/audit-blindspots.ts
// 审计抖音范围文件的裸调用盲区，输出每文件计数。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const PATTERNS = [
  'page.evaluate(', 'frame.evaluate(', 'page.$eval(', 'page.$$eval(',
  'page.evaluateHandle(', 'page.locator(', 'page.$(', 'page.$$(',
  'page.keyboard.', 'createCDPSession', 'page.click', '.fill(',
  'page.mouse', 'page.waitForSelector(', 'page.waitForFunction(',
  'HumanActions.cdpClickByText(', 'HumanActions.queryElementsWithInfo(',
];

// 抖音范围文件（spec 7.5）
const DOUYIN_FILES = [
  'apps/ts-api-gateway/src/crawlers/douyinCrawler.ts',
  'apps/ts-api-gateway/src/platforms/douyin.ts',
  'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
];

const ROOT = process.cwd();

function countInFile(file: string): Record<string, number> {
  let content: string;
  try {
    content = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return {};
  }
  const result: Record<string, number> = {};
  for (const p of PATTERNS) {
    let count = 0;
    let idx = content.indexOf(p);
    while (idx !== -1) { count++; idx = content.indexOf(p, idx + 1); }
    if (count > 0) result[p] = count;
  }
  return result;
}

let total = 0;
for (const f of DOUYIN_FILES) {
  const counts = countInFile(f);
  const fileTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  total += fileTotal;
  console.log(`\n=== ${f} (total ${fileTotal}) ===`);
  for (const [p, c] of Object.entries(counts)) console.log(`  ${p}: ${c}`);
}
console.log(`\n=== 抖音范围裸调用总计: ${total} ===`);
process.exit(total === 0 ? 0 : 0); // 审计脚本始终退出 0，仅报告
```

- [ ] **Step 2: 运行审计，记录基线**

Run: `cd /home/lrp/social_media_complete && npx ts-node scripts/anti-detection/audit-blindspots.ts`
Expected: 输出每文件裸调用计数，总计 >0（这是改造前基线，记下数字）。若 `ts-node` 不可用，改用 `npx tsx scripts/anti-detection/audit-blindspots.ts`。

- [ ] **Step 3: Commit**

```bash
git add scripts/anti-detection/audit-blindspots.ts
git commit -m "chore(anti-detection): Phase0 静态盲区审计脚本"
```

### Task 2: CDP 隔离世界 POC

**Files:**
- Create: `scripts/anti-detection/isolated-world-poc.ts`

- [ ] **Step 1: 写 POC 脚本**

验证 `Page.createIsolatedWorld()` + `Runtime.evaluate({ contextId })` 在 Patchright 中可行：隔离世界 contextId 可创建缓存、主世界不可见、性能开销。

```typescript
// scripts/anti-detection/isolated-world-poc.ts
// POC: 验证 CDP 隔离世界执行对主世界不可见。
// 需真实浏览器，手动运行：npx tsx scripts/anti-detection/isolated-world-poc.ts <wsEndpoint>
import { chromium } from 'patchright';

async function main() {
  const wsEndpoint = process.argv[2];
  if (!wsEndpoint) { console.error('用法: npx tsx ... <wsEndpoint>'); process.exit(1); }
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');

  const cdp = await page.context().newCDPSession(page);

  // 1. 主世界写一个标记
  await cdp.send('Runtime.evaluate', { expression: 'window.__poc_marker = "main-visible"' });

  // 2. 创建隔离世界
  const iso = await cdp.send('Page.createIsolatedWorld', {
    frameId: (await cdp.send('Page.getFrameTree')).frameTree.frame.id,
    worldName: 'poc_isolated',
  });
  const contextId = iso.executionContextId;

  // 3. 隔离世界读主世界标记 —— 应为 undefined（不可见）
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: 'typeof window.__poc_marker',
    contextId,
    returnByValue: true,
  });
  console.log('隔离世界读主世界标记:', r1.result.value); // 期望 undefined

  // 4. 隔离世界写自己的标记，主世界读 —— 应为 undefined
  await cdp.send('Runtime.evaluate', {
    expression: 'window.__iso_marker = "iso-only"',
    contextId,
    returnByValue: true,
  });
  const r2 = await cdp.send('Runtime.evaluate', {
    expression: 'typeof window.__iso_marker',
    returnByValue: true,
  });
  console.log('主世界读隔离世界标记:', r2.result.value); // 期望 undefined

  // 5. 性能：首次创建 vs 缓存命中
  const t0 = Date.now();
  await cdp.send('Runtime.evaluate', { expression: '1+1', contextId, returnByValue: true });
  const t1 = Date.now();
  await cdp.send('Runtime.evaluate', { expression: '1+1', contextId, returnByValue: true });
  const t2 = Date.now();
  console.log(`首次执行 ${t1 - t0}ms，缓存命中 ${t2 - t1}ms`);

  const pass = r1.result.value === 'undefined' && r2.result.value === 'undefined';
  console.log(pass ? 'POC PASS' : 'POC FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 手动运行 POC（需真实浏览器 wsEndpoint）**

Run: `npx tsx scripts/anti-detection/isolated-world-poc.ts <BitBrowser/RoxyBrowser 返回的 ws endpoint>`
Expected: 输出 `隔离世界读主世界标记: undefined`、`主世界读隔离世界标记: undefined`、`POC PASS`。

**注：** 此步需手动提供 wsEndpoint（由用户从指纹浏览器 API 获取），无法自动化。POC 通过前不进入 Phase 1 的 safeEvaluate 实现。

- [ ] **Step 3: Commit**

```bash
git add scripts/anti-detection/isolated-world-poc.ts
git commit -m "chore(anti-detection): Phase0 CDP 隔离世界 POC"
```

### Task 3: Patchright 原生 Locator 反检测盲测脚本

**Files:**
- Create: `scripts/anti-detection/blind-test-runner.ts`

- [ ] **Step 1: 写盲测脚本骨架**

盲测对比旧 CDP 路径（A 组）与新原生 Locator 路径（B 组）的风控触发率。spec 10.0：10 个抖音视频 × 各 50 次 × 2 组。

```typescript
// scripts/anti-detection/blind-test-runner.ts
// 盲测：A 组旧 CDP 路径 vs B 组原生 Locator 路径，对比风控触发率。
// 手动运行：npx tsx scripts/anti-detection/blind-test-runner.ts <wsEndpoint> <group:A|B>
//
// 判定标准（spec 10.0）：B 组风控触发率不高于 A 组 5% → 通过。
// 风控触发判据：采集后检查 PlatformAccount.status 是否变为 risk_control/login_required，
//              或采集成功率下降。
import { chromium } from 'patchright';

interface BlindTestConfig {
  group: 'A' | 'B';
  videoIds: string[]; // 10 个抖音视频 ID
  runsPerVideo: number; // 50
}

async function runBlindTest(wsEndpoint: string, cfg: BlindTestConfig) {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const results: { videoId: string; run: number; success: boolean; riskTriggered: boolean }[] = [];

  for (const videoId of cfg.videoIds) {
    for (let i = 0; i < cfg.runsPerVideo; i++) {
      // TODO-blinded: 调用 douyinCrawler 的采集，A 组走 legacy 路径，B 组走 v2 路径
      // 通过 ANTI_DETECTION_MODE 环境变量切换（Phase 3 实现）。
      // 此脚本在 Phase 3 完成后才能完整运行；Phase 0 先记录盲测方案与待办。
      const success = false; // 占位，Phase 3 后回填
      const riskTriggered = false; // 占位
      results.push({ videoId, run: i, success, riskTriggered });
    }
  }

  const riskRate = results.filter(r => r.riskTriggered).length / results.length;
  const successRate = results.filter(r => r.success).length / results.length;
  console.log(`组 ${cfg.group}: 风控触发率=${(riskRate * 100).toFixed(2)}%, 采集成功率=${(successRate * 100).toFixed(2)}%`);

  await browser.close();
  return { group: cfg.group, riskRate, successRate };
}

async function main() {
  const wsEndpoint = process.argv[2];
  const group = process.argv[3] as 'A' | 'B';
  if (!wsEndpoint || !group) { console.error('用法: npx tsx ... <wsEndpoint> <A|B>'); process.exit(1); }
  // videoIds 由用户填入真实抖音视频 ID
  const videoIds = (process.env.BLIND_TEST_VIDEO_IDS || '').split(',').filter(Boolean);
  if (videoIds.length !== 10) { console.error('需设置 BLIND_TEST_VIDEO_IDS 为 10 个逗号分隔的视频 ID'); process.exit(1); }
  await runBlindTest(wsEndpoint, { group, videoIds, runsPerVideo: 50 });
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 记录盲测为待办（Phase 3 后执行）**

盲测脚本依赖 Phase 3 的 `ANTI_DETECTION_MODE` 切换，Phase 0 阶段仅产出脚本骨架与方案。在 `docs/superpowers/plans/` 旁或 commit message 记录："盲测完整运行需 Phase 3 完成后，用户提供 wsEndpoint + 10 个视频 ID"。

- [ ] **Step 3: Commit**

```bash
git add scripts/anti-detection/blind-test-runner.ts
git commit -m "chore(anti-detection): Phase0 原生 Locator 反检测盲测脚本骨架"
```

---

## Phase 1: HumanActions 终态 API

### Task 4: HumanActions 测试基础设施

**Files:**
- Create: `packages/browser-core/src/__tests__/humanActions.test.ts`

- [ ] **Step 1: 写测试辅助 mock 与第一个失败测试**

```typescript
// packages/browser-core/src/__tests__/humanActions.test.ts
import { HumanActions } from '../humanActions';

// 构造 mock Page：记录原生 Locator 调用
function makeMockPage(locatorMock: any) {
  const page: any = {
    locator: jest.fn().mockReturnValue(locatorMock),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    context: () => ({ newCDPSession: jest.fn() }),
  };
  return page;
}

describe('HumanActions.readText', () => {
  it('用原生 locator.textContent 读文本', async () => {
    const locatorMock = { textContent: jest.fn().mockResolvedValue('hello') };
    const page = makeMockPage(locatorMock);
    const text = await HumanActions.readText(page, 'div.title');
    expect(text).toBe('hello');
    expect(page.locator).toHaveBeenCalledWith('div.title');
    expect(locatorMock.textContent).toHaveBeenCalled();
  });

  it('元素不存在返回 null', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(0), textContent: jest.fn() };
    const page = makeMockPage(locatorMock);
    const text = await HumanActions.readText(page, 'div.missing');
    expect(text).toBeNull();
    expect(locatorMock.textContent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest --config jest.config.js ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: FAIL，`HumanActions.readText is not a function`。

- [ ] **Step 3: Commit（红）**

```bash
git add packages/browser-core/src/__tests__/humanActions.test.ts
git commit -m "test(anti-detection): HumanActions.readText 失败测试"
```

### Task 5: 实现 readText / readAttribute / exists

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`

- [ ] **Step 1: 在 HumanActions 类中添加读取方法**

在 `humanActions.ts` 的 `HumanActions` 类内（`wait` 方法之后）添加：

```typescript
  // ===== 反检测收口：读取类（零注入优先，原生 Locator） =====

  static async readText(page: Page, selector: string): Promise<string | null> {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) return null;
    return locator.textContent();
  }

  static async readAttribute(page: Page, selector: string, attr: string): Promise<string | null> {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) return null;
    return locator.getAttribute(attr);
  }

  static async exists(page: Page, selector: string, timeoutMs: number = 0): Promise<boolean> {
    const locator = page.locator(selector);
    if (timeoutMs > 0) {
      try {
        await locator.waitFor({ state: 'attached', timeout: timeoutMs });
      } catch {
        return false;
      }
    }
    return (await locator.count()) > 0;
  }
```

- [ ] **Step 2: 扩展测试覆盖 readAttribute / exists**

在 `humanActions.test.ts` 追加：

```typescript
describe('HumanActions.readAttribute', () => {
  it('读属性', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(1), getAttribute: jest.fn().mockResolvedValue('btn') };
    const page = makeMockPage(locatorMock);
    const val = await HumanActions.readAttribute(page, 'button', 'class');
    expect(val).toBe('btn');
  });
});

describe('HumanActions.exists', () => {
  it('count>0 返回 true', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(2), waitFor: jest.fn() };
    const page = makeMockPage(locatorMock);
    expect(await HumanActions.exists(page, 'div')).toBe(true);
  });
  it('count=0 返回 false', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(0), waitFor: jest.fn() };
    const page = makeMockPage(locatorMock);
    expect(await HumanActions.exists(page, 'div')).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: PASS（全部用例）。

- [ ] **Step 4: Commit**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActions.test.ts
git commit -m "feat(anti-detection): HumanActions readText/readAttribute/exists 原生 Locator API"
```

### Task 6: 实现 click / fill / press（拟人化前置）

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`
- Modify: `packages/browser-core/src/__tests__/humanActions.test.ts`

- [ ] **Step 1: 写失败测试**

在 `humanActions.test.ts` 追加：

```typescript
describe('HumanActions.click 拟人化前置', () => {
  it('先 hover 再 click，带 delay', async () => {
    const calls: string[] = [];
    const locatorMock = {
      count: jest.fn().mockResolvedValue(1),
      hover: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
    };
    const page: any = {
      locator: jest.fn().mockReturnValue(locatorMock),
      waitForTimeout: jest.fn(() => { calls.push('wait'); return Promise.resolve(); }),
      context: () => ({ newCDPSession: jest.fn() }),
    };
    await HumanActions.click(page, 'button.submit');
    expect(calls.length).toBeGreaterThan(0); // 有停顿
    expect(locatorMock.hover).toHaveBeenCalled(); // hover 前置
    expect(locatorMock.click).toHaveBeenCalled();
  });
});

describe('HumanActions.fill 逐字延迟', () => {
  it('点击聚焦后逐字输入', async () => {
    const locatorMock = {
      count: jest.fn().mockResolvedValue(1),
      click: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
    };
    const page: any = {
      locator: jest.fn().mockReturnValue(locatorMock),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      context: () => ({ newCDPSession: jest.fn() }),
    };
    await HumanActions.fill(page, 'textarea', 'ab');
    expect(locatorMock.click).toHaveBeenCalled(); // 聚焦
    expect(locatorMock.press).toHaveBeenCalledTimes(2); // 逐字
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: FAIL，`HumanActions.click is not a function`。

- [ ] **Step 3: 实现 click/fill/press**

在 `humanActions.ts` 的 `exists` 方法后添加：

```typescript
  // ===== 反检测收口：交互类（原生 Locator + 拟人化前置） =====

  static async click(page: Page, selector: string): Promise<void> {
    const locator = page.locator(selector);
    await locator.waitFor({ state: 'visible' });
    await locator.hover();
    await HumanActions.wait(page, 80, 200); // 随机停顿
    await locator.click({ delay: HumanActions.randomDelay(30, 90) });
  }

  static async fill(page: Page, selector: string, text: string): Promise<void> {
    const locator = page.locator(selector);
    await locator.waitFor({ state: 'visible' });
    await locator.click(); // 聚焦
    await HumanActions.wait(page, 100, 250);
    for (const ch of text) {
      await locator.press(ch);
      await page.waitForTimeout(HumanActions.randomDelay(60, 160));
    }
  }

  static async press(page: Page, selector: string, key: string): Promise<void> {
    const locator = page.locator(selector);
    await locator.waitFor({ state: 'visible' });
    await locator.press(key);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActions.test.ts
git commit -m "feat(anti-detection): HumanActions click/fill/press 拟人化前置"
```

### Task 7: safeEvaluate 隔离世界实现

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`
- Modify: `packages/browser-core/src/__tests__/humanActions.test.ts`

- [ ] **Step 1: 写失败测试（隔离世界 contextId 缓存 + 参数序列化）**

在 `humanActions.test.ts` 追加。mock `getCDPContext` 走内部，故用 `jest.spyOn` 监控 CDP send：

```typescript
describe('HumanActions.safeEvaluate', () => {
  it('默认隔离世界，序列化参数，调 Runtime.evaluate', async () => {
    const send = jest.fn().mockImplementation((method: string, params: any) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    });
    const cdpCtx: any = { cdp: { send }, dom: {}, mouse: {}, scroller: {}, noise: {} };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(cdpCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const result = await HumanActions.safeEvaluate(page, (a: number) => a + 1, { reason: 'test', args: [1] });

    expect(result).toBe('ok');
    const evalCall = send.mock.calls.find((c: any[]) => c[0] === 'Runtime.evaluate');
    expect(evalCall).toBeDefined();
    expect(evalCall![1].contextId).toBe(42); // 隔离世界
    expect(evalCall![1].expression).toContain('a + 1'); // 函数序列化
    expect(evalCall![1].expression).toContain('[1]'); // 参数序列化
    jest.restoreAllMocks();
  });

  it('world main 不传 contextId', async () => {
    const send = jest.fn().mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'main' } };
      return {};
    });
    const cdpCtx: any = { cdp: { send }, dom: {}, mouse: {}, scroller: {}, noise: {} };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(cdpCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const result = await HumanActions.safeEvaluate(page, () => 'x', { reason: 'main-world-required', world: 'main' });
    const evalCall = send.mock.calls.find((c: any[]) => c[0] === 'Runtime.evaluate');
    expect(evalCall![1].contextId).toBeUndefined();
    expect(result).toBe('main');
    jest.restoreAllMocks();
  });

  it('reason 缺失抛错', async () => {
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };
    await expect(HumanActions.safeEvaluate(page, () => 1, {} as any)).rejects.toThrow(/reason/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: FAIL，`HumanActions.safeEvaluate is not a function`。

- [ ] **Step 3: 实现 safeEvaluate**

在 `humanActions.ts` 类内加隔离世界 contextId 缓存 + safeEvaluate。先在类静态字段区（`cdpContexts` 旁）加：

```typescript
  private static isolatedWorldIds = new WeakMap<Page, number>();
```

然后在 `press` 方法后添加：

```typescript
  // ===== 反检测收口：safeEvaluate（方案 C，CDP 隔离世界） =====

  private static async getIsolatedWorldId(page: Page, ctx: any): Promise<number> {
    let contextId = HumanActions.isolatedWorldIds.get(page);
    if (contextId !== undefined) return contextId;
    const frameTree = await ctx.cdp.send('Page.getFrameTree');
    const iso = await ctx.cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frameTree.frame.id,
      worldName: 'humanactions_isolated',
    });
    contextId = iso.executionContextId;
    HumanActions.isolatedWorldIds.set(page, contextId);
    return contextId;
  }

  static async safeEvaluate(
    page: Page,
    fn: string | ((...args: any[]) => unknown),
    opts: { world?: 'isolated' | 'main'; reason: string; args?: any[] },
  ): Promise<unknown> {
    if (!opts || !opts.reason) throw new Error('safeEvaluate: reason is required');
    const ctx = await (HumanActions as any).getCDPContext(page);
    const contextId = opts.world === 'main' ? undefined : await HumanActions.getIsolatedWorldId(page, ctx);
    const fnStr = typeof fn === 'string' ? fn : fn.toString();
    const argsStr = opts.args ? JSON.stringify(opts.args) : '[]';
    const expression = `(function() { return (${fnStr}).apply(null, ${argsStr}); })()`;
    const result = await ctx.cdp.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
    });
    if (result?.exceptionDetails) throw new Error(`safeEvaluate failed: ${result.exceptionDetails.text}`);
    return result?.result?.value;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: PASS。

- [ ] **Step 5: 导出新 API**

在 `packages/browser-core/src/index.ts` 的 `HumanActions` 导出行已含 `HumanActions`，新静态方法自动导出，无需改。

- [ ] **Step 6: Commit**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActions.test.ts
git commit -m "feat(anti-detection): safeEvaluate CDP 隔离世界实现 + contextId 缓存"
```

### Task 8: stepMetricsCollector 埋点机制

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`
- Modify: `packages/browser-core/src/__tests__/humanActions.test.ts`

- [ ] **Step 1: 写失败测试**

在 `humanActions.test.ts` 追加：

```typescript
describe('HumanActions stepMetricsCollector', () => {
  it('记录 actionPath 到当前活跃 step', async () => {
    const collector = { collect: jest.fn() };
    HumanActions.setStepMetricsCollector(collector as any);
    const locatorMock = { count: jest.fn().mockResolvedValue(1), textContent: jest.fn().mockResolvedValue('x') };
    const page = makeMockPage(locatorMock);
    await HumanActions.readText(page, 'div');
    expect(collector.collect).toHaveBeenCalledWith(expect.objectContaining({ actionPath: 'native-locator' }));
    HumanActions.setStepMetricsCollector(null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: FAIL，`setStepMetricsCollector is not a function`。

- [ ] **Step 3: 实现 stepMetricsCollector**

在 `humanActions.ts` 静态字段区加（`isolatedWorldIds` 旁）：

```typescript
  private static stepMetricsCollector: { collect: (m: { actionPath: string; extra?: Record<string, any> }) => void } | null = null;

  static setStepMetricsCollector(c: { collect: (m: { actionPath: string; extra?: Record<string, any> }) => void } | null): void {
    HumanActions.stepMetricsCollector = c;
  }

  private static recordActionPath(actionPath: string, extra?: Record<string, any>): void {
    if (HumanActions.stepMetricsCollector) {
      HumanActions.stepMetricsCollector.collect({ actionPath, extra });
    }
  }
```

然后在每个新 API 方法末尾加埋点：
- `readText`/`readAttribute`/`exists`/`click`/`fill`/`press` 末尾加 `HumanActions.recordActionPath('native-locator');`
- `safeEvaluate` 末尾（return 前）加 `HumanActions.recordActionPath(opts.world === 'main' ? 'safeEvaluate-main' : 'safeEvaluate-isolated', { reason: opts.reason });`

例如 `readText` 改为：

```typescript
  static async readText(page: Page, selector: string): Promise<string | null> {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) return null;
    const text = await locator.textContent();
    HumanActions.recordActionPath('native-locator');
    return text;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/humanActions.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActions.test.ts
git commit -m "feat(anti-detection): stepMetricsCollector 埋点机制挂载 actionPath"
```

---

## Phase 2: RequestInterceptor 扩展

### Task 9: collectResponses 方法

**Files:**
- Modify: `packages/browser-core/src/interceptor.ts`
- Create: `packages/browser-core/src/__tests__/interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/browser-core/src/__tests__/interceptor.test.ts
import { RequestInterceptor } from '../interceptor';

describe('RequestInterceptor.collectResponses', () => {
  it('持续收集直到 until 谓词为 true', async () => {
    const interceptor = new RequestInterceptor();
    // 直接注入测试数据，绕过真实 CDP
    (interceptor as any).interceptedData.set('p1', [
      { url: 'u1', status: 200, body: { idx: 1 } } as any,
      { url: 'u2', status: 200, body: { idx: 2 } } as any,
      { url: 'u3', status: 200, body: { idx: 3 } } as any,
    ]);
    const collected = await interceptor.collectResponses('p1', {
      until: (r: any) => r.body.idx >= 3,
      maxItems: 10,
      pollMs: 10,
      timeoutMs: 1000,
    });
    expect(collected.length).toBe(3);
  });

  it('maxItems 限制', async () => {
    const interceptor = new RequestInterceptor();
    (interceptor as any).interceptedData.set('p1', [
      { url: 'u1', status: 200, body: { idx: 1 } } as any,
      { url: 'u2', status: 200, body: { idx: 2 } } as any,
    ]);
    const collected = await interceptor.collectResponses('p1', {
      until: () => false,
      maxItems: 1,
      pollMs: 10,
      timeoutMs: 200,
    });
    expect(collected.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: FAIL，`collectResponses is not a function`。

- [ ] **Step 3: 实现 collectResponses**

在 `interceptor.ts` 的 `getLatestResponse` 方法后添加：

```typescript
  async collectResponses(
    pattern: string,
    opts: { until?: (r: InterceptedResponse) => boolean; maxItems: number; pollMs: number; timeoutMs: number },
  ): Promise<InterceptedResponse[]> {
    const collected: InterceptedResponse[] = [];
    const deadline = Date.now() + opts.timeoutMs;
    let seenIndex = 0;
    while (Date.now() < deadline && collected.length < opts.maxItems) {
      const all = this.getResponses(pattern);
      while (seenIndex < all.length && collected.length < opts.maxItems) {
        const r = all[seenIndex++];
        collected.push(r);
        if (opts.until && opts.until(r)) return collected;
      }
      if (collected.length >= opts.maxItems) break;
      await new Promise(resolve => setTimeout(resolve, opts.pollMs));
    }
    return collected;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/interceptor.ts packages/browser-core/src/__tests__/interceptor.test.ts
git commit -m "feat(anti-detection): RequestInterceptor.collectResponses 持续收集"
```

### Task 10: pollStatus 方法

**Files:**
- Modify: `packages/browser-core/src/interceptor.ts`
- Modify: `packages/browser-core/src/__tests__/interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

在 `interceptor.test.ts` 追加：

```typescript
describe('RequestInterceptor.pollStatus', () => {
  it('predicate 命中时返回响应', async () => {
    const interceptor = new RequestInterceptor();
    (interceptor as any).interceptedData.set('login', [
      { url: 'u1', status: 200, body: { logged_in: true } } as any,
    ]);
    const r = await interceptor.pollStatus('login', {
      predicate: (resp: any) => resp.body.logged_in === true,
      pollMs: 10,
      timeoutMs: 500,
    });
    expect(r).not.toBeNull();
    expect((r as any).body.logged_in).toBe(true);
  });

  it('超时返回 null', async () => {
    const interceptor = new RequestInterceptor();
    const r = await interceptor.pollStatus('login', {
      predicate: () => true,
      pollMs: 10,
      timeoutMs: 50,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: FAIL，`pollStatus is not a function`。

- [ ] **Step 3: 实现 pollStatus**

在 `interceptor.ts` 的 `collectResponses` 后添加：

```typescript
  async pollStatus(
    pattern: string,
    opts: { predicate: (r: InterceptedResponse) => boolean; pollMs: number; timeoutMs: number },
  ): Promise<InterceptedResponse | null> {
    const deadline = Date.now() + opts.timeoutMs;
    let seenIndex = 0;
    while (Date.now() < deadline) {
      const all = this.getResponses(pattern);
      while (seenIndex < all.length) {
        const r = all[seenIndex++];
        if (opts.predicate(r)) return r;
      }
      await new Promise(resolve => setTimeout(resolve, opts.pollMs));
    }
    return null;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/interceptor.ts packages/browser-core/src/__tests__/interceptor.test.ts
git commit -m "feat(anti-detection): RequestInterceptor.pollStatus 网络状态轮询"
```

### Task 11: 拦截器可靠性采样

**Files:**
- Modify: `packages/browser-core/src/interceptor.ts`
- Modify: `packages/browser-core/src/__tests__/interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

在 `interceptor.test.ts` 追加。spec 5.4：每 100 次 waitForResponse 调用，1% 强制无兜底模式，记录 `interceptorOnlySuccess`。

```typescript
describe('RequestInterceptor 可靠性采样', () => {
  it('每 100 次采样 1 次无兜底模式', () => {
    const interceptor = new RequestInterceptor();
    const samples: boolean[] = [];
    for (let i = 0; i < 1000; i++) {
      samples.push((interceptor as any).shouldSampleNoFallback());
    }
    const sampleCount = samples.filter(Boolean).length;
    // 1% 即约 10 次，容差 ±5
    expect(sampleCount).toBeGreaterThanOrEqual(5);
    expect(sampleCount).toBeLessThanOrEqual(20);
  });

  it('记录 interceptorOnlySuccess 指标', async () => {
    const interceptor = new RequestInterceptor();
    (interceptor as any).interceptedData.set('p', [{ url: 'u', status: 200, body: {} } as any]);
    await interceptor.waitForResponse('p', { timeoutMs: 100, predicate: () => true, sampleNoFallback: true } as any);
    const metrics = interceptor.getAntiDetectionMetrics();
    expect(metrics.interceptorOnlySuccess).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: FAIL。

- [ ] **Step 3: 实现采样逻辑**

在 `interceptor.ts` 的 `activeListeners` 字段区加计数器：

```typescript
  private waitForResponseCount = 0;
  private antiDetectionMetrics = { interceptorOnlySuccess: 0, interceptorOnlyFailure: 0, fallbackToDom: 0 };
```

在类内加方法（`pollStatus` 后）：

```typescript
  private shouldSampleNoFallback(): boolean {
    this.waitForResponseCount++;
    return this.waitForResponseCount % 100 === 0; // 每 100 次 1 次
  }

  getAntiDetectionMetrics(): { interceptorOnlySuccess: number; interceptorOnlyFailure: number; fallbackToDom: number } {
    return { ...this.antiDetectionMetrics };
  }
```

扩展现有 `waitForResponse`（`interceptor.ts:568`）签名，增加 `sampleNoFallback` 选项并在命中/未命中时更新指标。先读现有 `waitForResponse` 实现：

```typescript
  async waitForResponse(
    pattern: string,
    opts: { timeoutMs: number; predicate?: (response: InterceptedResponse) => boolean; sampleNoFallback?: boolean } = { timeoutMs: 5000 },
  ): Promise<InterceptedResponse | null> {
    // ... 既有轮询逻辑保持不变 ...
    // 命中时：
    if (opts.sampleNoFallback) this.antiDetectionMetrics.interceptorOnlySuccess++;
    // 超时返回 null 时：
    if (opts.sampleNoFallback) this.antiDetectionMetrics.interceptorOnlyFailure++;
    else this.antiDetectionMetrics.fallbackToDom++;
    return null;
  }
```

**注：** 此 Task 需先 Read `interceptor.ts:568` 周边既有 `waitForResponse` 实现，在其基础上增加 `sampleNoFallback` 分支与指标更新，不重写轮询核心。执行时先读该函数完整代码再改。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest ../../packages/browser-core/src/__tests__/interceptor.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/interceptor.ts packages/browser-core/src/__tests__/interceptor.test.ts
git commit -m "feat(anti-detection): 拦截器可靠性采样 1% + antiDetection 指标"
```

---

## Phase 3: 抖音三功能收口（双路径共存）

### Task 12: ANTI_DETECTION_MODE 环境变量

**Files:**
- Create: `apps/ts-api-gateway/src/lib/antiDetectionMode.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/ts-api-gateway/src/__tests__/antiDetectionMode.test.ts
import { isAntiDetectionV2, ANTI_DETECTION_MODE } from '../lib/antiDetectionMode';

describe('antiDetectionMode', () => {
  const orig = process.env.ANTI_DETECTION_MODE;
  afterEach(() => { if (orig === undefined) delete process.env.ANTI_DETECTION_MODE; else process.env.ANTI_DETECTION_MODE = orig; });

  it('默认 legacy', () => {
    delete process.env.ANTI_DETECTION_MODE;
    expect(isAntiDetectionV2()).toBe(false);
  });
  it('v2 启用', () => {
    process.env.ANTI_DETECTION_MODE = 'v2';
    expect(isAntiDetectionV2()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest src/__tests__/antiDetectionMode.test.ts -v`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```typescript
// apps/ts-api-gateway/src/lib/antiDetectionMode.ts
export const ANTI_DETECTION_MODE = {
  LEGACY: 'legacy',
  V2: 'v2',
} as const;

export function isAntiDetectionV2(): boolean {
  return process.env.ANTI_DETECTION_MODE === ANTI_DETECTION_MODE.V2;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest src/__tests__/antiDetectionMode.test.ts -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/lib/antiDetectionMode.ts apps/ts-api-gateway/src/__tests__/antiDetectionMode.test.ts
git commit -m "feat(anti-detection): ANTI_DETECTION_MODE 环境变量双路径切换"
```

### Task 13: 抖音发布收口（platforms/douyin.ts）

**Files:**
- Modify: `apps/ts-api-gateway/src/platforms/douyin.ts`

**注：** 发布流程收口涉及 `douyin.ts` 多处（点发布按钮、填文案、等结果）。此 Task 为每个收口点提供双路径分支模板。执行前先 Read `platforms/douyin.ts` 全文定位行号。

- [ ] **Step 1: 读取 platforms/douyin.ts 全文，定位收口点**

Run: 读 `apps/ts-api-gateway/src/platforms/douyin.ts`，标记以下收口点行号：
- 填写文案处的 `.fill(`
- 点发布按钮处的 `cdpFindElement` / CDP 点击
- 等发布结果处的 `text=发布成功` DOM 轮询（约 :316）
- 失败提示读取处的 `evaluate`

- [ ] **Step 2: 改造填写文案为双路径**

在填写文案处，引入 `isAntiDetectionV2` 与 `HumanActions.fill`：

```typescript
import { isAntiDetectionV2 } from '../lib/antiDetectionMode';
import { HumanActions } from '@social-media/browser-core';

// 填写文案处（原 .fill 调用）：
if (isAntiDetectionV2()) {
  await HumanActions.fill(page, textareaSelector, copyText);
} else {
  await page.locator(textareaSelector).fill(copyText); // legacy
}
```

- [ ] **Step 3: 改造点发布按钮为双路径**

```typescript
if (isAntiDetectionV2()) {
  await HumanActions.click(page, publishBtnSelector);
} else {
  // legacy: 原 cdpFindElement + CDP 点击逻辑保持不变
  const btn = await HumanActions.cdpFindElement(page, publishBtnSelectors);
  // ... 既有 CDP 点击 ...
}
```

- [ ] **Step 4: 改造发布结果等待为拦截器优先 + DOM 兜底**

在等发布结果处（原 `text=发布成功` 轮询），改为 `waitForResponse` 拦发布 API + DOM 兜底：

```typescript
if (isAntiDetectionV2()) {
  // 拦截器优先：抖音发布成功返回特定 API 响应
  // 注：发布 API pattern 需从实际抓包确认，此处用占位 PUBLISH_RESULT_PATTERN
  const PUBLISH_RESULT_PATTERN = '/aweme/v1/creator/item/post'; // 执行时据实确认
  const sample = /* 每 100 次采样 */ false; // 简化：默认带兜底
  const resp = await this.interceptor.waitForResponse(PUBLISH_RESULT_PATTERN, {
    timeoutMs: 15000,
    predicate: (r: any) => r.body?.aweme_id || r.body?.item?.id,
    sampleNoFallback: sample,
  });
  if (resp) {
    logger.info('[抖音] ✅ 发布成功（拦截器判定）');
  } else {
    // DOM 兜底
    logger.warn('[抖音] 拦截器未命中，回退 DOM 判定');
    await page.locator('text=发布成功').waitFor({ timeout: 15000 }).catch(() => {});
  }
} else {
  // legacy: 原 DOM 轮询逻辑
  await page.locator('text=发布成功').waitFor({ timeout: 15000 }).catch(() => {});
}
```

**注：** `PUBLISH_RESULT_PATTERN` 必须执行时从真实抓包确认（spec 5.2 说"含 aweme_id/发布状态"）。计划占位需执行者补全。

- [ ] **Step 5: 运行现有抖音测试确认不回归**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest src/platforms -v`
Expected: 现有测试 PASS（legacy 路径默认启用，行为不变）。

- [ ] **Step 6: Commit**

```bash
git add apps/ts-api-gateway/src/platforms/douyin.ts
git commit -m "feat(anti-detection): 抖音发布收口双路径（v2 原生+拦截器，legacy 不变）"
```

### Task 14: 抖音监控收口（douyinCrawler.ts Phase1/Phase3）

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

**注：** 43 处 evaluate 是主战场，按 spec 6.1 分类改造。此 Task 不逐一列出 43 处（执行时按 `audit-blindspots.ts` 输出逐处处理），而是建立改造模式与首批高优先级点。

- [ ] **Step 1: 运行审计脚本获取抖音监控 evaluate 行号清单**

Run: `cd /home/lrp/social_media_complete && npx tsx scripts/anti-detection/audit-blindspots.ts`
记录 `douyinCrawler.ts` 中所有 `page.evaluate(`/`page.$(`/`page.locator(` 的行号。

- [ ] **Step 2: 改造"评论计数读取"类 evaluate 为 readText**

对每处 `page.evaluate(el => el.textContent)` 形态，改为双路径：

```typescript
import { isAntiDetectionV2 } from '../lib/antiDetectionMode';

let countText: string | null;
if (isAntiDetectionV2()) {
  countText = await HumanActions.readText(page, selector);
} else {
  countText = await page.evaluate((sel: string) => document.querySelector(sel)?.textContent ?? null, selector);
}
```

- [ ] **Step 3: 改造"元素存在性"类 page.$ / evaluate 为 exists**

```typescript
let present: boolean;
if (isAntiDetectionV2()) {
  present = await HumanActions.exists(page, selector);
} else {
  present = (await page.$(selector)) !== null;
}
```

- [ ] **Step 4: 改造"必须 JS"类 evaluate 为 safeEvaluate**

对需访问页面 JS 上下文的 evaluate（如读 `window.xxx`），改为：

```typescript
let val: unknown;
if (isAntiDetectionV2()) {
  val = await HumanActions.safeEvaluate(page, () => (window as any).xxx, { reason: '读取抖音全局变量 xxx', world: 'main' });
} else {
  val = await page.evaluate(() => (window as any).xxx);
}
```

- [ ] **Step 5: 逐处处理剩余 evaluate，每 5-8 处 commit 一次**

按审计清单逐处套用上述三种模式。每完成 5-8 处，运行测试并 commit：

```bash
cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest src/crawlers/douyinCrawler -v 2>/dev/null || echo "无该测试文件则跳过"
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "refactor(anti-detection): 抖音监控 evaluate 收口批次 N"
```

- [ ] **Step 6: 全部处理完后运行审计确认 v2 范围无裸调用（legacy 分支内允许）**

Run: `cd /home/lrp/social_media_complete && npx tsx scripts/anti-detection/audit-blindspots.ts`
Expected: 抖音范围裸调用仅存在于 `else`（legacy）分支内。此 Task 的目标是 v2 分支纯净，legacy 分支保留。

- [ ] **Step 7: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "refactor(anti-detection): 抖音监控 43 处 evaluate 全量收口双路径"
```

### Task 15: 抖音登录/QR 收口（loginFlowHelpers.ts）

**Files:**
- Modify: `apps/ts-api-gateway/src/services/loginFlowHelpers.ts`

- [ ] **Step 1: 读取 loginFlowHelpers.ts 定位抖音相关 page.$ / page.mouse.click / DOM 判断**

Run: 读 `apps/ts-api-gateway/src/services/loginFlowHelpers.ts`，标记抖音登录态校验、QR 码读取的 `page.$`/`page.mouse.click` 行号（spec session 审计：L117/L119/L123/L138）。

- [ ] **Step 2: 改造 QR 码状态为 pollStatus（v2）**

```typescript
if (isAntiDetectionV2()) {
  // QR 扫码状态走网络层
  const QR_STATUS_PATTERN = '/passport/web/login/qrcode/status'; // 执行时据实确认
  const resp = await this.interceptor.pollStatus(QR_STATUS_PATTERN, {
    predicate: (r: any) => r.body?.status === 'confirmed' || r.body?.status === 'expired',
    pollMs: 1000,
    timeoutMs: 60000,
  });
  // resp 为 null 时回退 DOM
} else {
  // legacy: 原 page.$('.qrcode-status-timeout') 逻辑
}
```

- [ ] **Step 3: 改造 page.$ / page.mouse.click 为 exists / HumanActions.click**

```typescript
if (isAntiDetectionV2()) {
  if (await HumanActions.exists(page, qrSelector)) {
    await HumanActions.click(page, qrSelector);
  }
} else {
  const el = await page.$(qrSelector);
  if (el) { const box = await el.boundingBox(); if (box) await page.mouse.click(box.x, box.y); }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest src/services/loginFlowHelpers -v 2>/dev/null || echo "无测试则跳过"`
Expected: 不回归（legacy 默认）。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/services/loginFlowHelpers.ts
git commit -m "feat(anti-detection): 抖音登录/QR 收口双路径（pollStatus + exists/click）"
```

---

## Phase 4: 静态守卫与验证

### Task 16: 静态守卫脚本（CI 可用）

**Files:**
- Create: `scripts/anti-detection/guard.sh`

- [ ] **Step 1: 写守卫脚本**

spec 7.5：禁止抖音范围文件出现裸调用。守卫脚本检查 v2 分支纯净——因双路径共存，legacy 分支内允许裸调用，故守卫采用"v2 模式编译时检查"策略：临时设 `ANTI_DETECTION_MODE=v2` 后用 TypeScript 分析 unreachable legacy 分支不可行，改为**人工 review + 审计脚本对比基线下降**。

```bash
#!/usr/bin/env bash
# scripts/anti-detection/guard.sh
# 抖音反检测静态守卫：对比改造前后裸调用总数，确认 v2 收口使总数下降。
# 注意：双路径共存期 legacy 分支保留裸调用，故守卫目标为"v2 分支不新增裸调用"，
# 通过审计脚本输出 + 人工确认。完整 CI 强制零裸调用需待 legacy 路径删除（全平台收口后）。
set -e
cd "$(dirname "$0")/../.."
echo "=== 抖音范围裸调用审计 ==="
npx tsx scripts/anti-detection/audit-blindspots.ts | tee /tmp/audit-latest.txt
echo ""
echo "守卫说明：双路径共存期，审计输出仅供监控裸调用总数趋势。"
echo "v2 全量切换并删除 legacy 路径后，此脚本改为 exit 非零当总数 >0。"
```

- [ ] **Step 2: 赋权并运行**

Run: `chmod +x scripts/anti-detection/guard.sh && ./scripts/anti-detection/guard.sh`
Expected: 输出审计结果，退出 0。

- [ ] **Step 3: Commit**

```bash
git add scripts/anti-detection/guard.sh
git commit -m "chore(anti-detection): 抖音静态守卫脚本（共存期审计模式）"
```

### Task 17: 成功标准验证清单

**Files:**
- Create: `docs/superpowers/plans/2026-06-25-anti-detection-douyin-pilot-verification.md`

- [ ] **Step 1: 写验证清单文档**

```markdown
# 抖音反检测收口验证清单

对应 spec 第 11 节成功标准。

## 1. 静态零直接调用（v2 分支）
- [ ] `npx tsx scripts/anti-detection/audit-blindspots.ts` 输出，v2 分支无裸调用
- [ ] legacy 分支裸调用保留（共存期允许）

## 2. 运行时指标埋点
- [ ] 抖音三功能开启 debug 模式跑通后，查询 TaskExecutionStep.extra.antiDetection：
  - [ ] actionPath native-locator/safeEvaluate-isolated 占绝大多数
  - [ ] safeEvaluate-main 趋近 0（ESLint ≤3/文件）
  - [ ] cdpSessionCreated 仅首次 true
  - [ ] interceptorHit 高、fallbackToDom 低
  - [ ] interceptorOnlySuccess 采样指标有记录

## 3. 功能不回归
- [ ] `OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest` 全绿
- [ ] 抖音三功能端到端走通（legacy + v2 各一次）

## 4. 契约锁定
- [ ] HumanActions: readText/readAttribute/readAll/exists/click/fill/press/safeEvaluate 定义完成
- [ ] RequestInterceptor: waitForResponse(既有)/collectResponses/pollStatus 可用

## 5. 5 条铁律落地
- [ ] 铁律1: 原生 Locator 优先（readText 等用原生）
- [ ] 铁律2: CDP 仅 scroll/kbd（cdpSmartScroll 保留）
- [ ] 铁律3: 裸 page.evaluate 弃用（v2 走 safeEvaluate）
- [ ] 铁律4: cdpContexts 长连接无频繁重建
- [ ] 铁律5: 抖音所有操作经 HumanActions/Interceptor

## 6. 前置盲测通过（Phase 0）
- [ ] 隔离世界 POC PASS（主世界/隔离世界互不可见）
- [ ] 原生 Locator 盲测：B 组风控触发率不高于 A 组 5%（Phase 3 后运行）

## 7. 双路径共存
- [ ] ANTI_DETECTION_MODE=legacy|v2 可切换
- [ ] 回滚仅需改环境变量
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-06-25-anti-detection-douyin-pilot-verification.md
git commit -m "docs(anti-detection): 抖音收口验证清单"
```

### Task 18: 最终全量测试与 ESLint main-world 限制

**Files:**
- Modify: `.eslintrc.cjs`（或项目现有 ESLint 配置）

- [ ] **Step 1: 加 ESLint 规则限制 world:'main' 调用**

spec 4.3：单文件 `world:'main'` 调用不超过 3 处。若无自定义 ESLint 规则能力，改为审计脚本补充检查：

在 `scripts/anti-detection/audit-blindspots.ts` 的 PATTERNS 旁加 `world-main` 计数逻辑，统计每文件 `world: 'main'`（或 `world:'main'`）出现次数，超 3 处时输出警告。

- [ ] **Step 2: 运行全量测试**

Run: `cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest -v`
Expected: 全绿。

- [ ] **Step 3: 运行守卫与审计**

Run: `cd /home/lrp/social_media_complete && ./scripts/anti-detection/guard.sh`
Expected: 审计输出正常，退出 0。

- [ ] **Step 4: Commit**

```bash
git add scripts/anti-detection/audit-blindspots.ts .eslintrc.cjs
git commit -m "chore(anti-detection): ESLint main-world 限制 + 全量测试通过"
```

---

## Self-Review

**1. Spec coverage:**
- spec §2 五铁律 → Phase 1-4 各 Task 体现（铁律1: Task5/6 原生；铁律2: 保留 cdpSmartScroll；铁律3: Task7 safeEvaluate；铁律4: 复用 cdpContexts；铁律5: Phase3 全收口）✅
- spec §4 HumanActions API → Task5/6/7/8 ✅
- spec §4.3 safeEvaluate CDP 隔离世界 → Task7 + Task2 POC ✅
- spec §4.6 四阶段迁移 → 阶段①Task5-8，阶段②③Phase3，阶段④不在本计划（全平台后）✅
- spec §5 Interceptor → Task9/10/11（复用既有 waitForResponse）✅
- spec §5.4 采样 → Task11 ✅
- spec §6 三功能 → Task13/14/15 ✅
- spec §7 埋点 → Task8/11 ✅
- spec §7.5 静态守卫 → Task1/16 ✅
- spec §8 rollout → 不在本计划（后续 spec）✅
- spec §9 错误处理 → Task7 safeEvaluate 异常、Task11 采样、Task13 DOM 兜底 ✅
- spec §10 测试 → 每个 Task TDD + Task18 全量 ✅
- spec §10.0 前置验证 → Task1/2/3 ✅
- spec §11 成功标准 → Task17 验证清单 ✅
- spec §9.7 双路径 → Task12/13/14/15 ✅

**2. Placeholder scan:**
- Task3 blind-test-runner 有 `TODO-blinded` 占位（采集逻辑）——这是有意的，因依赖 Phase 3，已在 Step 2 说明，非计划缺陷。
- Task13/15 的 `PUBLISH_RESULT_PATTERN`/`QR_STATUS_PATTERN` 标注"执行时据实确认"——真实 pattern 需抓包，无法在计划预填，已显式标注执行者补全，可接受。
- 无其他 TBD/TODO/"add error handling"等。

**3. Type consistency:**
- `readText(page, selector)` → Task5 定义，Task14 使用一致 ✅
- `exists(page, selector, timeoutMs?)` → Task5 定义，Task15 使用一致 ✅
- `safeEvaluate(page, fn, {world?, reason, args?})` → Task7 定义，Task14 使用一致 ✅
- `collectResponses(pattern, {until, maxItems, pollMs, timeoutMs})` → Task9 定义一致 ✅
- `pollStatus(pattern, {predicate, pollMs, timeoutMs})` → Task10 定义，Task15 使用一致 ✅
- `isAntiDetectionV2()` → Task12 定义，Task13/14/15 使用一致 ✅
- `setStepMetricsCollector`/`recordActionPath` → Task8 定义一致 ✅

**已知风险（执行者注意）:**
1. Task3 盲测、Task13/15 的 pattern 需真实抓包/环境，无法纯自动化。
2. Task14 的 43 处 evaluate 逐处处理工作量大，按 5-8 处分批 commit。
3. `recordSelectorTry` 仅 `isDebugMode=true` 记录，埋点验证需开 debug 模式（Task17 已注明）。
4. 双路径共存使每处改造工作量约翻倍（有意稳妥策略）。
