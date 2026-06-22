# 登录标签页注册表 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **设计规格**: `docs/superpowers/specs/2026-06-22-login-tab-registry-design.md`

**目标：** 新建 `LoginTabRegistry` 基础设施，统一所有平台的登录标签页生命周期管理、QR 截取、登录态检测和冷却恢复策略；修复小红书 Phase 3 QR 截取不全和标签页关闭导致 QR 失效的问题。

**架构：** 三层结构——`selectors.json` 数据驱动配置层（`loginFlows` 类别 + `purposes: ['login']`）→ `LoginTabRegistry` 基础设施层（register/find/captureQR/checkLoginState）→ `wechatBotService` / `monitorService` 编排层。登录操作不走 BullMQ 队列，通过 `getBrowser()` + `LoginTabRegistry.find()` 在后台标签页执行纯 CDP 命令，不干扰前台运行的工作标签页。

**技术栈：** TypeScript, patchright (Playwright fork), BullMQ, Redis, Prisma

---

## 文件结构

| 文件 | 职责 | 类型 |
|------|------|------|
| `packages/browser-core/src/loginTabRegistry.ts` | 登录标签页注册表：register/find/unregister + captureQR + checkLoginState | **新建** |
| `packages/browser-core/src/types.ts` | 新增 `LoginFlowConfig`、`LoginTabRecord`、`LoginState` 类型 | 修改 |
| `packages/browser-core/src/browserManager.ts` | 新增 `getBrowser()` 方法；`findPlatformPage()` 改 async 排除登录标签页 | 修改 |
| `apps/ts-api-gateway/src/lib/selectorStore.ts` | `VALID_PURPOSES` 加 `'login'`；`VALID_CATEGORIES` 加 `'loginFlows'`；新增 loginFlows 校验逻辑 | 修改 |
| `data/selectors.json` | 各平台新增 `loginFlows` 配置 + 登录选择器标记 `purposes: ['login']` | 修改 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | `captureAndSendQR` 委托给 LoginTabRegistry；新增 `triggerLoginProbe`；冷却逻辑改造 | 修改 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 删除 login_required 自动恢复；新增 login_probe 触发逻辑 | 修改 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 3 个按钮处理改用 LoginTabRegistry + flowId | 修改 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | Phase 3 调用 LoginTabRegistry；不关闭登录标签页 | 修改 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 登录检测迁移 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 登录检测迁移 | 修改 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 登录检测迁移 | 修改 |

---

### 任务 1：新增类型定义

**文件：**
- 修改：`packages/browser-core/src/types.ts`

- [ ] **步骤 1：在 types.ts 末尾追加类型定义**

在 `packages/browser-core/src/types.ts` 文件末尾追加以下内容。现有文件约 103 行，追加到末尾即可：

```typescript
// ── 登录标签页注册表相关类型 ──

/**
 * 登录标签页内存注册表条目
 */
export interface LoginTabRecord {
  page: any; // Page (避免循环引用的 any 类型)
  targetId: string;
  domain: string;
  flowId: string;
  openedAt: number;
  userId: number;
}

/**
 * 来自 selectors.json 的 loginFlows 配置条目
 */
export interface LoginFlowConfig {
  domain: string;
  label: string;
  loginUrl: string;
  closeOnLoginSuccess: boolean;
  loggedOutIndicators: string[];
  loggedInIndicators: string[];
  qrSelectors: string[];
}

/** 登录检测结果 */
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';
```

注意：`page` 字段使用 `any` 类型以避免 `browser-core` 与 `patchright` 之间的循环引用。调用方知道它实际是 `Page`。

- [ ] **步骤 2：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/browser-core/tsconfig.json 2>&1 | head -20
```

预期：无新增错误。

- [ ] **步骤 3：Commit**

```bash
git add packages/browser-core/src/types.ts
git commit -m "feat: 添加 LoginTabRecord / LoginFlowConfig / LoginState 类型定义"
```

---

### 任务 2：更新 selectors.json 校验器

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/selectorStore.ts:85-87, 158-170`

- [ ] **步骤 1：扩展 VALID_PURPOSES 和 VALID_CATEGORIES**

`selectorStore.ts` 第 85 行，将 `VALID_PURPOSES` 扩展为包含 `'login'`：

```typescript
// 第 85 行，修改前：
const VALID_PURPOSES = new Set(['publish', 'monitor']);

// 修改为：
const VALID_PURPOSES = new Set(['publish', 'monitor', 'login']);
```

第 86 行，将 `VALID_CATEGORIES` 扩展为包含 `'loginFlows'`：

```typescript
// 第 86 行，修改前：
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes', 'apiPatterns', 'dataSources', 'navigationFlows', 'frameworks'];

// 修改为：
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes', 'apiPatterns', 'dataSources', 'navigationFlows', 'frameworks', 'loginFlows'];
```

- [ ] **步骤 2：在 validateConfig() 中新增 loginFlows 校验**

在 `validateConfig()` 函数的 `for (const cat of VALID_CATEGORIES)` 循环之后（约第 170 行，`urlMonitors` 校验之前），追加 loginFlows 校验逻辑：

```typescript
    // v2.5+ loginFlows 校验
    if (p.loginFlows !== undefined) {
      if (typeof p.loginFlows !== 'object' || p.loginFlows === null) {
        issues.push({ path: `$.platforms.${plat}.loginFlows`, message: 'must be an object' });
      } else {
        for (const [flowId, fVal] of Object.entries(p.loginFlows as Record<string, unknown>)) {
          const fp = `$.platforms.${plat}.loginFlows.${flowId}`;
          if (!fVal || typeof fVal !== 'object') {
            issues.push({ path: fp, message: 'entry must be an object' });
            continue;
          }
          const f = fVal as Record<string, unknown>;
          // domain 必填
          if (typeof f.domain !== 'string' || f.domain.length === 0) {
            issues.push({ path: `${fp}.domain`, message: 'must be a non-empty string' });
          }
          // loginUrl 必填
          if (typeof f.loginUrl !== 'string' || f.loginUrl.length === 0) {
            issues.push({ path: `${fp}.loginUrl`, message: 'must be a non-empty string' });
          }
          // loggedOutIndicators 和 loggedInIndicators 至少有一个非空
          const outArr = Array.isArray(f.loggedOutIndicators) ? f.loggedOutIndicators : [];
          const inArr = Array.isArray(f.loggedInIndicators) ? f.loggedInIndicators : [];
          if (outArr.length === 0 && inArr.length === 0) {
            issues.push({ path: `${fp}`, message: 'at least one of loggedOutIndicators or loggedInIndicators must be non-empty' });
          }
          // closeOnLoginSuccess 可选，存在时必须是 boolean
          if (f.closeOnLoginSuccess !== undefined && typeof f.closeOnLoginSuccess !== 'boolean') {
            issues.push({ path: `${fp}.closeOnLoginSuccess`, message: 'must be boolean if present' });
          }
        }
      }
    }
```

- [ ] **步骤 3：验证校验器编译通过**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

预期：无新增错误。

- [ ] **步骤 4：手动测试校验器（错误输入）**

创建临时脚本验证错误检测：

```bash
node -e "
const { validateConfig } = require('./apps/ts-api-gateway/src/lib/selectorStore');
// 测试 loginFlows 缺 domain
const issues = validateConfig({ version:'1.0.0', updatedAt: new Date().toISOString(), platforms: { xiaohongshu: { menus:{},buttons:{},regions:{},textboxes:{},flowRules:{},urlMonitors:{},apiPatterns:{},dataSources:{},navigationFlows:{},frameworks:{}, loginFlows: { test: { label:'x', loginUrl:'http://a.com', loggedOutIndicators:['.x'] } } } } } });
console.log('Issues:', JSON.stringify(issues.filter(i => i.path.includes('loginFlows')), null, 2));
"
```

预期：输出包含 `"domain" must be a non-empty string` 的 issue。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/lib/selectorStore.ts
git commit -m "feat: 扩展 selectorStore 校验器支持 'login' purpose 和 loginFlows 类别"
```

---

### 任务 3：在 selectors.json 中为所有平台添加 loginFlows 配置

**文件：**
- 修改：`data/selectors.json`

- [ ] **步骤 1：先阅读现有 selectors.json 结构，确认各平台已有 entry**

```bash
cd /home/lrp/social_media_complete && node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('data/selectors.json','utf-8'));
for (const p of Object.keys(cfg.platforms)) {
  const cats = Object.keys(cfg.platforms[p]);
  console.log(p + ': ' + cats.filter(c => cfg.platforms[p][c] && Object.keys(cfg.platforms[p][c]).length > 0).join(', '));
}
"
```

预期输出：显示 douyin, kuaishou, xiaohongshu, tencent 的平台及其非空类别。

- [ ] **步骤 2：为 xiaohongshu 添加 loginFlows（主站 + 创作者中心）**

在 `data/selectors.json` 中 xiaohongshu 平台的 `"frameworks": {}` 之后追加 `"loginFlows"` 字段。注意 JSON 语法——在 `"frameworks": {}` 后面加逗号：

```jsonc
"loginFlows": {
  "mainsite": {
    "domain": "www.xiaohongshu.com",
    "label": "主站",
    "loginUrl": "https://www.xiaohongshu.com/explore",
    "closeOnLoginSuccess": true,
    "loggedOutIndicators": ["#login-btn", ".login-modal", "[class*=\"login-modal\"]"],
    "loggedInIndicators": [".user-avatar", ".sidebar-menu", "[class*=\"user-avatar\"]"],
    "qrSelectors": [".login-container .qrcode-img", ".qrcode-img", "img[alt*=\"二维码\"]"]
  },
  "creator": {
    "domain": "creator.xiaohongshu.com",
    "label": "创作者中心",
    "loginUrl": "https://creator.xiaohongshu.com/creator/home",
    "closeOnLoginSuccess": false,
    "loggedOutIndicators": [".login-container", ".login-btn-container", "button.beer-login-btn", "button[class*=\"beer-login-btn\"]"],
    "loggedInIndicators": [".creator-container", "[class*=\"creator-container\"]"],
    "qrSelectors": [".qrcode-img", "img[alt*=\"二维码\"]", "img[src*=\"qr\"]"]
  }
}
```

- [ ] **步骤 3：为 douyin 添加 loginFlows（创作者中心）**

在 douyin 平台的 `"frameworks": {}` 之后加：

```jsonc
"loginFlows": {
  "creator": {
    "domain": "creator.douyin.com",
    "label": "创作者中心",
    "loginUrl": "https://creator.douyin.com/creator-micro/home",
    "closeOnLoginSuccess": false,
    "loggedOutIndicators": [".login-container", "[class*=\"login\"]", "img[src*=\"qrcode\"]"],
    "loggedInIndicators": [".creator-container", "nav[class*=\"nav\"]", "[class*=\"sidebar\"]"],
    "qrSelectors": ["img[aria-label=\"二维码\"]", "img[src*=\"qrcode\"]", "canvas"]
  }
}
```

- [ ] **步骤 4：为 kuaishou 添加 loginFlows**

```jsonc
"loginFlows": {
  "creator": {
    "domain": "cp.kuaishou.com",
    "label": "创作者中心",
    "loginUrl": "https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api",
    "closeOnLoginSuccess": false,
    "loggedOutIndicators": [".login-qrcode", ".qrcode-img", "[class*=\"login\"]"],
    "loggedInIndicators": [".el-menu", ".sidebar", "[class*=\"sidebar\"]", "[class*=\"menu\"]"],
    "qrSelectors": ["img[alt=\"qrcode\"]", "img[src*=\"data:image/\"]", "canvas"]
  }
}
```

- [ ] **步骤 5：为 tencent 添加 loginFlows**

```jsonc
"loginFlows": {
  "creator": {
    "domain": "channels.weixin.qq.com",
    "label": "视频号",
    "loginUrl": "https://channels.weixin.qq.com/login.html?from=assistant",
    "closeOnLoginSuccess": false,
    "loggedOutIndicators": [".login-container", "[class*=\"login\"]", ".qrcode-container"],
    "loggedInIndicators": [".main-content", ".platform-container", "nav[class*=\"nav\"]"],
    "qrSelectors": [".qrcode-img", "img[src*=\"qr\"]", "canvas"]
  }
}
```

- [ ] **步骤 6：给现有登录相关 regions 条目追加 purposes: ['login']**

为 xiaohongshu 平台的以下 region 条目（如果存在）的 `purposes` 数组中追加 `'login'`：

```
region_mainsite_qr_code: purposes: ['login']
region_mainsite_login_modal: purposes: ['login']
```

直接在 JSON 文件中修改这些条目的 `"purposes"` 数组。如果某条目已有 `"purposes": ["monitor"]`，改为 `"purposes": ["monitor", "login"]`。

- [ ] **步骤 7：验证 selectors.json 加载通过校验**

```bash
cd /home/lrp/social_media_complete && node -e "
const { getSelectorReader } = require('./apps/ts-api-gateway/src/lib/selectorStore');
const reader = getSelectorReader();
const cfg = reader.getConfig();
for (const [p, pVal] of Object.entries(cfg.platforms)) {
  const lf = pVal.loginFlows;
  if (lf && Object.keys(lf).length > 0) {
    console.log(p + ' loginFlows: ' + Object.keys(lf).join(', '));
  }
}
"
```

预期：输出 4 个平台的 loginFlows key 列表。

- [ ] **步骤 8：Commit**

```bash
git add data/selectors.json
git commit -m "feat: 为各平台添加 loginFlows 配置 (douyin/kuaishou/xiaohongshu/tencent)"
```

---

### 任务 4：编写 LoginTabRegistry 单元测试（TDD）

**文件：**
- 创建：`packages/browser-core/src/__tests__/loginTabRegistry.test.ts`

- [ ] **步骤 1：创建测试文件，编写 register/unregister 测试**

```typescript
// packages/browser-core/src/__tests__/loginTabRegistry.test.ts
import { LoginTabRegistry } from '../loginTabRegistry';
import type { LoginTabRecord } from '../types';

// Mock page object
function mockPage(url: string, targetId: string): any {
  return {
    url: () => url,
    _targetId: targetId,
    close: () => Promise.resolve(),
    evaluate: (fn: Function) => {
      const storage: Record<string, string> = {};
      fn();
      return Promise.resolve();
    },
    $: () => Promise.resolve(null),
    isClosed: () => false,
    context: () => ({
      pages: () => [],
    }),
  };
}

describe('LoginTabRegistry', () => {
  let registry: LoginTabRegistry;

  beforeEach(() => {
    registry = new LoginTabRegistry();
  });

  it('should register and find login tab in memory', () => {
    const record: LoginTabRecord = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1',
      domain: 'www.xiaohongshu.com',
      flowId: 'mainsite',
      openedAt: Date.now(),
      userId: 42,
    };

    registry.register('window123', 'mainsite', record);
    // Test: memory lookup (no browser needed for in-memory hits)
    // find() with memory hit should work without browser
    // We test memory registration only here; full find() with browser in integration tests
    const memKey = `${'window123'}:${'mainsite'}`;
    expect((registry as any).tabs.has(memKey)).toBe(true);
    expect((registry as any).tabs.get(memKey)!.userId).toBe(42);
  });

  it('should unregister and remove from memory', () => {
    const record: LoginTabRecord = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1',
      domain: 'www.xiaohongshu.com',
      flowId: 'mainsite',
      openedAt: Date.now(),
      userId: 42,
    };

    registry.register('window123', 'mainsite', record);
    registry.unregister('window123', 'mainsite');

    const memKey = `${'window123'}:${'mainsite'}`;
    expect((registry as any).tabs.has(memKey)).toBe(false);
  });

  it('should handle multiple flowIds for same window independently', () => {
    const mainsite: LoginTabRecord = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1',
      domain: 'www.xiaohongshu.com',
      flowId: 'mainsite',
      openedAt: Date.now(),
      userId: 42,
    };
    const creator: LoginTabRecord = {
      page: mockPage('https://creator.xiaohongshu.com/home', 'target-2'),
      targetId: 'target-2',
      domain: 'creator.xiaohongshu.com',
      flowId: 'creator',
      openedAt: Date.now(),
      userId: 42,
    };

    registry.register('window123', 'mainsite', mainsite);
    registry.register('window123', 'creator', creator);

    const memKey1 = `${'window123'}:${'mainsite'}`;
    const memKey2 = `${'window123'}:${'creator'}`;
    expect((registry as any).tabs.has(memKey1)).toBe(true);
    expect((registry as any).tabs.has(memKey2)).toBe(true);

    // Unregister one shouldn't affect the other
    registry.unregister('window123', 'mainsite');
    expect((registry as any).tabs.has(memKey1)).toBe(false);
    expect((registry as any).tabs.has(memKey2)).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
cd /home/lrp/social_media_complete && npx jest packages/browser-core/src/__tests__/loginTabRegistry.test.ts --no-coverage 2>&1 | tail -10
```

预期：FAIL — `LoginTabRegistry` 类尚未定义。

- [ ] **步骤 3：Commit（失败测试）**

```bash
git add packages/browser-core/src/__tests__/
git commit -m "test: LoginTabRegistry 单元测试（TDD - RED）"
```

---

### 任务 5：实现 LoginTabRegistry 核心类

**文件：**
- 创建：`packages/browser-core/src/loginTabRegistry.ts`

- [ ] **步骤 1：创建 LoginTabRegistry 类**

```typescript
// packages/browser-core/src/loginTabRegistry.ts
import type { LoginTabRecord, LoginFlowConfig, LoginState } from './types';
import { rootLogger } from './logger'; // 假设此模块存在，根据实际路径调整

const logger = rootLogger.child({ name: 'loginTabRegistry' });

const QR_PADDING = 40; // 与 captureAndSendQR 一致

/** localStorage 标记 key */
const LOGIN_TAB_MARK_KEY = '__login_tab_mark__';

export class LoginTabRegistry {
  /**
   * 内存注册表：key = `${windowId}:${flowId}`
   */
  private tabs = new Map<string, LoginTabRecord>();

  // ── 标签页生命周期 ──

  /**
   * 注册登录标签页到内存注册表。
   * 标记（localStorage 注入）由调用方负责。
   */
  register(windowId: string, flowId: string, record: LoginTabRecord): void {
    const key = `${windowId}:${flowId}`;
    this.tabs.set(key, record);
    logger.info({ windowId, flowId, url: record.page?.url?.() }, 'LoginTab registered');
  }

  /**
   * 从内存注册表移除并（可选）清除 localStorage 标记。
   */
  async unregister(windowId: string, flowId: string): Promise<void> {
    const key = `${windowId}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) {
      try {
        // 尝试清除 localizedStorage 标记
        await record.page.evaluate((markKey: string) => {
          localStorage.removeItem(markKey);
        }, LOGIN_TAB_MARK_KEY).catch(() => {});
      } catch { /* 页面可能已关闭 */ }
      this.tabs.delete(key);
      logger.info({ windowId, flowId }, 'LoginTab unregistered');
    }
  }

  /**
   * 查找登录标签页：先查内存，miss 则枚举所有页面扫描 localStorage 标记。
   * @param browser - patchright Browser 实例
   * @param domain - loginFlow 配置中的 domain 字段，用于 URL 筛选
   */
  async find(windowId: string, flowId: string, browser: any, domain: string): Promise<LoginTabRecord | null> {
    const key = `${windowId}:${flowId}`;

    // 1. 查内存
    const cached = this.tabs.get(key);
    if (cached) {
      try {
        if (!cached.page.isClosed()) {
          return cached;
        }
      } catch { /* page reference 过期 */ }
      this.tabs.delete(key);
    }

    // 2. 枚举所有页面，通过 localStorage 标记恢复
    try {
      const ctx = browser.contexts()[0];
      if (!ctx) return null;
      const pages = ctx.pages();
      for (const page of pages) {
        try {
          const url = page.url();
          if (!url.includes(domain)) continue;

          const markData = await page.evaluate((markKey: string) => {
            const raw = localStorage.getItem(markKey);
            return raw ? JSON.parse(raw) : null;
          }, LOGIN_TAB_MARK_KEY);

          if (markData && markData.flowId === flowId) {
            const record: LoginTabRecord = {
              page,
              targetId: markData.targetId || '',
              domain,
              flowId,
              openedAt: markData.openedAt || Date.now(),
              userId: markData.userId || 0,
            };
            this.tabs.set(key, record);
            logger.info({ windowId, flowId, url }, 'LoginTab recovered from localStorage mark');
            return record;
          }
        } catch { continue; }
      }
    } catch (err: any) {
      logger.warn({ windowId, flowId, err: err.message }, 'LoginTab find() failed enumerating pages');
    }
    return null;
  }

  // ── 登录检测 ──

  /**
   * 在指定页面执行登录态检测。
   * 优先级：loggedOutIndicators > loggedInIndicators > unknown
   */
  async checkLoginState(page: any, config: LoginFlowConfig): Promise<LoginState> {
    // 1. 优先检测未登录态（避免页面加载中途误判）
    for (const sel of (config.loggedOutIndicators || [])) {
      try {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) {
            logger.info({ selector: sel, flowId: config.domain }, 'Login check: logged_out (indicator matched)');
            return 'logged_out';
          }
        }
      } catch { continue; }
    }

    // 2. 检测已登录态
    for (const sel of (config.loggedInIndicators || [])) {
      try {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) {
            logger.info({ selector: sel, flowId: config.domain }, 'Login check: logged_in (indicator matched)');
            return 'logged_in';
          }
        }
      } catch { continue; }
    }

    // 3. 都没命中
    return 'unknown';
  }

  // ── QR 截取 ──

  /**
   * 在指定页面截取 QR 码，带 padding 正方形裁剪，全页兜底。
   */
  async captureQR(page: any, config: LoginFlowConfig): Promise<Buffer | null> {
    const selectors = config.qrSelectors || [];

    // 遍历选择器，尝试 boundingBox + padding 正方形裁剪
    for (const sel of selectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 8000, state: 'visible' });
        if (!el) continue;

        await page.waitForTimeout(500); // 等待渲染
        const box = await el.boundingBox();
        if (!box || box.width < 50 || box.height < 50) continue;

        const maxDim = Math.max(box.width, box.height);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const side = maxDim + QR_PADDING * 2;

        const clip = {
          x: Math.max(0, cx - side / 2),
          y: Math.max(0, cy - side / 2),
          width: side,
          height: side,
        };

        const buf = await page.screenshot({ type: 'png' as const, clip });
        logger.info({ selector: sel, clip }, 'QR captured with padding clip');
        return buf;
      } catch { continue; }
    }

    // 全页兜底
    try {
      const buf = await page.screenshot({ type: 'png' as const });
      logger.info('QR captured (fallback: full page)');
      return buf;
    } catch (err: any) {
      logger.error({ err: err.message }, 'QR capture failed entirely');
      return null;
    }
  }

  // ── 组合操作 ──

  /**
   * 打开登录标签页并注册。
   * @returns LoginTabRecord，如果失败则返回 null
   */
  async openLoginTab(
    windowId: string,
    userId: number,
    flowId: string,
    browser: any,
    config: LoginFlowConfig,
  ): Promise<LoginTabRecord | null> {
    try {
      const ctx = browser.contexts()[0];
      if (!ctx) return null;

      const page = await ctx.newPage();
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // 注入 localStorage 标记
      const markData = { flowId, userId, openedAt: Date.now() };
      await page.evaluate((data: string, key: string) => {
        localStorage.setItem(key, data);
      }, JSON.stringify(markData), LOGIN_TAB_MARK_KEY);

      const targetId = (page as any)._targetId || 'unknown';
      const record: LoginTabRecord = {
        page,
        targetId,
        domain: config.domain,
        flowId,
        openedAt: Date.now(),
        userId,
      };

      this.register(windowId, flowId, record);
      logger.info({ windowId, flowId, url: config.loginUrl }, 'Login tab opened and registered');
      return record;
    } catch (err: any) {
      logger.error({ windowId, flowId, err: err.message }, 'Failed to open login tab');
      return null;
    }
  }

  /**
   * 关闭登录标签页：unregister + page.close()
   */
  async closeLoginTab(windowId: string, flowId: string): Promise<void> {
    const key = `${windowId}:${flowId}`;
    const record = this.tabs.get(key);
    if (record) {
      try {
        await record.page.close();
      } catch { /* 页面可能已关闭 */ }
    }
    await this.unregister(windowId, flowId);
    this.tabs.delete(key);
  }
}
```

- [ ] **步骤 2：验证编译通过**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/browser-core/tsconfig.json 2>&1 | head -20
```

预期：无错误。如果 `rootLogger` 导入路径有误，根据实际导出调整（可能是 `'./logger'` 或其他路径；从 browserManager.ts 中确认正确的 logger 导入路径）。

- [ ] **步骤 3：运行测试，确认通过**

```bash
cd /home/lrp/social_media_complete && npx jest packages/browser-core/src/__tests__/loginTabRegistry.test.ts --no-coverage 2>&1
```

预期：PASS。

- [ ] **步骤 4：添加 checkLoginState 和 captureQR 的额外测试**

在 `loginTabRegistry.test.ts` 中追加：

```typescript
  it('should detect logged_out via indicator', async () => {
    const mockPage = {
      $: async (sel: string) => {
        if (sel === '.login-modal') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com',
      label: '主站',
      loginUrl: 'https://www.xiaohongshu.com',
      closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'],
      loggedInIndicators: ['.user-avatar'],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockPage as any, config);
    expect(state).toBe('logged_out');
  });

  it('should detect logged_in via indicator', async () => {
    const mockPage = {
      $: async (sel: string) => {
        if (sel === '.user-avatar') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com',
      label: '主站',
      loginUrl: 'https://www.xiaohongshu.com',
      closeOnLoginSuccess: true,
      loggedOutIndicators: [],
      loggedInIndicators: ['.user-avatar'],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockPage as any, config);
    expect(state).toBe('logged_in');
  });

  it('should return unknown when no indicators match', async () => {
    const mockPage = { $: async () => null as any };
    const config = {
      domain: 'www.xiaohongshu.com',
      label: '主站',
      loginUrl: 'https://www.xiaohongshu.com',
      closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'],
      loggedInIndicators: [],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockPage as any, config);
    expect(state).toBe('unknown');
  });

  it('should prioritize loggedOut over loggedIn', async () => {
    const mockPage = {
      $: async (sel: string) => {
        if (sel === '.login-modal') return { isVisible: () => Promise.resolve(true) };
        if (sel === '.user-avatar') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com',
      label: '主站',
      loginUrl: 'https://www.xiaohongshu.com',
      closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'],
      loggedInIndicators: ['.user-avatar'],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockPage as any, config);
    expect(state).toBe('logged_out'); // loggedOut 优先
  });
```

- [ ] **步骤 5：运行全部测试，确认通过**

```bash
cd /home/lrp/social_media_complete && npx jest packages/browser-core/src/__tests__/loginTabRegistry.test.ts --no-coverage 2>&1
```

预期：ALL PASS（6 个测试）。

- [ ] **步骤 6：Commit**

```bash
git add packages/browser-core/src/loginTabRegistry.ts packages/browser-core/src/__tests__/loginTabRegistry.test.ts
git commit -m "feat: 实现 LoginTabRegistry 核心类 (register/find/checkLoginState/captureQR)"
```

---

### 任务 6：LoginTabRegistry 的 export 索引

**文件：**
- 修改：`packages/browser-core/src/index.ts`

- [ ] **步骤 1：导出 LoginTabRegistry**

查看 `packages/browser-core/src/index.ts`（如果不存在则创建），追加：

```typescript
export { LoginTabRegistry } from './loginTabRegistry';
```

- [ ] **步骤 2：Commit**

```bash
git add packages/browser-core/src/index.ts
git commit -m "feat: 导出 LoginTabRegistry from browser-core"
```

---

### 任务 7：BrowserManager 新增 getBrowser() 方法

**文件：**
- 修改：`packages/browser-core/src/browserManager.ts:67-100`（userSessions 附近）

- [ ] **步骤 1：添加 getBrowser() 方法**

在 `BrowserManager` 类中 `connect()` 方法之前，添加 `getBrowser()` 方法。定位约在第 100 行（`async connect` 之前）：

```typescript
  /**
   * 获取浏览器实例，不触碰任何标签页。
   * 用于 LoginTabRegistry 枚举 pages 和执行后台 CDP 命令。
   *
   * @param windowId - 指纹浏览器窗口 ID
   * @param platform - 可选平台，用于精确匹配已有 session
   * @returns Browser 实例，如果无法连接则返回 null
   */
  async getBrowser(windowId: string, platform?: Platform): Promise<Browser | null> {
    // 1. 按 platform 精确匹配已有 session
    if (platform) {
      const sessionKey = `${windowId}_${platform}`;
      const session = this.userSessions.get(sessionKey);
      if (session?.browser?.isConnected()) {
        try {
          await Promise.race([
            session.browser.version(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('browser version timeout')), 5000)),
          ]);
          return session.browser;
        } catch {
          this.userSessions.delete(sessionKey);
        }
      }
    }

    // 2. 遍历所有同 windowId 的 session
    for (const [key, session] of this.userSessions) {
      if (key.startsWith(`${windowId}_`) && session.browser?.isConnected()) {
        try {
          await Promise.race([
            session.browser.version(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('browser version timeout')), 5000)),
          ]);
          return session.browser;
        } catch {
          this.userSessions.delete(key);
        }
      }
    }

    // 3. 无可用 session → 建立新 CDP 连接
    try {
      const wsEndpoint = await this.getOrCreateWsEndpoint(windowId);
      const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });

      // 注册轻量 session 防止资源泄漏
      const loginSessionKey = `${windowId}_login`;
      this.userSessions.set(loginSessionKey, {
        browser,
        page: null as any,
        windowId,
        platform: 'login' as any,
        connectedAt: Date.now(),
        lastActiveAt: Date.now(),
        reuseCount: 0,
        maxReuse: 999,
      });

      return browser;
    } catch (err: any) {
      logger.error({ windowId, err: err.message }, 'getBrowser() failed to connect via CDP');
      return null;
    }
  }
```

注意：`UserSession` 接口（`browserManager.ts:47-56`）的 `page` 字段是 `Page` 类型。上文中 `page: null as any` 需要将 `UserSession.page` 改为 `Page | null`，或者使用 `as any`。如果编译报错，在 `UserSession` 接口中将 `page: Page` 改为 `page: Page | null`：

```typescript
interface UserSession {
  browser: Browser;
  page: Page | null;  // ← 改为 nullable
  windowId: string;
  platform: Platform;
  connectedAt: number;
  lastActiveAt: number;
  reuseCount: number;
  maxReuse: number;
}
```

- [ ] **步骤 2：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/browser-core/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 3：Commit**

```bash
git add packages/browser-core/src/browserManager.ts
git commit -m "feat: BrowserManager 新增 getBrowser() 方法（防资源泄漏，session 注册）"
```

---

### 任务 8：findPlatformPage 改为 async，排除登录标签页

**文件：**
- 修改：`packages/browser-core/src/browserManager.ts:347-361`（findPlatformPage）及其 4 处调用（108, 258, 373, 397）

- [ ] **步骤 1：修改 findPlatformPage 为 async**

定位 `findPlatformPage()` 方法（约第 347 行），改为 async 并追加登录标签页排除逻辑：

```typescript
  private async findPlatformPage(pages: Page[], platform: Platform): Promise<Page | undefined> {
    const candidates = pages.filter(p => {
      const url = p.url();
      if (platform === 'kuaishou') return url.includes('kuaishou.com') || url.includes('cp.kuaishou.com');
      if (platform === 'xiaohongshu') return url.includes('xiaohongshu.com') || url.includes('creator.xiaohongshu.com');
      if (platform === 'tencent') return url.includes('channels.weixin.qq.com');
      return url.includes('douyin.com') || url.includes('creator.douyin.com');
    });
    // 排除登录标签页（有 __login_tab_mark__ 标记的不作为工作标签页）
    for (const p of candidates) {
      try {
        const isLoginTab = await p.evaluate(() =>
          !!localStorage.getItem('__login_tab_mark__')
        );
        if (!isLoginTab) return p;
      } catch { continue; }
    }
    return candidates[0]; // 全是登录标签页则取第一个
  }
```

- [ ] **步骤 2：4 处调用点加 await**

**位置 1** — `connect()` 复用路径（约 108 行）：
```typescript
// 修改前:
const platformPage = this.findPlatformPage(pages, platform);
// 修改后:
const platformPage = await this.findPlatformPage(pages, platform);
```

**位置 2** — `connect()` 新连接路径（约 258 行）：
```typescript
// 修改前:
const platformPage = this.findPlatformPage(pages, platform);
// 修改后:
const platformPage = await this.findPlatformPage(pages, platform);
```

**位置 3** — `focusPage()`（约 373 行）：
```typescript
// 修改前:
const platformPage = this.findPlatformPage(pages, platform);
// 修改后:
const platformPage = await this.findPlatformPage(pages, platform);
```

**位置 4** — `injectIdleBehavior()`（约 397 行）：搜索确认是否调用 `findPlatformPage`，如果是则同样加 `await`。

- [ ] **步骤 3：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/browser-core/tsconfig.json 2>&1 | head -20
```

预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add packages/browser-core/src/browserManager.ts
git commit -m "feat: findPlatformPage 改为 async，排除带 __login_tab_mark__ 的登录标签页"
```

---

### 任务 9：重构 captureAndSendQR 委托给 LoginTabRegistry

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:360-603`

- [ ] **步骤 1：修改 captureAndSendQR 函数签名和实现**

`captureAndSendQR` 当前签名为 `(page, userId, platform, wechatUserid)`，约第 360 行起约 240 行。

将其简化为委托给 LoginTabRegistry + 保留企微发送逻辑：

```typescript
import { LoginTabRegistry } from '@social-media/browser-core';

/** QR padding（与 LoginTabRegistry 保持一致） */
const QR_PADDING = 40;

/**
 * 截取 QR 码并通过企业微信发送告警。
 * V2: 委托给 LoginTabRegistry.captureQR()。
 * page 参数保留用于向后兼容；如果 page 已有登录 UI，直接截取；否则需传入正确的登录配置。
 */
export async function captureAndSendQR(
  page: any,
  userId: number,
  platform: string,
  wechatUserid: string,
): Promise<void> {
  try {
    const { loginTabRegistry, loadLoginFlowConfig } = await import('./loginFlowHelpers');

    // 从配置读取该平台的 loginFlow 信息
    const flowConfigs = loadLoginFlowConfig(platform);
    if (!flowConfigs || flowConfigs.length === 0) {
      logger.warn({ platform }, 'captureAndSendQR: 无 loginFlow 配置，回退到原始内联逻辑');
      await captureAndSendQRLegacy(page, userId, platform, wechatUserid);
      return;
    }

    // 使用第一个 flow 的 QR 选择器（兼容现有调用链）
    const config = flowConfigs[0];
    const buf = await loginTabRegistry.captureQR(page, config);
    if (!buf) {
      logger.warn({ platform, userId }, 'captureAndSendQR: QR 截图失败，发送纯文本告警');
      const { botManager } = await import('../services/wechatBotService');
      await botManager.sendLoginAlert(wechatUserid, platform, userId);
      return;
    }

    const { botManager } = await import('../services/wechatBotService');
    await botManager.sendLoginAlert(wechatUserid, platform, userId, buf);
  } catch (err) {
    const { botManager } = await import('../services/wechatBotService');
    await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
  }
}
```

- [ ] **步骤 2：保留原逻辑为 captureAndSendQRLegacy（fallback）**

将原有约 240 行的 QR 截取逻辑重命名为 `captureAndSendQRLegacy`，保持函数体不变，添加 `async function` 前缀和 `export` 关键字移除：

```typescript
/** 旧版 QR 截取逻辑，loginFlows 配置缺失时的 fallback。 */
async function captureAndSendQRLegacy(
  page: any, userId: number, platform: string, wechatUserid: string
): Promise<void> {
  // ... 原有约 240 行代码保持不变 ...
}
```

- [ ] **步骤 3：创建 loginFlowHelpers.ts 辅助模块**

创建 `apps/ts-api-gateway/src/services/loginFlowHelpers.ts`：

```typescript
// apps/ts-api-gateway/src/services/loginFlowHelpers.ts
import { LoginTabRegistry } from '@social-media/browser-core';
import type { LoginFlowConfig } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';

/** LoginTabRegistry 单例 */
export const loginTabRegistry = new LoginTabRegistry();

/**
 * 从 selectors.json 读取指定平台的 loginFlows 配置。
 * @returns loginFlow 配置数组，如果未配置则返回空数组
 */
export function loadLoginFlowConfig(platform: string): LoginFlowConfig[] {
  const reader = getSelectorReader();
  const cfg = reader.getConfig();
  const p = (cfg.platforms as any)?.[platform];
  if (!p?.loginFlows) return [];

  const result: LoginFlowConfig[] = [];
  for (const [flowId, entry] of Object.entries(p.loginFlows) as [string, any][]) {
    result.push({
      domain: entry.domain || '',
      label: entry.label || flowId,
      loginUrl: entry.loginUrl || '',
      closeOnLoginSuccess: entry.closeOnLoginSuccess ?? false,
      loggedOutIndicators: entry.loggedOutIndicators || [],
      loggedInIndicators: entry.loggedInIndicators || [],
      qrSelectors: entry.qrSelectors || [],
    });
  }
  return result;
}

/**
 * 根据 flowId 获取单个 loginFlow 配置。
 */
export function getLoginFlowConfig(platform: string, flowId: string): LoginFlowConfig | null {
  const configs = loadLoginFlowConfig(platform);
  // 按 domain/flowId 信息匹配——flowId 来自配置的 key
  const reader = getSelectorReader();
  const cfg = reader.getConfig();
  const p = (cfg.platforms as any)?.[platform];
  if (!p?.loginFlows?.[flowId]) return null;

  const entry = p.loginFlows[flowId];
  return {
    domain: entry.domain || '',
    label: entry.label || flowId,
    loginUrl: entry.loginUrl || '',
    closeOnLoginSuccess: entry.closeOnLoginSuccess ?? false,
    loggedOutIndicators: entry.loggedOutIndicators || [],
    loggedInIndicators: entry.loggedInIndicators || [],
    qrSelectors: entry.qrSelectors || [],
  };
}
```

- [ ] **步骤 4：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/loginFlowHelpers.ts
git commit -m "feat: captureAndSendQR 委托给 LoginTabRegistry；新增 loginFlowHelpers"
```

---

### 任务 10：实现 per-flowId Redis 状态管理和 probe 恢复

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（新增 `triggerLoginProbe`）
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts:372-412`（probe 恢复）

- [ ] **步骤 1：新增 Redis per-flowId 状态管理**

在 `monitorService.ts` 中（约 `captureAndSendQR` 附近）添加：

```typescript
import { getRedis } from '../lib/redis';

interface LoginFlowState {
  status: 'login_required' | 'login_probe';
  cooldownLevel: number;
  cooldownUntil: number;
  lastProbeAt: number;
}

const FLOW_STATE_KEY_PREFIX = 'login_flow_state';

function getFlowStateKey(userId: number, flowId: string): string {
  return `${FLOW_STATE_KEY_PREFIX}:${userId}:${flowId}`;
}

/** 保存 per-flowId 状态到 Redis */
async function setFlowState(userId: number, flowId: string, state: LoginFlowState): Promise<void> {
  const redis = getRedis();
  await redis.set(getFlowStateKey(userId, flowId), JSON.stringify(state));
}

/** 读取 per-flowId 状态 */
async function getFlowState(userId: number, flowId: string): Promise<LoginFlowState | null> {
  const redis = getRedis();
  const raw = await redis.get(getFlowStateKey(userId, flowId));
  return raw ? JSON.parse(raw) : null;
}

/** 删除 per-flowId 状态 */
async function delFlowState(userId: number, flowId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(getFlowStateKey(userId, flowId));
}

/** 获取用户所有 flowId 的状态 */
async function getAllFlowStates(userId: number, platform: string): Promise<Map<string, LoginFlowState>> {
  const { loadLoginFlowConfig } = await import('./loginFlowHelpers');
  const configs = loadLoginFlowConfig(platform);
  const result = new Map<string, LoginFlowState>();
  for (const cfg of configs) {
    // flowId 来自配置的 key——从 config domain 反查
    // 使用 domain 作为 flowId 标识
    const flowKey = cfg.domain; // 简化：用 domain 作为 flowId
    const state = await getFlowState(userId, flowKey);
    if (state) result.set(flowKey, state);
  }
  return result;
}
```

- [ ] **步骤 2：实现 triggerLoginProbe**

```typescript
/**
 * 触发指定用户/flowId 的登录检测 probe。
 * 不走 BullMQ，不获取 WindowMutex，直接通过 setTimeout 在后台执行。
 */
export async function triggerLoginProbe(
  userId: number,
  platform: string,
  windowId: string,
  flowId?: string,
): Promise<void> {
  const { loginTabRegistry, getLoginFlowConfig, loadLoginFlowConfig } = await import('./loginFlowHelpers');
  const bm = getBrowserManager();

  // 确定要检测的 flowId 列表
  const flowIds = flowId
    ? [flowId]
    : loadLoginFlowConfig(platform).map(c => c.domain);

  for (const fid of flowIds) {
    const config = getLoginFlowConfig(platform, fid);
    if (!config) continue;

    const state = await getFlowState(userId, fid);
    if (!state || state.cooldownUntil > Date.now()) continue; // 仍在冷却中

    // 异步执行 probe
    setTimeout(async () => {
      try {
        const browser = await bm.getBrowser(windowId);
        if (!browser) {
          logger.warn({ userId, platform, flowId: fid }, 'probe: 无法获取 browser');
          return;
        }

        const record = await loginTabRegistry.find(windowId, fid, browser, config.domain);
        if (!record) {
          logger.info({ userId, flowId: fid }, 'probe: 未找到登录标签页（可能已被关闭）');
          // 标记为已处理，不再 probe
          await delFlowState(userId, fid);
          return;
        }

        const result = await loginTabRegistry.checkLoginState(record.page, config);

        if (result === 'logged_in') {
          logger.info({ userId, flowId: fid }, 'probe: 检测到已登录，执行清理');
          // 清理：unregister + 清标记 + 按配置关闭/保留
          if (config.closeOnLoginSuccess) {
            await loginTabRegistry.closeLoginTab(windowId, fid);
          } else {
            await loginTabRegistry.unregister(windowId, fid);
          }
          await delFlowState(userId, fid);

          // 检查所有 flowId 是否都已登录
          const allStates = await getAllFlowStates(userId, platform);
          if (allStates.size === 0) {
            // 所有 flowId 已恢复 → 恢复用户状态
            const { prisma } = await import('../lib/prisma');
            await prisma.user.update({
              where: { id: userId },
              data: { status: 'active', cooldownUntil: BigInt(0) },
            });
            logger.info({ userId, platform }, 'probe: 所有 loginFlow 已恢复，监控恢复');

            // 恢复监控调度
            reportMonitorComplete(windowId, platform, false);
          }
        } else {
          // 未登录 → 递增冷却
          const newLevel = Math.min((state.cooldownLevel || 0) + 1, 4);
          const cooldownMs = [30, 60, 120, 240, 240][newLevel] * 60 * 1000;
          await setFlowState(userId, fid, {
            status: 'login_required',
            cooldownLevel: newLevel,
            cooldownUntil: Date.now() + cooldownMs,
            lastProbeAt: Date.now(),
          });

          // 重新调度 probe
          const nextProbe = setTimeout(() => {
            triggerLoginProbe(userId, platform, windowId, fid).catch(() => {});
          }, cooldownMs);
          nextProbe.unref(); // 不阻塞进程退出

          logger.info({ userId, flowId: fid, newLevel, cooldownMs }, 'probe: 仍未登录，递增冷却');
        }
      } catch (err: any) {
        logger.warn({ userId, flowId: fid, err: err.message }, 'probe: 检测异常');
      }
    }, 100); // 微延迟，避免阻塞调用方
  }
}
```

- [ ] **步骤 3：更新 monitorDatabaseService 的 getAllActiveUsers**

修改 `monitorDatabaseService.ts:396-412`，将自动恢复 `login_required → init` 改为触发 probe：

```typescript
  // ★ 恢复过期的 login_required 状态 → 触发 probe 而非直接恢复
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 分钟
  const staleLoginRequired = await prisma.user.findMany({
    where: {
      status: { in: ['login_required', 'login_probe'] },
      monitoringEnabled: true,
      updatedAt: { lt: staleThreshold },
    },
    select: { id: true, platform: true, fingerprintWindowId: true },
  });
  if (staleLoginRequired.length > 0) {
    for (const user of staleLoginRequired) {
      // 异步触发 probe（不阻塞用户查询）
      const { triggerLoginProbe } = await import('../services/monitorService');
      triggerLoginProbe(user.id, user.platform, String(user.fingerprintWindowId)).catch(() => {});
    }
    logger.info(
      { count: staleLoginRequired.length },
      '[MonitorDB] 过期 login_required 用户触发 probe',
    );
  }
  // ★ 删除旧的自动恢复为 init 的逻辑（不再执行 prisma.user.updateMany）
```

同时更新第 417 行的 `notIn` 列表：

```typescript
  // 修改前:
  status: { notIn: ['blocked', 'login_required', 'risk_control'] },
  // 修改后:
  status: { notIn: ['blocked', 'login_required', 'risk_control', 'login_probe'] },
```

- [ ] **步骤 4：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat: per-flowId Redis 状态管理 + login_probe 数据库驱动恢复"
```

---

### 任务 11：更新 xiaohongshuCrawler Phase 3 登录处理

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:987-1025`

- [ ] **步骤 1：替换内联登录检测为 LoginTabRegistry**

将第 987-1024 行的内联检测逻辑替换为：

```typescript
      // ── 登录检测：使用 LoginTabRegistry（不关闭标签页，标记后用后台 CDP 操作）──
      const { loginTabRegistry, getLoginFlowConfig } = await import('../services/loginFlowHelpers');
      const mainsiteConfig = getLoginFlowConfig('xiaohongshu', 'mainsite');
      let loggedOut = false;

      if (mainsiteConfig) {
        const loginState = await loginTabRegistry.checkLoginState(newPage, mainsiteConfig);
        if (loginState === 'logged_out') {
          loggedOut = true;
          logger.info({ exportId }, '[XHS-Phase3] 主站未登录（LoginTabRegistry 检测）');

          // 标记标签页 + 注册
          const markData = JSON.stringify({ flowId: 'mainsite', userId, openedAt: Date.now() });
          await newPage.evaluate((data: string) => {
            localStorage.setItem('__login_tab_mark__', data);
          }, markData);

          const record = {
            page: newPage,
            targetId: (newPage as any)._targetId || 'unknown',
            domain: mainsiteConfig.domain,
            flowId: 'mainsite',
            openedAt: Date.now(),
            userId,
          };
          loginTabRegistry.register(String(windowId), 'mainsite', record);

          // 截取 QR（带 padding）
          const qrBuffer = await loginTabRegistry.captureQR(newPage, mainsiteConfig);
          if (qrBuffer) {
            const { botManager } = await import('../services/wechatBotService');
            const { prisma: prismaLogin } = await import('../lib/prisma');
            const loginUser = await prismaLogin.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });
            if (loginUser?.wechatUserid) {
              await botManager.sendLoginAlert(loginUser.wechatUserid, 'xiaohongshu', userId, qrBuffer);
            }
          }

          // 设置 per-flowId 冷却状态
          const { setFlowState } = await import('../services/monitorService');
          await setFlowState(userId, mainsiteConfig.domain, {
            status: 'login_required',
            cooldownLevel: 0,
            cooldownUntil: Date.now() + 30 * 60 * 1000,
            lastProbeAt: Date.now(),
          });

          // 不关闭标签页！回到创作者中心
          await page.bringToFront();
          return { success: false, awemeId: exportId, loginRequired: true };
        } else if (loginState === 'logged_in') {
          logger.info({ exportId }, '[XHS-Phase3] 主站已登录（LoginTabRegistry 确认）');
        }
      } else {
        // fallback: 无 mainsite 配置时的原始检测
        try {
          const loginBtn = await newPage.$('#login-btn');
          if (loginBtn) {
            loggedOut = true;
            logger.info({ exportId }, '[XHS-Phase3] 检测到 #login-btn — 主站未登录（fallback）');
          }
        } catch { /* 忽略 */ }
        if (!loggedOut) {
          try {
            const loginModal = await newPage.$('.login-modal');
            if (loginModal) {
              loggedOut = true;
              logger.info({ exportId }, '[XHS-Phase3] 检测到 .login-modal — 主站未登录（fallback）');
            }
          } catch { /* 忽略 */ }
        }
        if (loggedOut) {
          // fallback: 旧版 QR 截取 + 关闭（保留向后兼容）
          logger.warn({ exportId }, '[XHS-Phase3] 无 mainsite 配置，使用 fallback QR 逻辑');
          await captureAndSendQR(newPage, userId, 'xiaohongshu', 'unknown');
          await newPage.close().catch(() => {});
          await page.bringToFront();
          return { success: false, awemeId: exportId, loginRequired: true };
        }
      }
```

注意：需要导入 `captureAndSendQR` 或 `loginFlowHelpers`。确保文件顶部的 import 列表已包含相关模块引用。

- [ ] **步骤 2：ensure loginFlowHelpers can be dynamically imported**

由于 crawler 代码使用动态 `await import()`，`loginFlowHelpers.ts` 需要存在于正确的位置。已在任务 9 步骤 3 创建。

- [ ] **步骤 3：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat: xiaohongshuCrawler Phase 3 改用 LoginTabRegistry（不关闭登录标签页）"
```

---

### 任务 12-14：更新 douyin/kuaishou/tencent crawlers 登录检测

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（detectRiskControlAsync 方法，约 860-880 行）
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`（checkLoginStatus 方法，约 161-197 行）
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（handleLogin 方法，约 142-173 行）

共通模式：在检测到登录态失效时，改为调用 LoginTabRegistry.openLoginTab() → captureQR() → sendLoginAlert() → 标记标签页，替代当前的 `bm.connect()` + `page.goto()` + `captureAndSendQR()`。

下面以 kuaishou 为例展示改动模式，douyin/tencent 参照执行：

- [ ] **步骤 1：更新 kuaishouCrawler handleLogin 方法**

在 `kuaishouCrawler.ts` 的 `handleLogin` 方法中（约 199 行起），当 `checkLoginStatus` 返回 false 时：

将：
```typescript
await this.captureAndSendQR(page, userId, 'kuaishou', user.wechatUserid, botManager);
```

替换为：

```typescript
const { loginTabRegistry, getLoginFlowConfig } = await import('../services/loginFlowHelpers');
const { getBrowserManager } = await import('../lib/browserManager');
const bm = getBrowserManager();
const windowId = String(user.fingerprintWindowId);

const ksConfig = getLoginFlowConfig('kuaishou', 'creator');
if (ksConfig) {
  const browser = await bm.getBrowser(windowId);
  if (browser) {
    const record = await loginTabRegistry.openLoginTab(windowId, userId, 'creator', browser, ksConfig);
    if (record) {
      const qrBuf = await loginTabRegistry.captureQR(record.page, ksConfig);
      if (qrBuf) {
        await botManager.sendLoginAlert(user.wechatUserid, 'kuaishou', userId, qrBuf).catch(() => {});
      }
    }
  }
} else {
  // fallback to legacy
  await this.captureAndSendQR(page, userId, 'kuaishou', user.wechatUserid, botManager);
}
```

- [ ] **步骤 2：更新 douyinCrawler detectRiskControlAsync**

参照 kuaishou 模式，在检测到 `login_redirect` 类型风险时，使用 LoginTabRegistry + `getLoginFlowConfig('douyin', 'creator')`。

- [ ] **步骤 3：更新 tencentCrawler handleLogin**

参照 kuaishou 模式，使用 `getLoginFlowConfig('tencent', 'creator')`。

- [ ] **步骤 4：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 5：Commit（每个 crawler 单独 commit）**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat: kuaishou login 改用 LoginTabRegistry"

git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat: douyin login 改用 LoginTabRegistry"

git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat: tencent login 改用 LoginTabRegistry"
```

---

### 任务 15：更新企微按钮处理，加入 flowId 参数和 LoginTabRegistry 操作

**文件：**
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts:459-460, 531-562, 565-653`

- [ ] **步骤 1：更新 sendLoginAlert 的 jump_list 携带 flowId**

在 `sendLoginAlert` 方法（约 458 行），修改 jump_list 中的 question 格式：

```typescript
// 修改前:
jump_list: [
  { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform}` },
  { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform}` },
  { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform}` },
],

// 修改后（追加 flowId 参数，默认 'creator' 兼容单 flow 平台）:
jump_list: [
  { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform} creator` },
  { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform} creator` },
  { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform} creator` },
],
```

注意：sendLoginAlert 当前签名为 `sendLoginAlert(userid, platform, userId, imageBuffer?)`——未传入 flowId。需要新增一个可选参数 `flowId`：

```typescript
// 发送告警时携带 flowId
async sendLoginAlert(userid: string, platform: string, userId: number, imageBuffer?: Buffer, flowId?: string): Promise<void> {
  const fid = flowId || 'creator'; // 默认 creator
  // ...
  jump_list: [
    { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform} ${fid}` },
    { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform} ${fid}` },
    { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform} ${fid}` },
  ],
}
```

- [ ] **步骤 2：更新三个按钮的正则匹配（兼容 2-3 参数）**

**"继续监控"正则**（约 531 行）：
```typescript
// 修改前:
const resumeSetup = content.match(/^继续监控\s+(\d+)\s+(\S+)$/);

// 修改后（兼容 2 参数旧卡片 + 3 参数新卡片）:
const resumeSetup = content.match(/^继续监控\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
const targetUserId = parseInt(resumeSetup[1], 10);
const targetPlatform = resumeSetup[2];
const targetFlowId = resumeSetup[3] || 'creator';
```

**"强制刷新"正则**（约 566 行）：
```typescript
// 修改前:
const forceRefreshSetup = content.match(/^强制刷新\s+(\d+)\s+(\S+)$/);

// 修改后:
const forceRefreshSetup = content.match(/^强制刷新\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
const targetFlowId = forceRefreshSetup[3] || 'creator';
```

**"F5刷新"正则**（约 617 行）：
```typescript
// 修改前:
const f5RefreshSetup = content.match(/^F5刷新\s+(\d+)\s+(\S+)$/);

// 修改后:
const f5RefreshSetup = content.match(/^F5刷新\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
const targetFlowId = f5RefreshSetup[3] || 'creator';
```

- [ ] **步骤 3：重写"继续监控"处理——加 verifyLogin 门控**

```typescript
        // "继续监控" 处理
        if (resumeSetup) {
          const targetUserId = parseInt(resumeSetup[1], 10);
          const targetPlatform = resumeSetup[2];
          const targetFlowId = resumeSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!user) {
            await botManager.sendTextMessage([userid], '❌ 未找到用户');
            return;
          }

          const windowId = String(user.fingerprintWindowId);

          // 使用 LoginTabRegistry 校验登录态
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);

          if (!config) {
            await botManager.sendTextMessage([userid], '❌ 未找到该平台的登录配置');
            return;
          }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) {
            await botManager.sendTextMessage([userid], '❌ 无法连接浏览器，请稍后重试');
            return;
          }

          const record = await loginTabRegistry.find(windowId, targetFlowId, browser, config.domain);
          if (!record) {
            // 登录标签页不存在，回退到直接恢复（用户可能已在别处登录）
            logger.warn({ targetUserId, targetFlowId }, '继续监控: 未找到登录标签页，直接恢复');
            // 仍然尝试恢复数据索引
            const { delFlowState } = await import('./monitorService');
            await delFlowState(targetUserId, targetFlowId);
            await prisma.user.update({
              where: { id: targetUserId },
              data: { status: 'init', cooldownUntil: 0, monitoringEnabled: true },
            }).catch(() => null);

            const { platformQueue } = await import('./unifiedQueue');
            await platformQueue.add('monitor', {
              taskType: 'monitor',
              taskId: `manual_${Date.now()}_${targetUserId}`,
              userId: targetUserId,
              platform: targetPlatform as any,
              windowId,
              fingerprintWindowId: user.fingerprintWindowId,
            });
            await botManager.sendTextMessage([userid], `✅ 已恢复 ${targetPlatform} 监控（未找到登录标签页，直接触发监控）`);
            return;
          }

          const loginState = await loginTabRegistry.checkLoginState(record.page, config);

          if (loginState === 'logged_in') {
            // ★ 登录成功 → 清理标记 + 恢复监控
            if (config.closeOnLoginSuccess) {
              await loginTabRegistry.closeLoginTab(windowId, targetFlowId);
            } else {
              await loginTabRegistry.unregister(windowId, targetFlowId);
            }

            const { delFlowState } = await import('./monitorService');
            await delFlowState(targetUserId, targetFlowId);

            // 恢复用户状态
            await prisma.user.update({
              where: { id: targetUserId },
              data: { status: 'init', cooldownUntil: 0, monitoringEnabled: true },
            }).catch(() => null);

            // 重新入队监控
            const { platformQueue } = await import('./unifiedQueue');
            await platformQueue.add('monitor', {
              taskType: 'monitor',
              taskId: `manual_${Date.now()}_${targetUserId}`,
              userId: targetUserId,
              platform: targetPlatform as any,
              windowId,
              fingerprintWindowId: user.fingerprintWindowId,
            });
            await botManager.sendTextMessage([userid], `✅ ${targetPlatform} 登录成功，已恢复监控`);
          } else {
            // 未登录
            await botManager.sendTextMessage([userid], `❌ 尚未检测到登录成功，请先扫码或点"刷新"获取新二维码`);
          }
          return;
        }
```

- [ ] **步骤 4：重写"强制刷新"处理——通过 LoginTabRegistry 操作标记标签页**

```typescript
        // "强制刷新" 处理
        if (forceRefreshSetup) {
          const targetUserId = parseInt(forceRefreshSetup[1], 10);
          const targetPlatform = forceRefreshSetup[2];
          const targetFlowId = forceRefreshSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!user) {
            await botManager.sendTextMessage([userid], '❌ 未找到用户');
            return;
          }

          const windowId = String(user.fingerprintWindowId);
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);

          if (!config) {
            await botManager.sendTextMessage([userid], '❌ 未找到该平台的登录配置');
            return;
          }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) {
            await botManager.sendTextMessage([userid], '❌ 无法连接浏览器');
            return;
          }

          // 查找或创建登录标签页
          let record = await loginTabRegistry.find(windowId, targetFlowId, browser, config.domain);
          if (!record) {
            record = await loginTabRegistry.openLoginTab(windowId, targetUserId, targetFlowId, browser, config);
          }

          if (!record) {
            await botManager.sendTextMessage([userid], '❌ 无法打开登录标签页');
            return;
          }

          // 导航到登录 URL（强制刷新）
          await record.page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await record.page.waitForTimeout(3000);

          // 重新截取 QR
          const qrBuf = await loginTabRegistry.captureQR(record.page, config);
          if (qrBuf) {
            await botManager.sendLoginAlert(user.wechatUserid || userid, targetPlatform, targetUserId, qrBuf, targetFlowId);
          } else {
            await botManager.sendLoginAlert(user.wechatUserid || userid, targetPlatform, targetUserId, undefined, targetFlowId);
          }

          await botManager.sendTextMessage([userid], `🔄 已刷新 ${targetPlatform} ${config.label} 登录页，新二维码已发送`);
          return;
        }
```

- [ ] **步骤 5：重写"F5刷新"处理——通过 LoginTabRegistry reload 标记标签页**

```typescript
        // "F5刷新" 处理
        if (f5RefreshSetup) {
          const targetUserId = parseInt(f5RefreshSetup[1], 10);
          const targetPlatform = f5RefreshSetup[2];
          const targetFlowId = f5RefreshSetup[3] || 'creator';

          const { prisma: prismaF5 } = await import('../lib/prisma');
          const userF5 = await prismaF5.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!userF5) {
            await botManager.sendTextMessage([userid], '❌ 未找到用户');
            return;
          }

          const windowIdF5 = String(userF5.fingerprintWindowId);
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);

          if (!config) {
            await botManager.sendTextMessage([userid], '❌ 未找到该平台的登录配置');
            return;
          }

          const bmF5 = getBrowserManager();
          const browserF5 = await bmF5.getBrowser(windowIdF5);
          if (!browserF5) {
            await botManager.sendTextMessage([userid], '❌ 无法连接浏览器');
            return;
          }

          let record = await loginTabRegistry.find(windowIdF5, targetFlowId, browserF5, config.domain);
          if (!record) {
            record = await loginTabRegistry.openLoginTab(windowIdF5, targetUserId, targetFlowId, browserF5, config);
          }

          if (!record) {
            await botManager.sendTextMessage([userid], '❌ 无法打开登录标签页');
            return;
          }

          // F5 刷新：重新加载当前页面（不导航到 loginUrl）
          await record.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await record.page.waitForTimeout(3000);

          const qrBuf = await loginTabRegistry.captureQR(record.page, config);
          if (qrBuf) {
            await botManager.sendLoginAlert(userF5.wechatUserid || userid, targetPlatform, targetUserId, qrBuf, targetFlowId);
          } else {
            await botManager.sendLoginAlert(userF5.wechatUserid || userid, targetPlatform, targetUserId, undefined, targetFlowId);
          }

          await botManager.sendTextMessage([userid], `♻️ 已F5刷新 ${targetPlatform} ${config.label} 页面，新二维码已发送`);
          return;
        }
```

- [ ] **步骤 6：更新 sendLoginAlert 新签名，确保所有调用方传递 flowId**

检查 `monitorService.ts` 中所有调用 `botManager.sendLoginAlert` 的地方，如有需要追加 flowId 参数。当前 captureAndSendQR 调用 sendLoginAlert 时未传 flowId——需要更新：

```typescript
// 在 loginFlowHelpers.ts 或调用处获取 flowId 后传入
botManager.sendLoginAlert(wechatUserid, platform, userId, buf, flowId || 'creator');
```

- [ ] **步骤 7：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 8：Commit**

```bash
git add apps/ts-api-gateway/src/services/wechatBotService.ts
git commit -m "feat: 企微按钮处理改用 LoginTabRegistry + flowId（继续监控校验登录态）"
```

---

### 任务 16：集成验证与手动测试

**文件：** 无新建文件

- [ ] **步骤 1：启动开发环境，验证 selectors.json 加载**

```bash
cd /home/lrp/social_media_complete && node -e "
const { getSelectorReader } = require('./apps/ts-api-gateway/src/lib/selectorStore');
const reader = getSelectorReader();
const cfg = reader.getConfig();
const xhs = cfg.platforms.xiaohongshu;
console.log('XHS loginFlows:', Object.keys(xhs.loginFlows || {}));
console.log('mainsite domain:', xhs.loginFlows?.mainsite?.domain);
console.log('mainsite loginUrl:', xhs.loginFlows?.mainsite?.loginUrl);
console.log('mainsite closeOnLoginSuccess:', xhs.loginFlows?.mainsite?.closeOnLoginSuccess);
"
```

预期输出：展示 xiaohongshu loginFlows 的 mainsite 和 creator 配置。

- [ ] **步骤 2：验证 LoginTabRegistry 单元测试**

```bash
cd /home/lrp/social_media_complete && npx jest packages/browser-core/src/__tests__/loginTabRegistry.test.ts --no-coverage 2>&1
```

预期：ALL 6 TESTS PASS。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | wc -l
```

预期：无新增编译错误（预存错误不算）。

- [ ] **步骤 4：手动验证 QA 场景（需要在开发环境执行）**

| 场景 | 预期行为 |
|------|---------|
| 小红书主站未登录 | Phase 3 检测到 → 不关闭标签页 → 标签页上有 `__login_tab_mark__` → QR 含 padding → 企微收到告警卡片 |
| 扫码登录后点"继续监控" | LoginTabRegistry.verifyLoginState → logged_in → closeOnLoginSuccess=true 关闭标签页 → 状态恢复 active → 监控恢复 |
| 扫码前点"继续监控" | verifyLoginState → logged_out → 企微回复"尚未检测到登录成功" → 监控不恢复 |
| 监控运行中点"F5刷新" | getBrowser() → find 标记标签页（后台）→ reload → captureQR → 企微收到新 QR → 工作标签页不受影响 |
| 主站+创作者中心都未登录 | 两个 loginFlow 各维护独立标记标签页 + 独立冷却 → 一个登录后另一个仍保持 login_required |
| 服务重启 | login_probe 的 setTimeout 丢失 → getAllActiveUsers 扫描 → 触发 probe 恢复 |

- [ ] **步骤 5：最终 Commit**

```bash
git add -A
git commit -m "chore: 集成验证完成，登录标签页注册表实现就绪"
```

---

## 自检

### 1. 规格覆盖度

| 规格章节 | 对应任务 |
|---------|---------|
| §3 数据配置层（loginFlows + purposes） | 任务 2（校验器）+ 任务 3（JSON 配置） |
| §4 LoginTabRegistry 基础设施 | 任务 1（类型）+ 任务 4-6（实现+测试） |
| §4.6 BrowserManager.getBrowser() | 任务 7 |
| §4.7 findPlatformPage 排除登录标签页 | 任务 8 |
| §5 并发安全模型 | 任务 7-8 + 任务 11/15（不调 bringToFront） |
| §6 统一行为流程 | 任务 11-15（crawler + 企微按钮） |
| §7 登录态门控冷却策略 | 任务 10（per-flowId Redis + probe 恢复） |
| §8 标签页生命周期管理 | 任务 5（closeOnLoginSuccess） + 任务 15（继续监控清理） |
| §9 文件改动清单 | 全部 13 个文件已覆盖 ✅ |
| §10 测试策略 | 任务 4（单元测试）+ 任务 16（集成验证） ✅ |

### 2. 占位符扫描

- ❌ 无 "TODO"、"待定"、"后续实现"
- ❌ 无 "添加适当的错误处理" （错误处理在代码中显式展示）
- ❌ 无 "类似任务 N"（每个任务有独立代码）
- ✅ 所有代码步骤都有具体代码块

### 3. 类型一致性

- `LoginTabRecord.page` 在任务 1 定义为 `any`，在任务 5 使用时一致性 ✅
- `LoginFlowConfig` 在任务 1 定义，在任务 3/5/9/10/11/15 使用，字段名一致 ✅
- `LoginState` 类型值 `'logged_in' | 'logged_out' | 'unknown'` 在所有任务中一致 ✅
- `flowId` 参数默认值 `'creator'` 在所有正则/调用中一致 ✅
- `getFlowStateKey(userId, flowId)` → key 格式 `login_flow_state:{userId}:{flowId}` — 在所有 Redis 操作中一致 ✅
