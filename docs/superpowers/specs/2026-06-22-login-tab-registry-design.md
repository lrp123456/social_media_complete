# 登录标签页注册表设计规格

> **日期**: 2026-06-22
> **状态**: 待审查
> **关联文件**: `xiaohongshuCrawler.ts`, `wechatBotService.ts`, `monitorService.ts`, `browserManager.ts`, `selectorStore.ts`, `data/selectors.json`

## 1. 背景与问题

### 1.1 当前缺陷

小红书 Phase 3 评论采集中，点击缩略图跳转主站后检测到未登录时的处理流程存在三个严重问题：

1. **QR 码截取不全** (`xiaohongshuCrawler.ts:1010-1011`)：`qrEl.screenshot()` 只截取元素 bounding box，无 padding。小红书 QR 码外围有装饰边框，截取结果缺少定位标记，导致扫码失败。

2. **关闭标签页导致 QR 失效** (`xiaohongshuCrawler.ts:1022`)：截完 QR 后立即 `newPage.close()`。小红书 QR 登录是长轮询机制——页面持续向服务器轮询扫码状态。关闭标签页 = 杀死轮询 = 二维码作废，即使手机扫码也无法完成登录。

3. **"继续监控"不校验登录态** (`wechatBotService.ts:531-562`)：用户点"已登录，继续监控"后，代码只清数据库冷却状态 + 重新入队监控，不校验是否真的登录成功。用户手快点了按钮但没扫码 → 下一轮监控又检测到未登录 → 无限循环。

4. **"强制刷新"导航到错误 URL** (`wechatBotService.ts:585`)：Phase 3 检测到未登录是在主站 `www.xiaohongshu.com/explore/{noteId}`，但"强制刷新"导航到创作者中心 `creator.xiaohongshu.com/creator/home`，两个域名登录态完全独立。

5. **企微登录操作破坏正在运行的监控** (`wechatBotService.ts:599`)：企微"强制刷新"/"F5刷新"调用 `bm.connect()` → 内部 `findPlatformPage()` 返回的是**工作标签页**（不是登录标签页）→ `page.goto(loginUrl)` 把工作标签页导航走 → 破坏正在运行的监控流程。

6. **冷却到期自动恢复导致无效循环** (`monitorDatabaseService.ts:396-412`)：`login_required` 状态 30 分钟后自动恢复为 `init` → 跑完整监控 → 又检测到未登录 → 又 30 分钟冷却 → 无限循环，且重复发送 QR 骚扰用户。

### 1.2 设计目标

- 将 `'login'` 提升为与 `'monitor'`/`'publish'` 平级的一等公民 purpose
- 通用化覆盖所有平台（抖音/快手/小红书/视频号），通过 JSON 配置驱动
- 修复 QR 码截取不全、标签页关闭导致 QR 失效、冷却循环等问题
- 确保登录操作不破坏正在运行的监控/发布流程

## 2. 整体架构

三层结构，关注点分离：

```
┌─────────────────────────────────────────────────┐
│  selectors.json (数据驱动配置层)                  │
│  ├── loginFlows 类别: 域名/登录URL/检测脚本       │
│  └── regions/buttons + purposes: ['login']      │
│      (QR选择器/登录模态框/头像等元素)              │
├─────────────────────────────────────────────────┤
│  browser-core/LoginTabRegistry (基础设施层)       │
│  ├── register/find/unregister (标签页注册表)      │
│  ├── verifyLogin (调用配置中的检测脚本)            │
│  └── captureQR (配置选择器+padding截图)           │
├─────────────────────────────────────────────────┤
│  wechatBotService + monitorService (编排层)       │
│  ├── 企微按钮处理 (继续监控/强制刷新/F5刷新)       │
│  ├── login_probe 轻量检测任务                     │
│  └── 冷却递增 + 登录态门控恢复                     │
└─────────────────────────────────────────────────┘
```

## 3. 数据配置层

### 3.1 loginFlows 类别

每个平台新增 `loginFlows` 类别，按域名组织。小红书有两个独立登录态（主站 + 创作者中心），其他平台通常只有一个：

```jsonc
// data/selectors.json — xiaohongshu 示例
{
  "platforms": {
    "xiaohongshu": {
      "loginFlows": {
        "mainsite": {
          "domain": "www.xiaohongshu.com",
          "label": "主站",
          "loginUrl": "https://www.xiaohongshu.com/explore",
          "closeOnLoginSuccess": true,
          "loggedOutIndicators": ["#login-btn", ".login-modal"],
          "loggedInIndicators": [".user-avatar", ".sidebar-menu"],
          "qrSelectors": [".login-container .qrcode-img", ".qrcode-img"]
        },
        "creator": {
          "domain": "creator.xiaohongshu.com",
          "label": "创作者中心",
          "loginUrl": "https://creator.xiaohongshu.com/creator/home",
          "closeOnLoginSuccess": false,
          "loggedOutIndicators": [".login-container", ".login-btn-container"],
          "loggedInIndicators": [".creator-container"],
          "qrSelectors": [".qrcode-img", "img[alt*='二维码']"]
        }
      }
    }
  }
}
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 用途 |
|------|------|------|------|
| `domain` | string | ✅ | 标签页匹配键，用于 findPlatformPage 和 LoginTabRegistry 查找 |
| `label` | string | ✅ | 企微告警中显示的中文名 |
| `loginUrl` | string | ✅ | "强制刷新"时导航的目标 URL |
| `closeOnLoginSuccess` | boolean | ❌ | 登录成功后是否关闭标签页，默认 `false` |
| `loggedOutIndicators` | string[] | ✅* | 未登录态 DOM 选择器列表（CSS-only），命中任一则判定未登录 |
| `loggedInIndicators` | string[] | ✅* | 已登录态 DOM 选择器列表（CSS-only），命中任一则判定已登录 |
| `qrSelectors` | string[] | ❌ | QR 码元素选择器列表（CSS-only），按优先级尝试 |

> *`loggedOutIndicators` 和 `loggedInIndicators` 至少有一个非空。
>
> **CSS-only 约束**：`loggedOutIndicators`、`loggedInIndicators`、`qrSelectors` 只支持 CSS 选择器（class/id/attribute），因为 `checkLoginState` 使用 `page.$()` 查询，`captureQR` 使用 `boundingBox()` 定位。不支持 Playwright 特有的 `getByText`/`getByRole` 语法。复杂条件检测应由多个选择器条目组合覆盖。

### 3.3 closeOnLoginSuccess 语义

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `true` | 登录成功后：unregister + 清 localStorage 标记 + `page.close()` | 小红书主站（通过点击缩略图进入，不关闭会累积标签页） |
| `false`（默认） | 登录成功后：unregister + 清 localStorage 标记 + 不关闭，标签页交给 BrowserManager 正常复用 | 小红书创作者中心、抖音、快手、视频号（标签页可复用） |

### 3.4 现有 categories 加 purposes: ['login']

QR 选择器等元素同时在 `regions` 类别中注册，标记 `purposes: ['login']`：

```jsonc
"regions": {
  "region_mainsite_qr_code": {
    "purposes": ["login"],
    "primary": ".qrcode-img",
    "fallbacks": ["img[alt*=\"二维码\"]"],
    "selectorType": "css"
  },
  "region_mainsite_login_modal": {
    "purposes": ["login"],
    "primary": "getByText(\"登录\", exact=True)",
    "fallbacks": ["[class*=\"login-modal\"]:visible"],
    "selectorType": "css"
  }
}
```

### 3.5 各平台 loginFlows 迁移

| 平台 | flowId | 来源 |
|------|--------|------|
| xiaohongshu | `mainsite` + `creator` | 从 `xiaohongshuCrawler.ts` 内联逻辑 + `browserApiService.ts:562-576` 脚本迁移 |
| douyin | `creator` | 从 `douyin.ts doLogin()` 迁移 |
| kuaishou | `creator` | 从 `kuaishouCrawler.ts checkLoginStatus()` 迁移 |
| tencent | `creator` | 从 `tencentCrawler.ts handleLogin()` 迁移 |

对于只有一个 loginFlow 的平台，flowId 默认为 `'creator'`。企微按钮 question 格式中的 flowId 参数对于单 flow 平台也必须携带，保持接口一致。

### 3.6 校验器改动

`selectorStore.ts`：
- `VALID_PURPOSES` 从 `['publish', 'monitor']` 扩展为 `['publish', 'monitor', 'login']`
- `VALID_CATEGORIES` 数组追加 `'loginFlows'`
- 新增 `loginFlows` 条目校验：
  - `domain` 必填，非空字符串
  - `loginUrl` 必填，非空字符串
  - `loggedOutIndicators` 和 `loggedInIndicators` 至少有一个非空数组
  - `closeOnLoginSuccess` 可选，必须为 boolean

## 4. LoginTabRegistry 基础设施层

### 4.1 位置与接口

新建 `packages/browser-core/src/loginTabRegistry.ts`。纯基础设施，不依赖任何平台特定逻辑——所有平台差异通过配置驱动。

```typescript
// packages/browser-core/src/loginTabRegistry.ts

export interface LoginTabRecord {
  page: Page;
  targetId: string;          // CDP target ID，用于跨重连识别
  domain: string;             // 'www.xiaohongshu.com' | 'creator.xiaohongshu.com' | ...
  flowId: string;             // 'mainsite' | 'creator' | ...
  openedAt: number;
  userId: number;
}

export interface LoginFlowConfig {
  domain: string;
  label: string;
  loginUrl: string;
  closeOnLoginSuccess: boolean;
  loggedOutIndicators: string[];
  loggedInIndicators: string[];
  qrSelectors: string[];
}

export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

export class LoginTabRegistry {
  // 内存注册表：key = `${windowId}:${flowId}`
  private tabs = new Map<string, LoginTabRecord>();

  // ── 标签页生命周期 ──
  register(windowId: string, flowId: string, record: LoginTabRecord): void
  unregister(windowId: string, flowId: string): void

  // 查找：先查内存，miss 则枚举所有标签页扫描 localStorage 标记
  async find(windowId: string, flowId: string, browser: Browser): Promise<LoginTabRecord | null>

  // ── 登录检测 ──
  // 在指定标签页上执行配置中的 loggedOutIndicators + loggedInIndicators + loginCheckScript
  async checkLoginState(page: Page, config: LoginFlowConfig): Promise<LoginState>

  // ── QR 截取 ──
  // 用配置中的 qrSelectors 查找元素 → boundingBox + padding 正方形裁剪 → 全页兜底
  async captureQR(page: Page, config: LoginFlowConfig): Promise<Buffer>

  // ── 组合操作 ──
  // 打开登录标签页：导航到 loginUrl → 设 localStorage 标记 → register → 返回 record
  async openLoginTab(windowId: string, userId: number, flowId: string, browser: Browser, config: LoginFlowConfig): Promise<LoginTabRecord>

  // 关闭登录标签页：unregister + page.close()
  async closeLoginTab(windowId: string, flowId: string): Promise<void>
}
```

### 4.2 标记机制（双层）

**内存层**——快速查找，Page 引用直接可用：

```
Map<`${windowId}:${flowId}`, LoginTabRecord>
  例: "window123:mainsite" → { page, targetId, domain, ... }
  例: "window123:creator"  → { page, targetId, domain, ... }
```

一个窗口可以同时注册多个域名的登录标签页（主站 + 创作者中心各一个），互不干扰。

**localStorage 层**——跨 CDP 重连/服务重启恢复：

```javascript
// 注入到标签页的 localStorage
localStorage.setItem('__login_tab_mark__', JSON.stringify({
  flowId: 'mainsite',
  userId: 42,
  openedAt: 1719052800000
}))
```

`find()` 的恢复流程：
1. 查内存 Map → hit 则返回
2. miss → 枚举 `browser.contexts()[0].pages()`
3. 对每个页面检查 URL 是否匹配 `config.domain`
4. 匹配则读取 `localStorage.__login_tab_mark__`，校验 `flowId` 一致
5. 找到则重建内存记录并返回；否则返回 null

### 4.3 QR 截取逻辑（修复截取不全）

复用 `monitorService.ts:562-590` 已验证的 padding 逻辑，但从配置驱动选择器：

```
captureQR(page, config):
  1. 遍历 config.qrSelectors，逐个尝试
  2. 找到元素 → waitForElementState('visible', 3s)
  3. boundingBox() → 验证 width/height > 50px
  4. 正方形裁剪：maxDim + PADDING*2 (PADDING=40px，与现有 captureAndSendQR 一致)，以元素中心为圆心
  5. page.screenshot({ clip }) → 返回 Buffer
  6. 全部选择器失败 → page.screenshot() 全页兜底
```

### 4.4 登录检测逻辑

双重检测，短路返回：

```
checkLoginState(page, config):
  1. loggedOutIndicators: 逐个 page.$(selector)
     → 任一命中 → 返回 'logged_out'
  2. loggedInIndicators: 逐个 page.$(selector)
     → 任一命中 → 返回 'logged_in'
  3. 都没命中 → 返回 'unknown'
```

检测优先级：未登录标识优先（避免页面加载中途误判为已登录），其次是已登录标识。如果两种 indicator 都未命中，返回 `unknown`，调用方按未登录处理（保守策略）。

### 4.5 与 BrowserManager 的关系

LoginTabRegistry **不接管** BrowserManager 的标签页创建/复用/轮换逻辑。两者职责分离：

| BrowserManager | LoginTabRegistry |
|----------------|-----------------|
| 管理"工作标签页"（监控/发布用） | 管理"登录标签页"（专门等扫码） |
| `connect()` → 按 URL 复用/创建，调 `bringToFront` | `openLoginTab()` → 导航到 loginUrl + 标记，不调 `bringToFront` |
| `findPlatformPage()` → URL 域名匹配 | `find()` → 内存 + localStorage 标记匹配 |
| 标签页轮换/健康检查 | 标签页保活（不轮换，保持 QR 有效） |

LoginTabRegistry 需要从 BrowserManager 获取 `browser` 实例（用于枚举页面和创建新标签页），通过新增的 `bm.getBrowser()` 方法获取。

### 4.6 BrowserManager 新增 getBrowser() 方法

与 `connect()` 的区别：

| | `connect()` | `getBrowser()` |
|---|------------|----------------|
| 返回值 | `{ browser, page }` | `browser` |
| `findPlatformPage` | ✅ 调用 | ❌ 不调用 |
| `bringToFront` | ✅ 调用 | ❌ 不调用 |
| 健康检查 | ✅ 调用 | ❌ 不调用 |
| 标签页轮换 | ✅ 可能触发 | ❌ 不触发 |
| CDP 连接 | ✅ 建立/复用 | ✅ 建立/复用 |
| session 注册 | ✅ 注册到 userSessions | ✅ 复用或注册轻量 session |

**关键约束**：现有 session key 格式为 `${windowId}_${platform}`（下划线分隔，见 `browserManager.ts:102`）。`getBrowser()` 必须使用相同的 key 格式匹配已有 session，否则会重复创建 CDP 连接导致资源泄漏。

```typescript
// browserManager.ts 新增
async getBrowser(windowId: string, platform?: Platform): Promise<Browser | null> {
  // 1. 先查已有 session（按 platform 精确匹配，或遍历同 windowId 的所有 session）
  const keysToCheck = platform
    ? [`${windowId}_${platform}`]
    : [...this.userSessions.keys()].filter(k => k.startsWith(`${windowId}_`));

  for (const key of keysToCheck) {
    const session = this.userSessions.get(key);
    if (session?.browser?.isConnected()) {
      try {
        await Promise.race([
          session.browser.version(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('browser version timeout')), 5000))
        ]);
        return session.browser;
      } catch {
        this.userSessions.delete(key);
      }
    }
  }

  // 2. 无可用 session → 建立新 CDP 连接
  const wsEndpoint = await this.getOrCreateWsEndpoint(windowId);
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });

  // 3. 注册轻量 session（page 为 null，标记为 login-only）
  //    确保 disconnectAll() / disconnectSession() 可以清理此连接
  //    避免多次调用 getBrowser() 创建重复 CDP 连接
  const loginSessionKey = `${windowId}_login`;
  this.userSessions.set(loginSessionKey, {
    browser,
    page: null as any,
    windowId,
    platform: 'login' as any,
    connectedAt: Date.now(),
    lastActiveAt: Date.now(),
    reuseCount: 0,
    maxReuse: 999, // login session 不参与轮换
  });

  return browser;
}
```

### 4.7 findPlatformPage 排除登录标签页

防止 BrowserManager 把登录标签页误认为工作标签页。

**注意**：`findPlatformPage` 当前是同步方法（`browserManager.ts:108, 258, 373, 397`），改为 async 后影响 4 处调用：`connect()`、新连接分支、`focusPage()`、`injectIdleBehavior()`。所有调用点都在 async 函数中，添加 `await` 即可，无破坏性。

```typescript
// browserManager.ts findPlatformPage() 改动（同步 → async）
private async findPlatformPage(pages: Page[], platform: Platform): Promise<Page | undefined> {
  const candidates = pages.filter(p => urlMatches(p.url(), platform));
  // 排除登录标签页（有 __login_tab_mark__ 标记的不作为工作标签页）
  for (const p of candidates) {
    const isLoginTab = await p.evaluate(() =>
      !!localStorage.getItem('__login_tab_mark__')
    ).catch(() => false);
    if (!isLoginTab) return p;
  }
  return candidates[0]; // 全是登录标签页则取第一个（极端情况）
}
```

## 5. 并发安全模型

### 5.1 前台/后台操作区分

HumanActions 的鼠标模拟操作（移动、点击、滚轮）通过 CDP `Input.dispatchMouseEvent` 合成事件，需要标签页在前台。但登录标签页的维护操作不涉及鼠标模拟，都是纯 CDP 命令，后台即可执行：

| 操作 | 底层 CDP 命令 | 涉及鼠标 | 需要前台 |
|------|-------------|---------|---------|
| 刷新 QR：`page.reload()` | `Page.reload` | ❌ | ❌ |
| 截取 QR：`page.screenshot()` | `Page.captureScreenshot` | ❌ | ❌ |
| 检测登录态：`page.$()` / `page.evaluate()` | `DOM.querySelector` / `Runtime.evaluate` | ❌ | ❌ |
| 关闭标签页：`page.close()` | `Target.closeTarget` | ❌ | ❌ |
| 监控滚动评论 | `Input.dispatchMouseEvent` type=`mouseWheel` | ✅ | ✅ |
| 监控点击展开 | `Input.dispatchMouseEvent` type=`mousePressed` | ✅ | ✅ |

CDP 中每个标签页是独立 target，有独立 session。对登录标签页执行 CDP 命令不影响工作标签页。CDP 连接本身线程安全，多个并发 CDP 命令会被浏览器进程序列化处理。

### 5.2 任务路由

| 任务类型 | 走 BullMQ？ | 持 WindowMutex？ | 操作的标签页 | 超时 |
|---------|------------|-----------------|------------|------|
| monitor | ✅ | ✅ | 工作标签页（前台，鼠标模拟） | 10min |
| publish | ✅ | ✅ | 工作标签页（前台，鼠标模拟） | 15min |
| reply | ✅ | ✅ | 工作标签页（前台，鼠标模拟） | 5min |
| login_probe | ❌ 异步直执行 | ❌ | 登录标签页（后台，纯 CDP） | 30s |
| 刷新 QR | ❌ 企微回调直执行 | ❌ | 登录标签页（后台，纯 CDP） | 15s |
| 继续监控校验 | ❌ 企微回调直执行 | ❌ | 登录标签页（后台，纯 CDP） | 15s |

**设计依据**：
- 登录操作不走 BullMQ 队列——用户点"刷新 QR"不应等 10 分钟监控跑完
- 登录操作不获取 WindowMutex——只操作登录标签页，不碰工作标签页
- login_probe 也不走队列——操作是纯 CDP evaluate，不涉及鼠标模拟，不影响工作标签页

### 5.3 登录操作数据流

```
用户点"F5刷新"（监控正在跑）
  ├── bm.getBrowser(windowId) → 获取 browser 引用（不调 connect，不碰任何标签页）
  ├── LoginTabRegistry.find(windowId, flowId, browser)
  │     → 枚举 pages → 找到带 __login_tab_mark__ 的登录标签页
  │     → 返回 loginTabPage（后台标签页）
  ├── loginTabPage.reload()       ← CDP Page.reload，后台即可
  ├── captureQR(loginTabPage)     ← CDP Page.captureScreenshot，后台即可
  ├── sendLoginAlert()             ← 发企微
  └── 工作标签页全程在前台，监控的鼠标模拟操作不受任何影响
```

### 5.4 后台标签页节流说明

浏览器对后台标签页有节流策略，但不影响登录标签页维护操作：

| 行为 | 前台 | 后台 | 对登录流程影响 |
|------|------|------|-------------|
| CDP 命令（goto/reload/evaluate/screenshot） | ✅ | ✅ | 无影响 |
| `setTimeout`/`setInterval` 轮询 | 正常 | 节流到 ≥1s | QR 长轮询间隔可能拉长，可接受 |
| `requestAnimationFrame` | ✅ | ❌ 暂停 | QR 登录不依赖 rAF |
| HTTP fetch 轮询（QR 登录轮询） | ✅ | ✅ | 无影响（间隔可能略长） |
| WebSocket | ✅ | ✅ | 无影响 |

小红书 QR 登录是 HTTP 长轮询，后台标签页中仍能工作。用户扫码后服务器侧的登录回调不依赖客户端轮询频率。

## 6. 统一行为流程

所有平台检测到未登录后走同一套流程：

### 6.1 检测到未登录

```
任何平台检测到未登录
  ├── 不关闭标签页（保持 QR 轮询存活）
  ├── LoginTabRegistry.register() — 设 localStorage 标记 + 内存注册
  ├── LoginTabRegistry.captureQR() — padding 正方形截取
  ├── sendLoginAlert() — 发企微卡片（附带 flowId 参数）
  └── 监控进入 login_required 冷却态，队列 break
```

### 6.2 企微按钮处理

企微卡片按钮 question 格式扩展为携带 flowId：

```
继续监控 {userId} {platform} {flowId}     例: "继续监控 42 xiaohongshu mainsite"
强制刷新 {userId} {platform} {flowId}     例: "强制刷新 42 xiaohongshu mainsite"
F5刷新   {userId} {platform} {flowId}     例: "F5刷新 42 xiaohongshu mainsite"
```

`wechatBotService` 的正则匹配更新为**兼容 2-3 参数**格式，确保部署时刻已在途的旧卡片仍可匹配：

```typescript
// 兼容旧格式 "继续监控 42 xiaohongshu" 和新格式 "继续监控 42 xiaohongshu mainsite"
const resumeSetup = content.match(/^继续监控\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
const flowId = resumeSetup[3] || 'creator'; // 单 flow 平台默认 creator
```

三种按钮（继续监控/强制刷新/F5刷新）都需要同样的兼容处理。对于只有一个 loginFlow 的平台（抖音/快手/视频号），flowId 默认为 `'creator'`。

**"继续监控"处理**：

```
用户点"继续监控 <userId> <platform> <flowId>"
  ├── bm.getBrowser(windowId) → 获取 browser
  ├── LoginTabRegistry.find(windowId, flowId, browser) → 找到标记标签页
  ├── LoginTabRegistry.checkLoginState(loginTabPage, config)
  ├── 已登录:
  │     ├── 按配置 closeOnLoginSuccess 决定关闭或保留标签页
  │     ├── unregister + 清 localStorage 标记
  │     ├── status='active' + cooldown=0 + 冷却级别清零
  │     ├── 恢复正常调度
  │     └── 企微回复"✅ 登录成功，已恢复监控"
  └── 未登录:
        └── 企微回复"❌ 尚未检测到登录成功，请先扫码或点刷新"
```

**"强制刷新"处理**：

```
用户点"强制刷新 <userId> <platform> <flowId>"
  ├── bm.getBrowser(windowId) → 获取 browser
  ├── LoginTabRegistry.find(windowId, flowId, browser)
  │     ├── 找到标记标签页 → 直接操作
  │     └── 未找到 → openLoginTab（导航到 config.loginUrl + 标记 + register）
  ├── page.goto(config.loginUrl) → 导航到登录页
  ├── captureQR(page) → 重新截取 QR
  ├── sendLoginAlert() → 重发企微卡片
  └── 不改变冷却状态（仍处于 login_required）
```

**"F5刷新"处理**：

```
用户点"F5刷新 <userId> <platform> <flowId>"
  ├── bm.getBrowser(windowId) → 获取 browser
  ├── LoginTabRegistry.find(windowId, flowId, browser)
  │     ├── 找到标记标签页 → 直接操作
  │     └── 未找到 → openLoginTab + captureQR + sendLoginAlert（同强制刷新回退）
  ├── page.reload() → 刷新当前页
  ├── captureQR(page) → 重新截取 QR
  ├── sendLoginAlert() → 重发企微卡片
  └── 不改变冷却状态（仍处于 login_required）
```

### 6.3 QR 发送时机控制

| 场景 | 发 QR？ | 理由 |
|------|---------|------|
| 首次检测到未登录 | ✅ 发 | 用户需要 QR 扫码 |
| login_probe 检测仍未登录 | ❌ 不发 | 用户已收到过，去点"刷新"即可 |
| 用户点"强制刷新"/"F5刷新" | ✅ 发 | 用户主动请求新 QR |
| 用户点"继续监控"但未登录 | ❌ 不发 | 只回复文本提示 |

## 7. 登录态门控的冷却策略

### 7.1 Per-FlowId 状态跟踪

**关键设计**：小红书有两个独立 loginFlow（主站 + 创作者中心），两者的登录态完全独立。用户可能创作者已登录但主站未登录，或反之。因此冷却级别和 probe 状态必须按 flowId 独立跟踪。

Redis 存储结构：

```
login_flow_state:{userId}:{flowId} → JSON {
  status: 'login_required' | 'login_probe',
  cooldownLevel: 0-4,
  cooldownUntil: <timestamp>,
  lastProbeAt: <timestamp>
}
```

用户整体状态（数据库 `user.status`）的恢复条件：**该用户所有 loginFlow 的状态都已恢复为 active**。具体来说：
- 任何一个 flowId 处于 `login_required`/`login_probe` → `user.status` 保持 `login_required`
- 所有 flowId 都已登录成功 → `user.status` 恢复为 `active`

### 7.2 三层状态机（Per-FlowId）

将 `login_required` 的恢复从"时间到期自动恢复"改为"登录态门控恢复"：

```
正常运行 (active)
  │
  │ 检测到未登录（某个 flowId）
  ▼
login_required:{flowId} (冷却，不发 QR)
  │
  │ 冷却到期
  ▼
login_probe:{flowId} (只做该 flowId 的登录检测)
  │
  ├── checkLoginState() = logged_in
  │     → 清除该 flowId 的 Redis 状态
  │     → unregister + 清 localStorage 标记
  │     → 按 closeOnLoginSuccess 决定关闭或保留标签页
  │     → 检查该用户所有 flowId 是否都已登录
  │     → 全部登录 → user.status='active' + 恢复正常调度
  │     → 仍有未登录 flow → 保持 login_required，等待其他 flow 恢复
  │
  ├── checkLoginState() = logged_out → 回到 login_required:{flowId}
  │     冷却时间递增：30min → 1h → 2h → 4h（上限 4h）
  │     不重发 QR（用户已收到过，去点"刷新"即可）
  │
  └── checkLoginState() = unknown → 回到 login_required:{flowId}，保持当前冷却级别
```

### 7.3 login_probe 状态与调度

新增 `login_probe` 用户状态（数据库 `user.status` 层面），与 `login_required` 的区别：

| 状态 | 调度行为 | 冷却到期后 |
|------|---------|-----------|
| `login_required` | 不调度完整监控 | 转为 `login_probe` |
| `login_probe` | 只调度登录检测任务 | 检测通过→`active`；未通过→回 `login_required`（递增冷却） |

`login_probe` 的检测任务由 `scheduleNext()` 在冷却到期时直接 `setTimeout` 触发（不走 BullMQ，不获取 WindowMutex），只做：
1. `bm.getBrowser()` 获取 browser
2. `LoginTabRegistry.find()` 找标记标签页
3. `LoginTabRegistry.checkLoginState()` 检测
4. 根据结果更新 Redis 中的 per-flowId 状态
5. **logged_in 时**：执行与"继续监控"按钮相同的清理（unregister + 清 localStorage 标记 + 按 closeOnLoginSuccess 关闭/保留）→ 检查所有 flowId → 全部登录则恢复 `user.status='active'` + 恢复调度
6. **logged_out 时**：递增冷却级别 + 重新 setTimeout
7. **unknown 时**：保持冷却级别 + 重新 setTimeout

不跑 Phase 1/3，不打开新标签页，不调用爬虫——开销极低，30 秒超时。

### 7.4 服务重启恢复（数据库驱动）

**关键设计**：`login_probe` 的 `setTimeout` 是内存定时器，服务重启后会丢失。采用数据库驱动的恢复机制，与现有 `getAllActiveUsers()` 的模式一致：

`monitorDatabaseService.ts` 的 `getAllActiveUsers()` 中，保留时间判断逻辑但改为触发 probe 而非直接恢复：

```typescript
// monitorDatabaseService.ts getAllActiveUsers() 改动
// 查询所有 login_required/login_probe 状态且冷却已过期的用户
const staleLoginUsers = await prisma.user.findMany({
  where: {
    status: { in: ['login_required', 'login_probe'] },
    monitoringEnabled: true,
    updatedAt: { lt: staleThreshold }, // 冷却已过期
  },
  select: { id: true, platform: true, fingerprintWindowId: true },
});

// 不直接恢复为 init，而是触发 probe 检测
for (const user of staleLoginUsers) {
  // 从 Redis 读取该用户所有 flowId 的状态
  // 对每个仍处于 login_required 的 flowId 触发 probe
  triggerLoginProbe(user.id, user.platform, user.fingerprintWindowId);
}
```

这样服务重启后下次 `getAllActiveUsers()` 调用时（由监控调度器周期性触发），所有过期的 probe 都会被恢复。

### 7.5 冷却递增策略

防止 `login_required ↔ login_probe` 之间无限快循环（per-flowId）：

```
第 1 次未登录 → 冷却 30min → probe → 未登录 → 冷却 1h
第 2 次 → probe → 未登录 → 冷却 2h
第 3 次 → probe → 未登录 → 冷却 4h
第 4+ 次 → probe → 未登录 → 冷却 4h（上限）
```

冷却级别存储在 Redis（`login_flow_state:{userId}:{flowId}.cooldownLevel`），用户手动点"继续监控"且验证通过时该 flowId 的冷却级别清零。

### 7.6 对现有代码的改动

| 文件 | 改动 |
|------|------|
| `monitorDatabaseService.ts:372-412` | 删除 `login_required` 30min 自动恢复为 `init` 的逻辑，改为触发 `triggerLoginProbe()` |
| `monitorDatabaseService.ts:417` | `notIn: ['blocked', 'login_required', 'risk_control']` → 加入 `'login_probe'` |
| `monitorService.ts scheduleNext()` | 检测到 `login_required`/`login_probe` 状态时，不调度完整监控，改为调度 probe 任务 |
| 新增 `triggerLoginProbe(userId, platform, windowId)` | 从 Redis 读取 per-flowId 状态，对每个 `login_required` 的 flowId 启动 probe 检测 |
| `wechatBotService.ts:531-562` | "继续监控"按钮增加 `verifyLogin` 校验门控 |
| 新增 Redis per-flowId 状态管理 | `login_flow_state:{userId}:{flowId}` 存储状态/冷却级别/到期时间 |

## 8. 标签页生命周期管理

### 8.1 标签页累积防护（V1 简化方案）

V1 不实现自动 GC。当前系统中标签页泄漏不是实际瓶颈——`closeOnLoginSuccess=false` 的平台本来就一个登录页不会累积，`closeOnLoginSuccess=true` 的小红书主站登录成功后会关闭。

V1 采取简化策略：
- `bm.connect()` 时如果同域名标签页 ≥ 5 个，记录 warning 日志提示手动检查
- 依赖 `closeOnLoginSuccess` 配置 + 异常处理（§8.2）防止大多数累积场景

### 8.2 标签页 GC（V2 推迟）

作为 V2 迭代的兜底安全网，BrowserManager 新增 `cleanupExcessTabs` 方法：

```
cleanupExcessTabs(browser, platform):
  1. 枚举 browser.contexts()[0].pages()
  2. 按域名分组
  3. 每个域名保留最多 2 个标签页（1 个工作 + 1 个登录）
  4. 多余的标签页：优先关闭有 __login_tab_mark__ 标记且已登录成功的
  5. 如果还有多余，关闭最早创建的
```

V2 触发时机：独立定时任务（每小时一次），不在 `connect()` 热路径中执行。

### 8.3 登录标签页异常处理

| 场景 | 处理 |
|------|------|
| 登录标签页被用户手动关闭 | `find()` 返回 null → "强制刷新"/"F5刷新"回退到 `openLoginTab` 重新创建 |
| CDP 连接断开 | `getBrowser()` 重新建立连接 → `find()` 通过 localStorage 标记恢复 |
| 服务重启 | 内存注册表丢失 → `find()` 通过 localStorage 标记恢复 |
| localStorage 被清除 | `find()` 返回 null → 回退到 `openLoginTab` |

## 9. 文件改动清单

| 文件 | 角色 | 改动类型 |
|------|------|---------|
| `packages/browser-core/src/loginTabRegistry.ts` | 标签页注册表 + QR 截取 + 登录校验 | **新建** |
| `packages/browser-core/src/types.ts` | 新增 `LoginFlowConfig`、`LoginTabRecord`、`LoginState` 类型 | 修改 |
| `packages/browser-core/src/browserManager.ts` | 新增 `getBrowser()`（含 session 注册）；`findPlatformPage()` 改为 async + 排除登录标签页 | 修改 |
| `apps/ts-api-gateway/src/lib/selectorStore.ts` | `VALID_PURPOSES` 加 `'login'`；`VALID_CATEGORIES` 加 `'loginFlows'`；新增 loginFlows 校验 | 修改 |
| `data/selectors.json` | 各平台新增 `loginFlows` + 登录选择器标记 `purposes: ['login']` | 修改 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | Phase 3 调用 LoginTabRegistry 而非内联逻辑；不关闭登录标签页 | 修改 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 登录检测改用 LoginTabRegistry + 配置 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 登录检测改用 LoginTabRegistry + 配置 | 修改 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 登录检测改用 LoginTabRegistry + 配置 | 修改 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 3 个按钮处理改用 LoginTabRegistry；正则匹配加 flowId 参数 | 修改 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | `captureAndSendQR` 委托给 LoginTabRegistry；冷却逻辑改造 | 修改 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 删除 login_required 自动恢复为 init；改为触发 probe；新增 login_probe 状态；加入 notIn 列表 | 修改 |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | 无需改动（login_probe 不走队列） | 不改 |
| Redis | 新增 per-flowId 状态管理 key：`login_flow_state:{userId}:{flowId}` | 新增 |

## 10. 测试策略

### 10.1 单元测试

- **LoginTabRegistry**：register/unregister/find 的内存层逻辑；localStorage 标记注入和读取；find 的恢复流程（模拟内存 miss → localStorage 恢复）
- **captureQR**：mock page + element，验证 padding 正方形裁剪计算；全页兜底逻辑
- **checkLoginState**：mock page，验证双重检测优先级（loggedOut > loggedIn > unknown）
- **selectorStore 校验器**：loginFlows 条目校验（缺 domain/缺 loginUrl/两个 indicators 都空/非 CSS 选择器）
- **per-flowId 状态管理**：多 flowId 独立跟踪；一个 flowId 登录成功不影响其他 flowId 的冷却

### 10.2 集成测试

- **小红书 Phase 3 未登录场景**：mock browser，验证检测到未登录后标签页不被关闭、localStorage 标记被设置、QR 截图含 padding
- **企微"继续监控"已登录场景**：mock checkLoginState 返回 logged_in，验证 closeOnLoginSuccess=true 时标签页被关闭、per-flowId 状态清除、所有 flowId 都登录时 user.status 恢复为 active
- **企微"继续监控"未登录场景**：mock checkLoginState 返回 logged_out，验证状态不恢复、企微回复提示
- **多 flowId 独立恢复**：小红书 mainsite 已登录但 creator 未登录 → 恢复 mainsite 后 user.status 仍为 login_required，等待 creator 也登录
- **冷却递增**：模拟 login_probe 多次检测未登录，验证冷却时间递增 30min→1h→2h→4h
- **服务重启恢复**：模拟 login_probe 的 setTimeout 丢失，验证 getAllActiveUsers 触发 probe 恢复

### 10.3 手动验证

- 在真实指纹浏览器中触发小红书主站未登录 → 验证 QR 截图完整可扫
- 扫码后点"继续监控" → 验证登录态校验通过、标签页关闭、监控恢复
- 监控运行中点"F5刷新" → 验证工作标签页不受影响、登录标签页 QR 更新
