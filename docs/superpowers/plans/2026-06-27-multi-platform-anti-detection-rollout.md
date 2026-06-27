# 多平台反检测收口 Rollout 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将腾讯/快手/小红书三平台业务代码的浏览器交互与网络监听 100% 收口到 `HumanActions`/`RequestInterceptor`，并织入维护探针，达到与抖音样板同等的「反检测收口 + 维护探针」一致性。

**Architecture:** 方案 A 串行批次——前置批次扩展共享核心类（`cdpPierceShadow` + `registerPlatformPierce` 插件注册表 + 静态守卫泛化 + 每平台独立双路径开关），稳定后三个业务批次（腾讯 wujie 穿透 → 快手契约二次验证 → 小红书 x-s Interceptor）各自收口 crawler 并织入探针。每平台 `ANTI_DETECTION_MODE_<PLATFORM>=legacy|v2` 双路径灰度，埋点对比达标后切 v2。

**Tech Stack:** TypeScript、Patchright、CDP（DOM/Runtime 域）、Jest、Prisma、Redis（探针通道）。

**Spec:** `docs/superpowers/specs/2026-06-27-multi-platform-anti-detection-rollout-design.md`

---

## 文件结构

**前置批次（核心类扩展，不改业务运行时）：**
- `apps/ts-api-gateway/src/lib/antiDetectionMode.ts` — 扩展为多平台开关 `isEnabled(platform)`，保留抖音 `isAntiDetectionV2()` 向后兼容。
- `packages/browser-core/src/humanActions.ts` — 新增 `cdpPierceShadow` + `registerPlatformPierce`/`getPlatformPierce` + `PierceStep` 类型导出。
- `scripts/anti-detection/audit-blindspots.ts` — 泛化为多平台 `PLATFORM_SCOPES` 配置驱动。
- `scripts/anti-detection/validate-step-keys.ts` — 新建，CI 验证探针 step key 命名规范。

**腾讯批次：** `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`、`apps/ts-api-gateway/src/platforms/tencent.ts`、`apps/ts-api-gateway/src/services/loginFlowHelpers.ts`（腾讯部分）。

**快手批次：** `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`、`apps/ts-api-gateway/src/platforms/kuaishou.ts`、`loginFlowHelpers.ts`（快手部分）。

**小红书批次：** `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`、`apps/ts-api-gateway/src/platforms/xiaohongshu*.ts`、`loginFlowHelpers.ts`（小红书部分）。

**测试：** 各包 `src/__tests__/` 下新增对应 `.test.ts`。

---

## 前置批次：核心类扩展

### Task 1: 扩展 antiDetectionMode 为多平台开关

**Files:**
- Modify: `apps/ts-api-gateway/src/lib/antiDetectionMode.ts`
- Test: `apps/ts-api-gateway/src/lib/__tests__/antiDetectionMode.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/ts-api-gateway/src/lib/__tests__/antiDetectionMode.test.ts
import { isEnabled, isAntiDetectionV2, ANTI_DETECTION_MODE } from '../antiDetectionMode';

describe('antiDetectionMode 多平台开关', () => {
  afterEach(() => {
    delete process.env.ANTI_DETECTION_MODE;
    delete process.env.ANTI_DETECTION_MODE_TENCENT;
    delete process.env.ANTI_DETECTION_MODE_KUAISHOU;
    delete process.env.ANTI_DETECTION_MODE_XIAOHONGSHU;
  });

  it('isEnabled(platform) 读对应平台 env，v2 为 true', () => {
    process.env.ANTI_DETECTION_MODE_TENCENT = 'v2';
    expect(isEnabled('tencent')).toBe(true);
    expect(isEnabled('kuaishou')).toBe(false);
  });

  it('未设置或非 v2 返回 false（legacy）', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'legacy';
    expect(isEnabled('kuaishou')).toBe(false);
    expect(isEnabled('xiaohongshu')).toBe(false);
  });

  it('抖音走向后兼容的 isAntiDetectionV2', () => {
    process.env.ANTI_DETECTION_MODE = 'v2';
    expect(isAntiDetectionV2()).toBe(true);
    expect(isEnabled('douyin')).toBe(true);
  });

  it('未知平台返回 false', () => {
    expect(isEnabled('unknown')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/ts-api-gateway && npx jest src/lib/__tests__/antiDetectionMode.test.ts`
Expected: FAIL — `isEnabled` 未定义。

- [ ] **Step 3: 实现多平台开关**

```typescript
// apps/ts-api-gateway/src/lib/antiDetectionMode.ts
export const ANTI_DETECTION_MODE = {
  LEGACY: 'legacy',
  V2: 'v2',
} as const;

// 平台 → 环境变量名映射（抖音保留原 ANTI_DETECTION_MODE 向后兼容）
const PLATFORM_ENV: Record<string, string> = {
  douyin: 'ANTI_DETECTION_MODE',
  tencent: 'ANTI_DETECTION_MODE_TENCENT',
  kuaishou: 'ANTI_DETECTION_MODE_KUAISHOU',
  xiaohongshu: 'ANTI_DETECTION_MODE_XIAOHONGSHU',
};

/** 指定平台是否启用 v2 反检测路径 */
export function isEnabled(platform: string): boolean {
  const envName = PLATFORM_ENV[platform];
  if (!envName) return false;
  return process.env[envName] === ANTI_DETECTION_MODE.V2;
}

/** 抖音向后兼容入口（== isEnabled('douyin')） */
export function isAntiDetectionV2(): boolean {
  return isEnabled('douyin');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/lib/__tests__/antiDetectionMode.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/lib/antiDetectionMode.ts apps/ts-api-gateway/src/lib/__tests__/antiDetectionMode.test.ts
git commit -m "feat(anti-detection): 每平台独立双路径开关 isEnabled(platform)

抖音 ANTI_DETECTION_MODE 向后兼容，腾讯/快手/小红书新增
ANTI_DETECTION_MODE_<PLATFORM>，默认 legacy。"
```

---

### Task 2: cdpPierceShadow — 写失败测试（css/shadow/frame 三类 step）

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`
- Test: `packages/browser-core/src/__tests__/humanActionsPierce.test.ts`

> 说明：`cdpPierceShadow` 基于 `getCDPContext` 拿到的 `cdp`（CDPClient）与 `dom`（CDPDomNavigator）。测试用 mock CDP context 模拟 `DOM.querySelector`/`DOM.describeNode`/`DOM.getOuterHTML` 返回。

- [ ] **Step 1: 写失败测试（css + 失败返回 null）**

```typescript
// packages/browser-core/src/__tests__/humanActionsPierce.test.ts
import { HumanActions } from '../humanActions';

// 构造 mock CDPContext：cdp.send 记录调用并按 method 返回
function makeMockCtx(behavior: Record<string, (params: any) => any>) {
  const calls: Array<{ method: string; params: any }> = [];
  const cdp: any = {
    send: jest.fn(async (method: string, params: any = {}) => {
      calls.push({ method, params });
      const handler = behavior[method];
      if (!handler) throw new Error(`unexpected CDP send: ${method}`);
      return handler(params);
    }),
    querySelector: jest.fn(async (sel: string) => behavior['DOM.querySelector']?.({ selector: sel })?.nodeId ?? null),
  };
  const dom: any = {};
  return { cdp, dom, calls };
}

// 注入 mock context 到私有 WeakMap
function injectContext(page: any, ctx: any) {
  (HumanActions as any).cdpContexts.set(page, ctx);
}

describe('HumanActions.cdpPierceShadow', () => {
  it('css step: DOM.querySelector 定位 + 读 text', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => (p.selector === 'div.title' ? { nodeId: 10 } : { nodeId: 0 }),
      'DOM.getOuterHTML': () => ({ outerHTML: '<div class="title">hello</div>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'css', selector: 'div.title' }],
      { selector: 'div.title', read: 'text' },
    );
    expect(result).toBe('hello');
  });

  it('元素不存在返回 null（不抛错）', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'css', selector: '.missing' }],
      { selector: '.missing', read: 'text' },
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/browser-core && npx jest src/__tests__/humanActionsPierce.test.ts`
Expected: FAIL — `cdpPierceShadow is not a function`。

- [ ] **Step 3: 实现 cdpPierceShadow（css 分支先做）**

在 `humanActions.ts` 的 `HumanActions` 类内、`safeEvaluate` 方法之后新增（先实现 css + text 读取，shadow/frame 在后续 step 补全）：

```typescript
// humanActions.ts 新增类型导出（类外）
export type PierceStep =
  | { type: 'css'; selector: string }
  | { type: 'shadow'; selector: string }
  | { type: 'frame'; name?: string; urlIncludes?: string };

// 类内新增方法
/**
 * 多级穿透读取（CDP DOM 域，零注入）。沿 chain 逐层定位，末层按 read 类型结构化读取。
 * 失败返回 null，不静默降级（铁律 5）。actionPath='cdp-pierce-shadow'。
 */
static async cdpPierceShadow(
  page: Page,
  chain: PierceStep[],
  target: { selector: string; read?: 'text' | 'attr' | 'exists' | 'count' | 'outerHTML'; attr?: string },
  opts?: { timeout?: number; reason?: string },
): Promise<unknown | null> {
  const ctx = await (HumanActions as any).getCDPContext(page) as CDPContext;
  const cdp = ctx.cdp;
  // 取根 document
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  let currentNodeId: number = doc.root.nodeId;

  // 逐层穿透
  for (const step of chain) {
    if (step.type === 'css') {
      const r = await cdp.send('DOM.querySelector', { nodeId: currentNodeId, selector: step.selector });
      currentNodeId = r?.nodeId || 0;
    } else if (step.type === 'shadow') {
      // 先定位 host 元素，再取其 shadowRoot
      const host = await cdp.send('DOM.querySelector', { nodeId: currentNodeId, selector: step.selector });
      if (!host?.nodeId) { currentNodeId = 0; break; }
      const desc = await cdp.send('DOM.describeNode', { nodeId: host.nodeId, depth: 1 });
      const shadowRoot = desc?.node?.shadowRoots?.[0];
      if (!shadowRoot) { currentNodeId = 0; break; }
      currentNodeId = shadowRoot.nodeId;
    } else if (step.type === 'frame') {
      // frame step: 当前节点若是 iframe，取其 contentDocument
      const desc = await cdp.send('DOM.describeNode', { nodeId: currentNodeId, depth: 0 });
      const contentDoc = desc?.node?.contentDocument;
      if (!contentDoc) { currentNodeId = 0; break; }
      currentNodeId = contentDoc.nodeId;
    }
    if (!currentNodeId) break;
  }

  if (!currentNodeId) {
    HumanActions.recordActionPath('cdp-pierce-shadow', { reason: opts?.reason, status: 'not-found' });
    return null;
  }

  // 末层定位 target
  const targetNode = await cdp.send('DOM.querySelector', { nodeId: currentNodeId, selector: target.selector });
  const targetNodeId = targetNode?.nodeId || 0;

  if (target.read === 'exists') {
    HumanActions.recordActionPath('cdp-pierce-shadow', { reason: opts?.reason });
    return targetNodeId !== 0;
  }
  if (!targetNodeId) {
    HumanActions.recordActionPath('cdp-pierce-shadow', { reason: opts?.reason, status: 'target-not-found' });
    return null;
  }

  // 结构化读取（不注入业务函数）
  const html = await cdp.send('DOM.getOuterHTML', { nodeId: targetNodeId });
  const outerHTML: string = html?.outerHTML || '';
  HumanActions.recordActionPath('cdp-pierce-shadow', { reason: opts?.reason });
  switch (target.read) {
    case 'outerHTML': return outerHTML;
    case 'attr': {
      const m = outerHTML.match(new RegExp(`${target.attr}=["']([^"']*)["']`));
      return m ? m[1] : null;
    }
    case 'count': return 1;
    case 'text':
    default: {
      // 提取标签内文本（去标签）
      const m = outerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return m || null;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/browser-core && npx jest src/__tests__/humanActionsPierce.test.ts`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActionsPierce.test.ts
git commit -m "feat(humanActions): cdpPierceShadow 多级穿透读取（css/text/exists）"
```

---

### Task 3: cdpPierceShadow — 补全 shadow/frame step 测试与实现

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`（实现已在 Task 2 含 shadow/frame，本任务补测试）
- Test: `packages/browser-core/src/__tests__/humanActionsPierce.test.ts`（追加用例）

- [ ] **Step 1: 追加 shadow step 测试**

```typescript
  it('shadow step: 进 wujie-app shadowRoot 后定位 target', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => {
        if (p.selector === 'wujie-app') return { nodeId: 5 };
        if (p.selector === '.feed-title') return { nodeId: 9 };
        return { nodeId: 0 };
      },
      'DOM.describeNode': (p: any) => {
        if (p.nodeId === 5) return { node: { shadowRoots: [{ nodeId: 7 }] } };
        return { node: {} };
      },
      'DOM.getOuterHTML': () => ({ outerHTML: '<span class="feed-title">视频标题</span>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'shadow', selector: 'wujie-app' }],
      { selector: '.feed-title', read: 'text' },
    );
    expect(result).toBe('视频标题');
  });

  it('shadowRoot 不可访问返回 null', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 5 }),
      'DOM.describeNode': () => ({ node: {} }), // 无 shadowRoots
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'shadow', selector: 'wujie-app' }],
      { selector: '.feed-title', read: 'text' },
    );
    expect(result).toBeNull();
  });
```

- [ ] **Step 2: 追加 frame step + 混合 chain 测试**

```typescript
  it('混合 chain: css→shadow→frame 多级穿透', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => {
        if (p.selector === 'wujie-app') return { nodeId: 5 };
        if (p.selector === '.comment-feed-wrap') return { nodeId: 12 };
        return { nodeId: 0 };
      },
      'DOM.describeNode': (p: any) => {
        if (p.nodeId === 5) return { node: { shadowRoots: [{ nodeId: 7 }] } };
        if (p.nodeId === 7) return { node: { contentDocument: { nodeId: 10 } } }; // shadow 内的 iframe
        return { node: {} };
      },
      'DOM.getOuterHTML': () => ({ outerHTML: '<div class="comment-feed-wrap">评论</div>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [
        { type: 'shadow', selector: 'wujie-app' },
        { type: 'frame' },
      ],
      { selector: '.comment-feed-wrap', read: 'text' },
    );
    expect(result).toBe('评论');
  });

  it('复用 CDP context（不新建 session）', async () => {
    const page = {};
    let sessionCreated = false;
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    // 监听 getCDPContext 是否走缓存：若已注入 context，不应触发 newCDPSession
    (page as any).context = () => ({ newCDPSession: () => { sessionCreated = true; } });
    injectContext(page, ctx);

    await (HumanActions as any).cdpPierceShadow(page, [{ type: 'css', selector: '.x' }], { selector: '.x', read: 'exists' });
    expect(sessionCreated).toBe(false);
  });
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd packages/browser-core && npx jest src/__tests__/humanActionsPierce.test.ts`
Expected: PASS（6 个用例：css/shadow/frame/混合/not-found/session复用）。

> 注：Task 2 的实现已涵盖 shadow/frame 逻辑（`describeNode` 取 `shadowRoots`/`contentDocument`），若 frame step 需按 `name`/`urlIncludes` 精确匹配多个 iframe，在实现内对 `describeNode` 返回的 frame 信息做筛选——若测试暴露缺口，补充实现后重跑。

- [ ] **Step 4: 提交**

```bash
git add packages/browser-core/src/__tests__/humanActionsPierce.test.ts packages/browser-core/src/humanActions.ts
git commit -m "test(humanActions): cdpPierceShadow 补全 shadow/frame/混合穿透 + context 复用测试"
```

---

### Task 4: registerPlatformPierce 插件注册表

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`
- Test: `packages/browser-core/src/__tests__/humanActionsPierce.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

在 `humanActionsPierce.test.ts` 追加：

```typescript
describe('HumanActions.registerPlatformPierce', () => {
  beforeEach(() => {
    // 清空注册表（隔离测试）
    (HumanActions as any).platformPierceRegistry = new Map();
  });

  it('注册 + 取用 handler', async () => {
    const handler = jest.fn().mockResolvedValue('pierced');
    HumanActions.registerPlatformPierce('tencent', 'wujie-comment-feed', handler);
    const got = HumanActions.getPlatformPierce('tencent', 'wujie-comment-feed');
    expect(got).toBe(handler);
    const page = {};
    const result = await got!(page as any, { videoId: 'v1' });
    expect(result).toBe('pierced');
    expect(handler).toHaveBeenCalledWith(page, { videoId: 'v1' });
  });

  it('未注册返回 undefined', () => {
    expect(HumanActions.getPlatformPierce('tencent', 'nope')).toBeUndefined();
  });

  it('平台隔离：同名不同平台不串', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    HumanActions.registerPlatformPierce('tencent', 'feed', h1);
    HumanActions.registerPlatformPierce('kuaishou', 'feed', h2);
    expect(HumanActions.getPlatformPierce('tencent', 'feed')).toBe(h1);
    expect(HumanActions.getPlatformPierce('kuaishou', 'feed')).toBe(h2);
  });

  it('重复注册幂等（覆盖）', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    HumanActions.registerPlatformPierce('tencent', 'feed', h1);
    HumanActions.registerPlatformPierce('tencent', 'feed', h2);
    expect(HumanActions.getPlatformPierce('tencent', 'feed')).toBe(h2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/browser-core && npx jest src/__tests__/humanActionsPierce.test.ts`
Expected: FAIL — `registerPlatformPierce is not a function`。

- [ ] **Step 3: 实现注册表**

在 `humanActions.ts` 的 `HumanActions` 类内（`stepMetricsCollector` 字段附近）新增：

```typescript
type PierceHandler = (page: Page, params: any) => Promise<unknown | null>;

export type { PierceHandler };

// 类内私有字段
private static platformPierceRegistry = new Map<string, Map<string, PierceHandler>>();

/**
 * 注册平台特有的穿透 handler（spec 8.2）。
 * 仅当穿透逻辑无法用 PierceStep[] chain 声明式表达时使用；
 * 通用穿透走 cdpPierceShadow。注册幂等（覆盖）。
 */
static registerPlatformPierce(platform: string, name: string, handler: PierceHandler): void {
  let platformMap = HumanActions.platformPierceRegistry.get(platform);
  if (!platformMap) {
    platformMap = new Map();
    HumanActions.platformPierceRegistry.set(platform, platformMap);
  }
  platformMap.set(name, handler);
}

/** 取用平台特有穿透 handler，未注册返回 undefined。 */
static getPlatformPierce(platform: string, name: string): PierceHandler | undefined {
  return HumanActions.platformPierceRegistry.get(platform)?.get(name);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/browser-core && npx jest src/__tests__/humanActionsPierce.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActionsPierce.test.ts
git commit -m "feat(humanActions): registerPlatformPierce 插件注册表（平台隔离+幂等）"
```

---

### Task 5: 静态守卫脚本泛化为多平台

**Files:**
- Modify: `scripts/anti-detection/audit-blindspots.ts`

- [ ] **Step 1: 重写为多平台配置驱动**

```typescript
// scripts/anti-detection/audit-blindspots.ts
// 审计各平台范围文件的裸调用盲区，按平台分别报告计数。
import { readFileSync } from 'fs';
import { join } from 'path';

const PATTERNS = [
  'page.evaluate(', 'frame.evaluate(', 'page.$eval(', 'page.$$eval(',
  'page.evaluateHandle(', 'page.locator(', 'page.$(', 'page.$$(',
  'page.keyboard.', 'createCDPSession', 'page.click', '.fill(',
  'page.mouse', 'page.waitForSelector(', 'page.waitForFunction(',
  'HumanActions.cdpClickByText(', 'HumanActions.queryElementsWithInfo(',
];

// 各平台范围文件（spec 2.3）
const PLATFORM_SCOPES: Record<string, string[]> = {
  douyin: [
    'apps/ts-api-gateway/src/crawlers/douyinCrawler.ts',
    'apps/ts-api-gateway/src/platforms/douyin.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  tencent: [
    'apps/ts-api-gateway/src/crawlers/tencentCrawler.ts',
    'apps/ts-api-gateway/src/platforms/tencent.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  kuaishou: [
    'apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts',
    'apps/ts-api-gateway/src/platforms/kuaishou.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  xiaohongshu: [
    'apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts',
    'apps/ts-api-gateway/src/platforms/xiaohongshu.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
};

const ROOT = process.cwd();
const WORLD_MAIN_LIMIT = 3;

function countInFile(file: string): Record<string, number> {
  let content: string;
  try { content = readFileSync(join(ROOT, file), 'utf8'); } catch { return {}; }
  const result: Record<string, number> = {};
  for (const p of PATTERNS) {
    let count = 0, idx = content.indexOf(p);
    while (idx !== -1) { count++; idx = content.indexOf(p, idx + 1); }
    if (count > 0) result[p] = count;
  }
  return result;
}

// CLI: 可指定单平台或全部。node audit-blindspots.ts [tencent|kuaishou|...]
const target = process.argv[2];
const platforms = target ? [target] : Object.keys(PLATFORM_SCOPES);

let grandTotal = 0;
let worldMainViolations = 0;

for (const platform of platforms) {
  const files = PLATFORM_SCOPES[platform];
  let platformTotal = 0;
  console.log(`\n########## 平台: ${platform} ##########`);
  for (const f of files) {
    const counts = countInFile(f);
    const fileTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    platformTotal += fileTotal;
    if (fileTotal > 0) {
      console.log(`\n=== ${f} (total ${fileTotal}) ===`);
      for (const [p, c] of Object.entries(counts)) console.log(`  ${p}: ${c}`);
    }
    // world:'main' 计数
    let content: string;
    try { content = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const matches = (content.match(/world\s*:\s*["']main["']/g) || []).length;
    if (matches > WORLD_MAIN_LIMIT) {
      worldMainViolations++;
      console.log(`  ⚠️  ${f}: world:'main' ${matches} > ${WORLD_MAIN_LIMIT} VIOLATION`);
    }
  }
  console.log(`\n=== ${platform} 裸调用总计: ${platformTotal} ===`);
  grandTotal += platformTotal;
}
console.log(`\n========== 全部平台裸调用总计: ${grandTotal} ==========`);
if (worldMainViolations > 0) console.log(`⚠️  ${worldMainViolations} 个文件超过 world:'main' 限制`);
process.exit(0); // 审计脚本始终退出 0，仅报告
```

- [ ] **Step 2: 验证抖音范围不破坏（回归）**

Run: `node scripts/anti-detection/audit-blindspots.ts douyin`
Expected: 抖音范围裸调用总计仍为抖音现状（已收口，v2 分支内 safeEvaluate 不计入裸调用），world:'main' 无 VIOLATION。

- [ ] **Step 3: 验证多平台报告**

Run: `node scripts/anti-detection/audit-blindspots.ts`
Expected: 输出四平台分节，腾讯/快手/小红书报告非零现状（基线），不阻断（exit 0）。

- [ ] **Step 4: 提交**

```bash
git add scripts/anti-detection/audit-blindspots.ts
git commit -m "feat(guard): 静态守卫泛化为多平台 PLATFORM_SCOPES 配置驱动"
```

---

### Task 6: 探针 step key 命名规范验证脚本

**Files:**
- Create: `scripts/anti-detection/validate-step-keys.ts`

- [ ] **Step 1: 写验证脚本**

```typescript
// scripts/anti-detection/validate-step-keys.ts
// 验证 enterStep 调用的 step key 符合 <flow>.<platform>.<phase>.<step> 规范（spec 3.4）。
// flow/platform 小写，phase PascalCase (PhaseN)，step camelCase 动词开头。
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const PLATFORM_FILES: Record<string, string[]> = {
  douyin: ['apps/ts-api-gateway/src/crawlers/douyinCrawler.ts'],
  tencent: ['apps/ts-api-gateway/src/crawlers/tencentCrawler.ts'],
  kuaishou: ['apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts'],
  xiaohongshu: ['apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts'],
};

// 匹配 enterStep('monitor', 'tencent', 'Phase1', 'navigateToSidebar')
const ENTER_STEP_RE = /enterStep\(\s*['"]([a-z]+)['"]\s*,\s*['"]([a-z]+)['"]\s*,\s*['"](Phase\d+)['"]\s*,\s*['"]([a-zA-Z]+)['"]\s*\)/g;

const VALID_PLATFORMS = new Set(['douyin', 'tencent', 'kuaishou', 'xiaohongshu']);
const STEP_VERB_PREFIX = /^(navigate|fetch|process|submit|click|fill|scroll|wait|verify|open|select|parse)/;

let violations = 0;
const seenPerPhase = new Map<string, Set<string>>();

for (const [platform, files] of Object.entries(PLATFORM_FILES)) {
  for (const f of files) {
    let content: string;
    try { content = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    let m: RegExpExecArray | null;
    ENTER_STEP_RE.lastIndex = 0;
    while ((m = ENTER_STEP_RE.exec(content)) !== null) {
      const [_, flow, plat, phase, step] = m;
      if (!VALID_PLATFORMS.has(plat)) {
        console.log(`✗ ${f}: 未知平台 '${plat}'`);
        violations++;
      }
      if (!/^Phase\d+$/.test(phase)) {
        console.log(`✗ ${f}: phase '${phase}' 不符合 PhaseN`);
        violations++;
      }
      if (!/^[a-z][a-zA-Z]*$/.test(step)) {
        console.log(`✗ ${f}: step '${step}' 非 camelCase`);
        violations++;
      }
      if (!STEP_VERB_PREFIX.test(step)) {
        console.log(`✗ ${f}: step '${step}' 非动词开头`);
        violations++;
      }
      // 同 phase 下 step 唯一
      const key = `${plat}:${phase}`;
      if (!seenPerPhase.has(key)) seenPerPhase.set(key, new Set());
      if (seenPerPhase.get(key)!.has(step)) {
        console.log(`✗ ${f}: step '${step}' 在 ${key} 下重复`);
        violations++;
      }
      seenPerPhase.get(key)!.add(step);
    }
  }
}
if (violations === 0) console.log('✓ step key 命名规范全部通过');
else console.log(`⚠️  ${violations} 处 step key 规范违规`);
process.exit(violations === 0 ? 0 : 1);
```

- [ ] **Step 2: 验证抖音样板通过**

Run: `node scripts/anti-detection/validate-step-keys.ts`
Expected: 抖音现有 6 处 `enterStep` 全部符合规范（`navigateToCreatorHome`/`fetchVideoListFromSource`/`processCommentsQueue` 等均动词开头），无违规，exit 0。

- [ ] **Step 3: 提交**

```bash
git add scripts/anti-detection/validate-step-keys.ts
git commit -m "feat(guard): 探针 step key 命名规范验证脚本"
```

---

### Task 7: 前置批次集成验证

- [ ] **Step 1: 全量构建 browser-core**

Run: `cd packages/browser-core && npm run build`
Expected: tsc 编译通过，无类型错误。

- [ ] **Step 2: 全量测试 browser-core**

Run: `cd packages/browser-core && npx jest`
Expected: 全部测试通过（含新增 humanActionsPierce.test.ts + 现有测试不回归）。

- [ ] **Step 3: 验证 antiDetectionMode 不影响抖音现有调用**

Run: `cd apps/ts-api-gateway && grep -rn "isAntiDetectionV2" src/ | wc -l`
Expected: 抖音现有调用仍引用 `isAntiDetectionV2()`，向后兼容未破坏（数量与改造前一致）。

- [ ] **Step 4: 提交前置批次里程碑标记**

```bash
git commit --allow-empty -m "chore(anti-detection): 前置批次完成 — 核心类契约稳定，三平台业务批次可并行"
```

---

## 第 2 批：腾讯（wujie ShadowDOM 收口）

> 编码开始前确认前置批次（Task 1-7）已合并到 master。腾讯是共享 crawler 文件，与快手/小红书批次不可并行（同改 `loginFlowHelpers.ts`/`tencentCrawler.ts`）。

### Task 8: 腾讯 — wujie 穿透收口（3 处 frame.evaluate + 2 处 shadow 穿透）

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（行 `:471`/`:585`/`:618`/`:1422`/`:1586`）
- Test: `apps/ts-api-gateway/src/crawlers/__tests__/tencentPierce.test.ts`

- [ ] **Step 1: 写失败测试 — v2 路径走 cdpPierceShadow**

```typescript
// apps/ts-api-gateway/src/crawlers/__tests__/tencentPierce.test.ts
import { isEnabled } from '../../lib/antiDetectionMode';

// 验证腾讯 v2 模式下，视频列表读取经 cdpPierceShadow 而非 frame.evaluate
jest.mock('../../../packages/browser-core/src/humanActions', () => ({
  HumanActions: {
    cdpPierceShadow: jest.fn().mockResolvedValue('视频标题'),
    getPlatformPierce: jest.fn(),
  },
}));

describe('腾讯 wujie 穿透 v2 收口', () => {
  afterEach(() => { delete process.env.ANTI_DETECTION_MODE_TENCENT; });

  it('v2 模式 isEnabled(tencent) 为 true', () => {
    process.env.ANTI_DETECTION_MODE_TENCENT = 'v2';
    expect(isEnabled('tencent')).toBe(true);
  });

  it('legacy 模式 isEnabled(tencent) 为 false', () => {
    delete process.env.ANTI_DETECTION_MODE_TENCENT;
    expect(isEnabled('tencent')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认状态**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/__tests__/tencentPierce.test.ts`
Expected: PASS（开关测试先绿，穿透调用测试随实现补）。

- [ ] **Step 3: 收口 `tencentCrawler.ts:1586` 视频列表穿透**

定位 `:1586` 附近手写 `wujie-app` → `shadowRoot` 回退查找视频列表的 `page.evaluate`，用双路径包络：

```typescript
// 原（legacy 分支保留）：
// const list = await page.evaluate(() => { /* 手写 wujie-app shadowRoot 穿透 */ });

import { isEnabled } from '../lib/antiDetectionMode';
import { HumanActions } from '@social-media/browser-core';

let list: any;
if (isEnabled('tencent')) {
  // v2: CDP DOM 域穿透，零注入
  const title = await HumanActions.cdpPierceShadow(
    page,
    [
      { type: 'shadow', selector: 'wujie-app' },
      { type: 'frame', name: 'interaction' },
    ],
    { selector: '.feed-title', read: 'text' },
    { reason: '腾讯视频列表标题穿透 wujie shadowRoot+iframe' },
  );
  list = title ? [{ title }] : [];
} else {
  // legacy: 原 page.evaluate 手写穿透
  list = await page.evaluate(() => { /* 保留原逻辑 */ });
}
```

> 实施时将原 `page.evaluate` 函数体原样移入 `else` 分支，v2 分支用 `cdpPierceShadow` 替代。每处必附 `reason`。

- [ ] **Step 4: 收口 `:1422` shadow 遍历**

定位 `:1422` `querySelectorAll('wujie-app')` → `shadowRoot` → `querySelectorAll('*')`，同样双路径包络，v2 走 `cdpPierceShadow(page, [{type:'shadow',selector:'wujie-app'}], {selector, read:'outerHTML'})`。

- [ ] **Step 5: 收口 3 处 `frame.evaluate`（`:471`/`:585`/`:618`）**

每处 `frame.evaluate` 双路径包络：v2 走 `cdpPierceShadow(page, [{type:'frame',name:'interaction'}], {selector, read})`，QR 状态相关者改走 `pollStatus`（Task 10）。

- [ ] **Step 6: 运行守卫验证腾讯穿透盲区已收口**

Run: `node scripts/anti-detection/audit-blindspots.ts tencent`
Expected: `frame.evaluate(` 计数 = 0（v2 分支不调用 `frame.evaluate`，legacy 分支保留但已包络在 `else`；守卫统计源码文本仍会计数 legacy 分支——**注意**：legacy 分支保留意味着守卫计数非零，这是预期，全量切 v2 删 legacy 后才归零。本步验证 v2 分支代码存在且无新增裸调用）。

- [ ] **Step 7: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/crawlers/__tests__/tencentPierce.test.ts
git commit -m "feat(tencent): wujie 穿透收口 — 3 frame.evaluate + 2 shadow 穿透走 cdpPierceShadow 双路径"
```

---

### Task 9: 腾讯 — 31 处 page.evaluate 分类路由收口

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（`:253`-`:409` 侧边栏 + 其余 ~9 处）

> 按 spec 3.2 三选一路由：纯 DOM 读→`readText`/`readAll`/`exists`；必须 JS→`safeEvaluate(world:'main',reason)`（≤3/文件）；API 解析→Interceptor（Task 10）。

- [ ] **Step 1: 收口侧边栏菜单解析（`:253`-`:409`，~6 处 page.evaluate）**

这些在主文档读 `#side-bar`（非 wujie），属标准 DOM 读。统一用 `readAll` 批量读替代多次循环 `evaluate`：

```typescript
if (isEnabled('tencent')) {
  // v2: 批量读侧边栏菜单项（text + href）
  const items = await HumanActions.readAll(page, ['#side-bar a'], { text: true, attr: ['href'] }) as any[];
  // 解析 items 映射到菜单结构
} else {
  // legacy: 原 page.evaluate sidebar.querySelector 链
  const items = await page.evaluate(() => { /* 保留 */ });
}
```

> 若 `readAll` 当前签名不支持 `attr` 数组，先用 `readAttribute` 逐项读；暴露的契约缺口记录到 Task 14（快手契约回溯）前置清单。

- [ ] **Step 2: 收口其余 ~3 处纯 DOM 读**

逐处用 `readText`/`readAttribute`/`exists` 双路径包络。

- [ ] **Step 3: 收口 ~3 处必须 JS（window.__INITIAL_STATE__ 等）**

```typescript
if (isEnabled('tencent')) {
  const state = await HumanActions.safeEvaluate(
    page,
    () => (window as any).__INITIAL_STATE__,
    { world: 'main', reason: 'main-world-required: 读腾讯页面全局状态，DOM 域无法访问 window 对象' },
  ) as any;
} else {
  // legacy
}
```

> 验证 `world:'main'` 单文件 ≤3 处（守卫 Task 5 已覆盖）。

- [ ] **Step 4: 运行现有腾讯测试不回归**

Run: `cd apps/ts-api-gateway && npx jest --testPathPattern tencent 2>/dev/null || echo "no tencent tests"`
Expected: 现有测试不回归（若测试用真实 page mock，legacy 分支保持行为）。

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): 31 处 page.evaluate 分类路由收口（readAll/readText/safeEvaluate 双路径）"
```

---

### Task 10: 腾讯 — Interceptor 四盲区收口

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`、`apps/ts-api-gateway/src/platforms/tencent.ts`、`apps/ts-api-gateway/src/services/loginFlowHelpers.ts`（腾讯部分）

- [ ] **Step 1: QR 扫码状态 → pollStatus**

定位 QR 轮询逻辑（`frame.evaluate` 读二维码 DOM），v2 改 `pollStatus`：

```typescript
if (isEnabled('tencent')) {
  const qrStatus = await interceptor.pollStatus(page, '/cgi-bin/qr/.*status', {
    interval: 1000,
    timeout: 60000,
    predicate: (r: any) => ['scanned', 'expired', 'confirmed'].includes(r?.status),
  });
} else {
  // legacy: frame.evaluate 轮询 DOM
}
```

- [ ] **Step 2: 登录态校验 → pollStatus**

- [ ] **Step 3: 视频列表/评论分页 → collectResponses**

```typescript
if (isEnabled('tencent')) {
  const responses = await interceptor.collectResponses(page, '/aweme|/comment.*list', {
    until: (items: any[]) => items.length >= expectedCount,
    maxItems: 500,
  });
} else {
  // legacy
}
```

- [ ] **Step 4: 发布结果 → waitForResponse + DOM 兜底**

`platforms/tencent.ts` 发布成功判定，v2 主用 `waitForResponse` 拦发布 API，DOM toast 作 fallback：

```typescript
if (isEnabled('tencent')) {
  try {
    const result = await interceptor.waitForResponse(page, '/publish.*aweme', {
      timeout: 30000,
      validate: (r: any) => r?.aweme_id != null,
    });
    // 命中即成功
  } catch {
    // 兜底 DOM toast 判定，埋点 interceptor-fallback-to-dom
  }
}
```

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/platforms/tencent.ts apps/ts-api-gateway/src/services/loginFlowHelpers.ts
git commit -m "feat(tencent): Interceptor 四盲区收口（QR/登录态/列表/发布结果）+ DOM 兜底"
```

---

### Task 11: 腾讯 — 维护探针织入

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **Step 1: 引入 probeBootstrap/teardownProbe**

确认 `tencentCrawler.ts` 顶部已 import `MaintenanceProbe` 与 `bootstrapProbe`/`teardownProbe`（参照 `douyinCrawler.ts:12-13`）。若无则补：

```typescript
import { MaintenanceProbe } from '@social-media/browser-core';
import { bootstrapProbe, teardownProbe } from './probeBootstrap';
```

- [ ] **Step 2: 任务入口/出口调用**

在腾讯任务执行入口 `await bootstrapProbe({ isDebugMode, taskExecutionId })`，出口 `await teardownProbe()`（对齐抖音样板）。

- [ ] **Step 3: 织入 Phase1/Phase3 关键子步骤 enterStep/exitStep**

```typescript
MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase1', 'navigateToSidebar');
// ... 侧边栏定位（cdpPierceShadow / readAll）
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase1', 'fetchVideoListFromSource');
// ... collectResponses
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase3', 'processCommentsQueue');
// ... 评论树采集
MaintenanceProbe.exitStep();
```

- [ ] **Step 4: 验证 step key 规范**

Run: `node scripts/anti-detection/validate-step-keys.ts`
Expected: 腾讯织入的 step key 全部通过（动词开头、camelCase、同 phase 唯一），exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): 维护探针织入 Phase1/Phase3 enterStep/exitStep"
```

---

### Task 12: 腾讯批次验证与灰度准备

- [ ] **Step 1: 静态守卫验证**

Run: `node scripts/anti-detection/audit-blindspots.ts tencent`
Expected: 腾讯范围 v2 分支代码存在；world:'main' ≤3/文件无 VIOLATION。（legacy 分支计数保留，全量切 v2 后归零。）

- [ ] **Step 2: 全量测试不回归**

Run: `cd apps/ts-api-gateway && npx jest`
Expected: 全部通过。

- [ ] **Step 3: TypeScript 编译**

Run: `cd apps/ts-api-gateway && npm run build`
Expected: 编译通过。

- [ ] **Step 4: 灰度配置说明**

在 `.env.example` 追加：

```bash
# 反检测双路径开关（每平台独立，默认 legacy）
ANTI_DETECTION_MODE_TENCENT=legacy   # legacy|v2
ANTI_DETECTION_MODE_KUAISHOU=legacy  # legacy|v2
ANTI_DETECTION_MODE_XIAOHONGSHU=legacy # legacy|v2
```

- [ ] **Step 5: 提交**

```bash
git add .env.example
git commit -m "docs(env): 三平台反检测双路径开关示例"
```

- [ ] **Step 6: 腾讯灰度上线（运维操作）**

设 `ANTI_DETECTION_MODE_TENCENT=v2`，跑监控采集 7 天，对比埋点 `actionPath`/风控触发率 vs legacy。达标后切 v2 删 legacy（独立后续任务，本计划不强制）。

---

## 第 3 批：快手（标准 DOM 收口 + 契约二次验证）

> 与腾讯批次共享 `loginFlowHelpers.ts`，须在腾讯合并后开始（或各自限定到本平台部分互不重叠的代码区）。

### Task 13: 快手 — 14 处 page.evaluate + 2 处 page.locator 收口

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- Test: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.test.ts`（已存在，补充 v2 用例）

- [ ] **Step 1: 写 v2 开关测试**

```typescript
// 追加到 kuaishouCrawler.test.ts
import { isEnabled } from '../../lib/antiDetectionMode';
describe('快手双路径开关', () => {
  afterEach(() => delete process.env.ANTI_DETECTION_MODE_KUAISHOU);
  it('v2 启用', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'v2';
    expect(isEnabled('kuaishou')).toBe(true);
  });
  it('legacy 默认', () => {
    expect(isEnabled('kuaishou')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `cd apps/ts-api-gateway && npx jest src/crawlers/kuaishouCrawler.test.ts`
Expected: PASS。

- [ ] **Step 3: 14 处 page.evaluate 双路径收口**

按 spec 4.1 路由：~9 纯 DOM 读→`readText`/`readAll`/`exists`；~1 必须 JS→`safeEvaluate(world:'main',reason)`；~4 API→Interceptor（Task 15）。每处 `if (isEnabled('kuaishou')) { v2 } else { legacy 原 evaluate }`。

- [ ] **Step 4: 2 处 page.locator 收口**

```typescript
if (isEnabled('kuaishou')) {
  await HumanActions.click(page, 'button.submit'); // 原生 Locator + 拟人化
} else {
  await page.locator('button.submit').click(); // legacy
}
```

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.test.ts
git commit -m "feat(kuaishou): 14 page.evaluate + 2 page.locator 双路径收口"
```

---

### Task 14: 快手 — 契约二次验证（护栏）

- [ ] **Step 1: 迁移过程中核查契约适配**

逐处迁移时，若发现 `readAll`/`readText`/`safeEvaluate`/`exists` 契约在快手场景不满足（如返回结构不够用、参数缺失），**暂停快手批次**，记录不适配场景：

```markdown
# 契约回溯记录（若触发）
- 不适配点：<方法名> 在 <快手场景> 下 <具体问题>
- 影响评估：抖音/腾讯是否受影响：<是/否>
- 修改方案：<向后兼容的契约调整>
```

- [ ] **Step 2: 若触发回溯 — 改核心类 + 回归**

在 `humanActions.ts` 修改契约（向后兼容，不破坏抖音/腾讯），然后：

Run: `cd packages/browser-core && npx jest && npm run build`
Run: `cd apps/ts-api-gateway && npx jest`
Expected: 抖音/腾讯全量测试不回归，快手场景现在可用。

- [ ] **Step 3: 若未触发回溯 — 记录契约验证通过**

```bash
git commit --allow-empty -m "chore(kuaishou): 契约二次验证通过 — readAll/readText/safeEvaluate 无需回溯"
```

- [ ] **Step 4: 提交（若 Step 2 有改动）**

```bash
git add packages/browser-core/src/humanActions.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "fix(humanActions): 契约回溯调整以适配快手（向后兼容）+ 快手收口"
```

---

### Task 15: 快手 — Interceptor 收口 + 探针织入

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`、`apps/ts-api-gateway/src/platforms/kuaishou.ts`

- [ ] **Step 1: 视频列表/评论分页 → collectResponses；发布结果 → waitForResponse+DOM 兜底；登录态 → pollStatus**

每处双路径包络（参照腾讯 Task 10 模式）。

- [ ] **Step 2: 探针织入**

```typescript
import { MaintenanceProbe } from '@social-media/browser-core';
import { bootstrapProbe, teardownProbe } from './probeBootstrap';
// 入口 bootstrapProbe，出口 teardownProbe

MaintenanceProbe.enterStep('monitor', 'kuaishou', 'Phase1', 'fetchVideoListFromSource');
MaintenanceProbe.exitStep();
MaintenanceProbe.enterStep('monitor', 'kuaishou', 'Phase3', 'processCommentsQueue');
MaintenanceProbe.exitStep();
```

- [ ] **Step 3: 验证 step key 规范**

Run: `node scripts/anti-detection/validate-step-keys.ts`
Expected: 快手 step key 通过。

- [ ] **Step 4: 守卫 + 编译 + 测试**

Run: `node scripts/anti-detection/audit-blindspots.ts kuaishou`
Run: `cd apps/ts-api-gateway && npm run build && npx jest`

- [ ] **Step 5: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/platforms/kuaishou.ts
git commit -m "feat(kuaishou): Interceptor 收口 + 维护探针织入"
```

---

## 第 4 批：小红书（x-s Interceptor 收口）

### Task 16: 小红书 — 7 处 page.locator + 1 处 page.keyboard 收口

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

- [ ] **Step 1: 写 v2 开关测试**

```typescript
// 追加到现有 xiaohongshu 测试或新建 __tests__/xiaohongshuMode.test.ts
import { isEnabled } from '../../lib/antiDetectionMode';
describe('小红书双路径开关', () => {
  afterEach(() => delete process.env.ANTI_DETECTION_MODE_XIAOHONGSHU);
  it('v2 启用', () => {
    process.env.ANTI_DETECTION_MODE_XIAOHONGSHU = 'v2';
    expect(isEnabled('xiaohongshu')).toBe(true);
  });
});
```

- [ ] **Step 2: 7 处 page.locator 双路径收口**

```typescript
if (isEnabled('xiaohongshu')) {
  await HumanActions.click(page, '.publish-btn'); // 或 exists/readText
} else {
  await page.locator('.publish-btn').click();
}
```

- [ ] **Step 3: 1 处 page.keyboard 收口**

```typescript
if (isEnabled('xiaohongshu')) {
  await HumanActions.press(page, 'input.content', 'Enter'); // 或 cdpKeyboard（扫描码场景）
} else {
  await page.keyboard.press('Enter');
}
```

- [ ] **Step 4: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xiaohongshu): 7 page.locator + 1 page.keyboard 双路径收口"
```

---

### Task 17: 小红书 — Interceptor 收口（x-s 重点）+ 探针织入

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`、`apps/ts-api-gateway/src/platforms/xiaohongshu*.ts`

- [ ] **Step 1: 视频列表/评论分页/发布结果/登录态 → collectResponses/waitForResponse/pollStatus 双路径**

- [ ] **Step 2: x-s 签名请求观测**

```typescript
if (isEnabled('xiaohongshu')) {
  // collectResponses 拦 x-s 相关 API，埋点记录签名命中率
  const responses = await interceptor.collectResponses(page, '/api/sns/.*', {
    until: (items: any[]) => items.length >= expectedCount,
    maxItems: 500,
  });
}
```

- [ ] **Step 3: 启用 Interceptor 1% 无兜底采样（对齐抖音 spec 5.4）**

确认 `interceptor.ts` 已有 `shouldSampleNoFallback` 采样逻辑（抖音试点已实现），小红书 v2 路径沿用，失败率 >10% 触发告警。

- [ ] **Step 4: 探针织入**

```typescript
MaintenanceProbe.enterStep('monitor', 'xiaohongshu', 'Phase1', 'fetchVideoListFromSource');
MaintenanceProbe.exitStep();
MaintenanceProbe.enterStep('monitor', 'xiaohongshu', 'Phase3', 'processCommentsQueue');
MaintenanceProbe.exitStep();
```

- [ ] **Step 5: 验证 step key 规范 + 守卫 + 编译 + 测试**

Run: `node scripts/anti-detection/validate-step-keys.ts`
Run: `node scripts/anti-detection/audit-blindspots.ts xiaohongshu`
Run: `cd apps/ts-api-gateway && npm run build && npx jest`

- [ ] **Step 6: 提交**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/platforms/
git commit -m "feat(xiaohongshu): x-s Interceptor 收口 + 签名观测 + 维护探针织入"
```

---

### Task 18: 四平台终态集成验证

- [ ] **Step 1: 全平台守卫**

Run: `node scripts/anti-detection/audit-blindspots.ts`
Expected: 四平台 v2 分支代码就位；world:'main' 全文件 ≤3 无 VIOLATION。（legacy 分支计数保留，待各平台切 v2 删 legacy 后归零。）

- [ ] **Step 2: 全平台 step key 规范**

Run: `node scripts/anti-detection/validate-step-keys.ts`
Expected: 四平台 step key 全部通过，exit 0。

- [ ] **Step 3: 全量构建与测试**

Run: `cd packages/browser-core && npm run build && npx jest`
Run: `cd apps/ts-api-gateway && npm run build && npx jest`
Expected: 全绿。

- [ ] **Step 4: 灰度上线（严格串行，一次一平台）**

按腾讯 → 快手 → 小红书顺序，每平台：设 `ANTI_DETECTION_MODE_<P>=v2` → 跑监控采集 7 天 → 对比埋点 `actionPath`（native/pierce 占绝大多数、`safeEvaluate-main` 趋近 0、`interceptor-hit` 高）+ 风控触发率不劣于 legacy → 达标切 v2 删 legacy。

- [ ] **Step 5: 提交终态里程碑**

```bash
git commit --allow-empty -m "chore(anti-detection): 四平台收口完成 — 待逐平台灰度达标后删 legacy"
```

---

## 自审记录

**1. Spec 覆盖**：
- §1 复用契约 + 每平台开关 → Task 1。
- §2.1 cdpPierceShadow → Task 2-3。
- §2.2 registerPlatformPierce → Task 4。
- §2.3 静态守卫泛化 → Task 5。
- §2.4 每平台开关 → Task 1。
- §2.5 测试覆盖率目标 → Task 2-4 用例覆盖 css/shadow/frame/混合/失败/复用/注册隔离/幂等。
- §3 腾讯批次（穿透/31 evaluate/Interceptor/探针/双路径）→ Task 8-12。
- §3.4 step key 命名规范 → Task 6 + 各批次验证。
- §4 快手批次（14 evaluate/契约二次验证/Interceptor/探针）→ Task 13-15。
- §4.5 契约回溯详细流程 → Task 14。
- §5 小红书批次（7 locator/x-s Interceptor/探针）→ Task 16-17。
- §6 排期/验证/上线回滚/风险/成功标准 → Task 7/12/18。

**2. 占位符扫描**：无 TBD/TODO；腾讯/快手 evaluate 收口步骤标注"~N 处（估）"为 spec 既定估算，实施时精确定位行号——属可执行范围（grep 定位），非占位符。`cdpPierceShadow` 末层 text 读取用正则提取 `outerHTML` 标签内文本，是简化实现，已在 Task 9 注明若 `readAll` 契约不足触发回溯。

**3. 类型一致性**：`PierceStep`/`PierceHandler` 在 Task 2/4 定义，Task 8/16 消费一致；`isEnabled(platform)` Task 1 定义，各批次调用一致；`enterStep(flow, platform, phase, step)` 四参数签名与抖音样板 `douyinCrawler.ts:194` 一致。
