# 反检测架构收口重构 — 抖音端到端试点设计规格

**日期**: 2026-06-25
**状态**: 已确认
**范围**: 抖音平台端到端收口试点——将抖音业务代码中所有浏览器交互 100% 经 `HumanActions`，所有网络监听 100% 经 `RequestInterceptor`，并在此过程中锁定两个核心类的终态 API 契约，作为其余 4 平台 rollout 的基础。同时确立 5 条反检测架构铁律与后续平台 rollout 路线图。

---

## 1. 背景

系统是多平台自动化爬虫与发布系统，技术栈为 `Patchright`（连接 BitBrowser/RoxyBrowser 指纹浏览器）+ `TypeScript`。业务代码中散落大量直接调用 Playwright 原生 API 和裸 CDP 指令的"盲区"，面对顶级风控（抖音 webmssdk、小红书 x-s、腾讯 TGuard）时易触发环境侧信道检测和非人类物理行为风控。

**实测盲区计数（业务代码，排除测试）：**

| 盲区类型 | 实测 | 重灾区 |
|---|---|---|
| `page.evaluate(` | 96 | douyinCrawler 43、tencentCrawler 34 |
| `frame.evaluate(` | 10 | tencent wujie |
| `page.locator(` | 27 | 各 crawler |
| `.fill(` | 6 | — |
| `page.keyboard.` | 6 | — |

**两个核心类已存在（收口重构而非新建）：**
- `packages/browser-core/src/humanActions.ts`（1715 行）：已大量使用 CDP（`ctx.cdp.querySelector / dispatchKeyEvent / Runtime.evaluate`），配 `cdpClient.ts`、`cdpMouse.ts`，本身偏 CDP 中心，与铁律 1"原生为主做减法"存在张力。CDP session 已按 page 缓存在 `WeakMap`（`cdpContexts`，含健康检查+重建），铁律 4 在此层基本已满足。
- `packages/browser-core/src/interceptor.ts`（647 行）：已有 `register/unregister/setValidationConfig` 网络捕获基础，按 urlPatterns 白名单注册。

**既有埋点基础设施（关键）：**
- `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`：写 `TaskExecutionStep`（含 `selectors / mouseAction / extra`），三大 crawler 已调用并传 `mouseAction`/`extra.context`。
- `HumanActions.traceCollector`（`humanActions.ts:64`）：静态机制，记录 mouse trace。
- 监控维护系统主线（`session-ses_1024.md`）：基于 `TaskExecutionStep` + `FlowGraphView` 智能分层的"流程节点监控维护系统"，已做完整盲区审计（Layer A ~233 处、Layer B ~106 处），但尚未产出独立 spec。

---

## 2. 架构铁律（5 条）

| 铁律 | 内容 |
|---|---|
| 1 原生为主（做减法） | 纯 DOM 读用原生 Locator 或 DOM 域，点击/输入用原生 + 拟人化前置（hover/延迟） |
| 2 CDP 为辅（做加法） | 仅物理滚动惯性、键盘扫描码、ShadowDOM/wujie 穿透走 CDP |
| 3 消除注入污染 | 默认零注入（DOM 域），必需 JS 走 `safeEvaluate` 隔离世界，弃用裸 `page.evaluate` |
| 4 禁频繁 CDP 重建 | 复用 `cdpContexts` WeakMap 长连接，业务代码不得 `newCDPSession` |
| 5 边界唯一性 | HumanActions + RequestInterceptor 是唯一边界，含自定义穿透必须封装进 HumanActions，禁止裸 CDP |

**"收口 vs 接管"的区分（铁律 5 内涵）：**
- **操作收口（HumanActions）——必须 100%**：所有 DOM 交互、物理事件、JS 注入（含自定义穿透逻辑）必须经 HumanActions。自定义 ShadowDOM/wujie 穿透必须封装成 HumanActions 方法（如 `cdpPierceShadow`），禁止业务代码裸调 CDP。
- **网络接管（RequestInterceptor）——可见性而非阻断**："接管所有请求"指观测可见性，不是阻断/改写。全局拦截器只做记录与匹配，业务级"等待某响应"由 `waitForResponse` 消费已捕获事件。消费与采集分离。禁止每个请求 attach/detach CDP session（铁律 4）。

---

## 3. 架构总览

**目标**：抖音平台端到端收口试点——抖音业务代码中所有浏览器交互 100% 经 `HumanActions`，所有网络监听 100% 经 `RequestInterceptor`，并锁定两个核心类终态 API 作为其余 4 平台 rollout 契约。

**四层收口架构：**

```
业务层（douyinCrawler.ts / platforms/douyin.ts / loginFlowHelpers.ts 抖音相关）
   │  唯一边界：HumanActions（操作）+ RequestInterceptor（网络）
   │  严禁直接调用 page.* / frame.* / cdp.*（铁律 5）
   ▼
收口层
 ┌─────────────────────────┬──────────────────────────┐
 │ HumanActions            │ RequestInterceptor       │
 │ - 原生 Locator 优先      │ - register/unregister    │
 │ - DOM 域读取（零注入）    │ - waitForResponse        │
 │ - safeEvaluate（隔离世界）│ - collectResponses        │
 │ - CDP 物理（scroll/kbd） │ - pollStatus             │
 └─────────────────────────┴──────────────────────────┘
   │                         │
   ▼                         ▼
Patchright Page            CDP Session（WeakMap 长连接，铁律 4）
```

**铁律落地映射：**

| 铁律 | 落地点 |
|---|---|
| 1 原生为主 | 纯 DOM 读 → 原生 Locator 或 DOM 域；点击/输入 → 原生 Locator + 拟人化前置 |
| 2 CDP 为辅 | 仅物理滚动惯性、键盘扫描码走 CDP（抖音不涉及 ShadowDOM） |
| 3 消除注入污染 | 默认零注入（DOM 域）；必需 JS → `safeEvaluate` 隔离世界；弃用裸 `page.evaluate` |
| 4 禁频繁 CDP 重建 | 复用现有 `cdpContexts` WeakMap 长连接，业务代码不得 `newCDPSession` |
| 5 边界唯一性 | 抖音所有操作经 HumanActions（含任何穿透逻辑），所有请求可被 Interceptor 观测 |

**范围边界（抖音试点）：**
- **改**：`douyinCrawler.ts`（43 evaluate + locator/click/fill/keyboard）、`platforms/douyin.ts`（发布 DOM 轮询→拦截器）、`loginFlowHelpers.ts` 抖音登录流程、`LoginTabRegistry` 中抖音相关的直接 page 操作（需审计收口）。
- **锁定契约**：`HumanActions` 终态公开 API、`safeEvaluate` 签名、`RequestInterceptor` 抖音用方法（`waitForResponse`/`collectResponses`/`pollStatus`）。
- **不改**：其余 4 平台代码、调度/队列逻辑、数据库（纯浏览器层重构）。
- **不在试点**：`browserApiService.ts` 裸 CDP WebSocket 收口、Interceptor 全局注册化——属跨平台基础设施，列入第 5 批 rollout，不塞进单平台试点。

---

## 4. HumanActions 终态 API（抖音试点锁定契约）

原则：**原生 Locator 优先，DOM 域次之，`safeEvaluate` 最后**。

### 4.1 读取类（零注入优先）

| 方法 | 用途 | 实现 | 替代的旧调用 |
|---|---|---|---|
| `readText(page, locator)` | 读元素文本 | 原生 `locator.textContent()` / `innerText()` | `page.evaluate(el => el.innerText)` |
| `readAttribute(page, locator, attr)` | 读属性 | 原生 `locator.getAttribute()` | `page.evaluate(el => el.getAttribute(...))` |
| `readAll(page, selectors, {text,attr})` | 批量读 | DOM 域 `DOM.getOuterHTML` + 解析 | 循环 `evaluate` |
| `exists(page, locator)` | 存在性 | 原生 `locator.count()` + 超时控制 | `page.$()` |

这些方法不向页面注入业务函数——原生 Locator 由 Patchright 内部注入框架代码（已做反检测处理），DOM 域走内核结构化输出。两条风控信号（`error.stack`、`Function.toString`）从根上不存在。

### 4.2 交互类（原生 + 拟人化前置）

| 方法 | 拟人化前置 | 实现 |
|---|---|---|
| `click(page, locator)` | hover → 随机停顿 → 移动 → 点击 | 原生 `locator.click({position, delay})` |
| `fill(page, locator, text)` | 点击聚焦 → 逐字延迟输入 | 原生 `locator.press` 逐键 或 `fill` + 间隔 |
| `press(page, locator, key)` | — | 原生 `locator.press()` |

铁律 1 落地：点击/输入用原生 Locator，利用 Patchright 底层真实硬件事件 + `isTrusted=true`。现有 `cdpSmartScroll`/`cdpFindElement` 等 CDP 中心方法保留但降级为内部，仅物理滚动/键盘扫描码场景用。

### 4.3 `safeEvaluate`（逃生口，方案 C）

```typescript
static async safeEvaluate(
  page: Page,
  fn: string | ((...args: any[]) => unknown),  // 函数或函数字符串
  opts?: {
    world?: 'isolated' | 'main';
    reason: string;                              // reason 强制，便于审计
    args?: any[];                                // 序列化参数，通过 CDP arguments 传入
  }
): Promise<unknown>
```

**实现路径（CDP Runtime.evaluate）**：

Patchright 的 `page.evaluate()` 不支持 `world` 参数。`safeEvaluate` 必须通过 CDP `Runtime.evaluate` 实现：

1. **隔离世界 contextId 预创建**：在 `HumanActions` 初始化时（首次获取 CDP session 后），调用 `Page.createIsolatedWorld()` 创建隔离世界并缓存 `contextId`（WeakMap 按 page 缓存）。后续所有 `safeEvaluate(world:'isolated')` 复用此 contextId，避免每次 CDP 往返（~100-200ms）。
2. **函数序列化**：`fn` 为函数时，`fn.toString()` 序列化为字符串；`fn` 为字符串时直接使用。CDP `Runtime.evaluate({ expression, contextId, returnByValue: true })` 执行。
3. **参数传递**：`opts.args` 通过 CDP `Runtime.evaluate` 的 `arguments` 机制传入（将 args JSON 序列化后拼接到 expression 前缀），**替代"禁止闭包捕获"约束**。

```typescript
// safeEvaluate 内部实现伪代码
static async safeEvaluate(page, fn, opts) {
  const ctx = await this.getCDPContext(page);
  const contextId = await this.getIsolatedWorldId(page, ctx);  // 预创建+缓存
  const fnStr = typeof fn === 'string' ? fn : fn.toString();
  const argsStr = opts.args ? JSON.stringify(opts.args) : '[]';
  const expression = `(function() { return (${fnStr}).apply(null, ${argsStr}); })()`;
  const result = await ctx.cdp.send('Runtime.evaluate', {
    expression,
    contextId: opts.world === 'main' ? undefined : contextId,
    returnByValue: true,
  });
  return result.result.value;
}
```

- **默认 `world: 'isolated'`**：CDP `Runtime.evaluate` 在隔离世界执行，函数源码不进主世界，风控在主世界看不到注入函数源码、抓不到调用栈。
- **`world: 'main'`**：仅当必须访问页面 JS 上下文（如读 `window.xxx`）时，需在调用处注释说明为何无法用 DOM 域替代，且 reason 标记 `main-world-required`。**ESLint 限制**：单文件 `world:'main'` 调用不超过 3 处，超出则 CI 失败。
- **`reason` 强制**：每次调用记录原因，运行时埋点统计 main-world 使用率（写入 `TaskExecutionStep.extra.antiDetection.safeEvaluateReason`）。
- **参数序列化**：`opts.args` 必须是可 JSON 序列化的值（string/number/boolean/object/array），不可传函数或 DOM 引用。TypeScript 类型系统约束参数类型，运行时 `JSON.stringify` 校验。

### 4.4 物理类（CDP，铁律 2）

保留现有：`cdpSmartScroll`（滚轮惯性）、`cdpKeyboard`（扫描码）、`humanMove`（贝塞尔空闲移动）。抖音试点不改这些内部实现，仅确保业务调用经 HumanActions 而非裸 CDP。

### 4.5 不再公开的旧入口（对抖音禁用）

抖音试点期间，`HumanActions` 旧 CDP 中心方法（`cdpFindElement` 等）暂保留供其他平台用，但抖音业务代码**不得直接调用**——抖音一律走 4.1-4.3 的新 API。最终全平台收口后再统一删除旧方法。

### 4.6 HumanActions 迁移路径（过渡方案）

当前 `HumanActions`（1715 行）是深度 CDP 中心的（`cdpClick`/`cdpFindElement`/`cdpIsElementVisible`/`cdpSmartScroll` 等）。从 CDP 中心到原生优先的迁移**不是一步到位**，而是四阶段过渡：

| 阶段 | 动作 | 影响 |
|------|------|------|
| ① 新增原生 API | 添加 `readText`/`readAttribute`/`readAll`/`exists`/`click`/`fill`/`press`/`safeEvaluate` | 纯增量，不破坏现有代码 |
| ② 标记旧方法 `@deprecated` | `cdpClick`/`cdpFindElement`/`cdpIsElementVisible` 等标记废弃 | 编译器警告，不阻断 |
| ③ 抖音试点只用新 API | 抖音范围文件禁止调用旧 CDP 方法（静态守卫） | 其他平台不受影响 |
| ④ 全平台后删除旧方法 | 所有平台迁移完成后，删除 `@deprecated` 方法 | 最终清理 |

**关键约束**：阶段 ①② 可并行开发（新增方法是幂等扩展），阶段 ③ 依赖 ① 完成，阶段 ④ 依赖所有平台完成。

### 4.7 CDP 辅助方法迁移分类

当前抖音业务代码大量使用以下 CDP 辅助方法，需按类别处理：

| 方法 | 类别 | 处理方式 | 替代方案 |
|------|------|----------|----------|
| `cdpClickByText` | 交互 | **提供原生替代** | `click(page, getByText(text))` — 原生 Locator + 拟人化前置 |
| `cdpFindElement` | 查找 | **提供原生替代** | `exists(page, locator)` + 原生 Locator 定位 |
| `cdpIsElementVisible` | 读取 | **提供原生替代** | `exists(page, locator)` + DOM 域 `getBoxModel` |
| `queryElementsWithInfo` | 批量读取 | **提供原生替代** | `readAll(page, selectors, {text,attr})` |
| `cdpSmartScroll` | 物理滚动 | **保留**（铁律 2） | 仅物理惯性场景使用 |
| `cdpKeyboard` | 键盘扫描码 | **保留**（铁律 2） | 仅扫描码场景使用 |
| `humanMove` | 贝塞尔移动 | **保留** | 空闲移动场景使用 |
| `cdpPierceShadow` | 穿透 | **保留+扩展**（腾讯批次） | wujie ShadowDOM 穿透专用 |

**抖音试点规则**：抖音业务代码只用"提供原生替代"列的新 API 和"保留"列的内部方法，不得直接调用"提供原生替代"列的旧 CDP 方法。

### 4.8 HumanActions 新 API 的 fallback 策略

`readText`/`readAttribute`/`exists` 等原生 Locator 方法，当元素不可访问（ShadowDOM 包裹、动态创建、DOM 脏状态）时的处理：

| 场景 | 策略 |
|------|------|
| 元素不存在（`locator.count() === 0`） | 返回 `null`（`readText`/`readAttribute`）或 `false`（`exists`），不抛错 |
| 元素存在但不可交互（被遮挡/动画中） | `click`/`fill` 等待可交互状态（`locator.waitFor({ state: 'visible' })`），超时后抛错 |
| 原生 Locator 完全找不到（ShadowDOM 边界） | **不自动 fallback 到 CDP**——业务层决定是否改用 `safeEvaluate`（需提供 reason）。避免隐式 CDP 降级绕过审计 |

**关键边界**：原生 Locator 失败时不静默降级到 CDP，而是显式上报，由业务层审计决定。

---

## 5. RequestInterceptor 收口

### 5.1 现状盲区

抖音发布/登录/监控评论的 API 响应捕获部分已走 Interceptor，但四个盲区绕过：
1. **发布结果等待**：`platforms/douyin.ts:316` 靠 DOM 文本轮询 `text=发布成功`——脆弱，风控改文案即失效。
2. **登录态校验**：`loginFlowHelpers.ts` 部分靠 DOM 判断登录态。
3. **QR 码状态**：二维码扫码/过期靠 DOM 轮询而非网络层。
4. **监控视频/评论**：评论 API 已走 Interceptor，但视频列表/计数捕获有裸 DOM 读取混入。

### 5.2 Interceptor 新增方法（抖音试点锁定契约）

| 方法 | 用途 | 替代 |
|---|---|---|
| `waitForResponse(page, urlPattern, {timeout, validate})` | 等单个关键响应（发布结果） | DOM 文本轮询 |
| `collectResponses(page, urlPattern, {until, maxItems})` | 持续收集到终止条件（评论分页） | 现有散落捕获逻辑统一 |
| `pollStatus(page, urlPattern, {interval, predicate, timeout})` | 轮询网络状态（登录态/QR 扫码状态） | DOM 状态轮询 |

`waitForResponse` 是发布器收口核心——抖音发布成功后服务端返回特定 API 响应（含 aweme_id/发布状态），直接拦截此响应判定成功，不依赖 toast 文案。

### 5.3 抖音四大盲区收口方案

| 盲区 | 旧方式 | 新方式 |
|---|---|---|
| 发布结果 | DOM 轮询 `text=发布成功` | `waitForResponse` 拦发布 API 响应，DOM toast 仅作兜底二次确认 |
| 登录态校验 | DOM 判断 | `pollStatus` 拦登录态/用户信息 API 响应判定 |
| QR 扫码状态 | DOM 轮询二维码 | `pollStatus` 拦扫码状态 API（扫码成功/过期/取消） |
| 监控视频/评论 | 混用 DOM 读取 | 视频列表/评论计数统一走 `collectResponses`，DOM 仅用于点击翻页交互 |

铁律 4 落地：Interceptor 复用 Patchright `page.route`/`page.on('response')` 长连接监听，不在业务代码重建 CDP session。

### 5.4 兜底策略

- `waitForResponse` 超时未拦截到响应 → 不直接判失败，回退 DOM 兜底判定（保留现有 toast 逻辑为 fallback），记录埋点 `interceptor-fallback-to-dom`。
- 网络监听注册失败 → 降级 DOM 轮询，不阻断流程。
- **拦截器可靠性采样**：每 100 次 `waitForResponse` 调用，强制执行 1 次**无兜底模式**（sampling 1%），专门验证拦截器自身的可靠性。埋点中增加 `interceptorOnlySuccess` 指标。若采样失败率 > 10%，触发告警。

**关键边界**：发布结果判定主用拦截器、DOM 兜底，而非完全弃用 DOM——风控拦截 API 响应时仍有出路，且埋点能暴露"拦截器命中率"。

### 5.5 试点期不全局化

抖音试点 Interceptor 仍按 pattern 用（各 crawler 手动注册），不强制全局化，避免一次性改动太大。Interceptor 全局注册化（在 `BrowserManager.connect` 自动注册，取代各 crawler 手动注册）列入第 5 批 rollout，是监控系统全可见性的硬前提。

---

## 6. 抖音三功能改造映射

### 6.1 监控（`douyinCrawler.ts`，主战场，43 处 evaluate）

| 代码区 | 旧调用 | 新路径 |
|---|---|---|
| Phase1 视频列表解析 | `page.evaluate` 提取视频信息 | `collectResponses` 拦视频列表 API，DOM 仅点击翻页 |
| 评论计数读取 | `page.evaluate(el => el.textContent)` | `readText`（原生 Locator） |
| 元素存在性/可见性 | `page.$()` / `evaluate` 判 offsetHeight | `exists`（原生 count）+ DOM 域 `getBoxModel` |
| 评论树采集 | 散落 `evaluate` 解析 | `collectResponses` 统一捕获，`safeEvaluate` 仅用于少数需访问页面 JS 的解析（reason 审计） |
| 滚动加载更多 | 裸 `page.mouse.wheel` | `cdpSmartScroll`（经 HumanActions） |

### 6.2 发布（`platforms/douyin.ts`，350 行）

| 步骤 | 旧 | 新 |
|---|---|---|
| 进入发布页 | `page.locator` 直接点 | `click`（原生 + 拟人化前置） |
| 填写文案 | `.fill` 瞬时 | `fill`（点击聚焦 + 逐字延迟） |
| 滚动到发布按钮 | 裸滚动 | `cdpSmartScroll` |
| 点发布 | `cdpFindElement` + CDP 点击 | `click`（原生 Locator，`isTrusted=true`） |
| 等发布结果 | DOM 轮询 `text=发布成功` | `waitForResponse` 拦发布 API + DOM 兜底 |
| 失败提示读取 | `evaluate` 读 toast | `readText` |

### 6.3 回复评论（`douyinCrawler.ts` 回复路径 + `loginFlowHelpers.ts`）

| 步骤 | 旧 | 新 |
|---|---|---|
| 定位评论输入框 | `page.$` / `evaluate` | `exists` + `click` |
| 输入回复 | `.fill` | `fill`（逐字延迟） |
| 提交回复 | 裸点击 | `click` + `waitForResponse` 拦回复 API 判成功 |
| 登录态校验 | DOM 判断 | `pollStatus` 拦登录态 API |
| QR 扫码 | DOM 轮询 | `pollStatus` 拦扫码状态 API |

### 6.4 改造原则（适用所有路径）

1. **逐处分类**：每个 `page.evaluate`/`page.locator`/`.fill` 标注归类（读/交互/必须JS/物理），按第 4 节三选一路由。
2. **不可降级审计**：任何走 `safeEvaluate` 或 `world:'main'` 的调用，PR 必须附 reason 说明为何无法用原生/DOM 域替代。
3. **DOM 兜底保留**：发布/回复成功判定主用拦截器，DOM 逻辑不删、降为 fallback。
4. **行为不回归**：改造前后对同一视频/同一发布流程的时序、停顿范围保持一致，避免因"拟人化前置"引入新的行为指纹差异。

---

## 7. 运行时埋点（挂载到 TaskExecutionStep 体系）

### 7.1 核心转变

反检测指标挂载到既有 `TaskExecutionStep.extra`，作为"流程节点监控维护系统"的扩展维度，后端维护时在同一视图看到流程健康度 + 反检测健康度，不另起独立计数器。

### 7.2 指标挂载到 `extra` 字段

每个 `TaskExecutionStep.extra`（Json）新增 `antiDetection` 子对象：

```typescript
extra: {
  context: { /* 既有流程上下文 */ },
  antiDetection: {
    actionPath: 'native-locator' | 'dom-domain' | 'safeEvaluate-isolated' | 'safeEvaluate-main' | 'cdp-physical',
    cdpSessionCreated: false,          // 本 step 是否触发了 CDP 重建（应 false）
    interceptorHit: true | null,       // 本 step 是否由拦截器判定（网络类 step）
    interceptorFallbackToDom: false,    // 是否降级 DOM
    rawPageCallAttempted: false,        // 是否有裸 page.* 调用（应为 false，守卫拦截）
  }
}
```

| 指标 | 采集点 | 挂载方式 | 期望值 |
|---|---|---|---|
| `actionPath` | 每次 HumanActions 调用归类 | 写入当前 step 的 `antiDetection.actionPath` | native/dom 占绝大多数 |
| `cdpSessionCreated` | `getCDPContext` 新建 session | 标记到触发 step | =false（长连接） |
| `interceptorHit` / `fallbackToDom` | Interceptor 判定 | 网络类 step 挂载 | hit 高、fallback 低 |
| `safeEvaluate-main` | `safeEvaluate(world:'main')` | actionPath 标记 + reason 进 extra | 趋近 0 |

### 7.3 扩展既有 `traceCollector` 机制

`HumanActions.traceCollector` 已记录 mouse trace。新增一个对称的 **`stepMetricsCollector`**（同模式，静态 set + WeakMap），HumanActions 内部每次操作把 `actionPath` 等指标推给当前活跃 step 的 collector，由 `taskExecutionRecorder` 在 `recordStep` 时合并进 `extra.antiDetection`。不新建独立计数器。

### 7.4 与监控维护系统的衔接（不在抖音试点实现）

抖音试点只做**数据写入**（`extra.antiDetection`），**不做 FlowGraphView 展示**——那是"流程节点监控维护系统"独立 spec 的职责（`session-ses_1024.md` 尚未产出，属后续规划）。试点验证期通过查询 `TaskExecutionStep` 表统计指标，人工/脚本验证成功判据。两套系统解耦，抖音试点不背 UI 负担。

### 7.5 静态守卫（与运行时埋点互补）

新增 ESLint 自定义规则或 grep 脚本，禁止抖音范围文件出现裸调用：
- **抖音范围文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`、`apps/ts-api-gateway/src/crawlers/douyin*.ts`、`apps/ts-api-gateway/src/platforms/douyin.ts`、`apps/ts-api-gateway/src/services/loginFlowHelpers.ts`（抖音相关部分）。
- **禁用模式**：`page.evaluate(`、`frame.evaluate(`、`page.$eval(`、`page.$$eval(`、`page.evaluateHandle(`、`page.locator(`、`page.$(`、`page.keyboard.`、`createCDPSession`、`page.click`、`.fill(`、`page.mouse`、`page.waitForSelector(`、`page.waitForFunction(`。
- 作为 CI 检查项，保证"静态零直接调用"判据可自动化验证。运行时 `rawPageCallAttempted` 是双保险。

---

## 8. 后续平台 Rollout 计划（路线图骨架）

抖音试点锁定 HumanActions/Interceptor 终态契约后，其余 4 平台分批收口。每平台独立 spec，依赖抖音锁定的契约。

### 8.1 Rollout 顺序与依赖

| 批次 | 平台 | 依赖/特殊性 | 优先级 |
|---|---|---|---|
| 试点（本 spec） | 抖音 | 锁定终态 API 契约 | 进行中 |
| 第 2 批 | 腾讯视频号 | **铁律 2 主战场**——wujie ShadowDOM 穿透必须封装为 HumanActions 方法（`cdpPierceShadow`），34 处 frame.evaluate 是收口难点 | 高（风控 TGuard 最强） |
| 第 3 批 | 快手 | 标准 DOM，14 处 evaluate，风控较轻，可作抖音契约的二次验证 | 中 |
| 第 4 批 | 小红书 | x-s 风控，标准 DOM，18 处 evaluate | 中 |
| 第 5 批（跨平台） | browserApiService 全局化 | 裸 CDP WebSocket 收口 + Interceptor 全局注册化（铁律 5 网络层硬前提） | 高（监控系统前置） |

### 8.2 并行边界

- **设计文档可并行**：腾讯/快手/小红书 spec 可同时写（只读探索，互不干扰）。
- **编码不可并行改核心类**：`humanActions.ts`/`interceptor.ts` 是共享单文件，多平台同时改必冲突。编码顺序严格按 8.1 批次串行，每批完成后核心类契约已稳定，下一批只加平台特有方法。
- **铁律 5 的穿透封装**：腾讯批次的 `cdpPierceShadow` 方法加入 HumanActions 后，快手/小红书若需穿透复用，不得再自造。
- **平台扩展机制**：当多个平台都需要独特的穿透逻辑时，HumanActions 应支持平台扩展模式（如 `HumanActions.registerPlatformPierce(platform, method)` 或插件模式），避免所有穿透硬编码进核心类导致膨胀。抖音试点不实现此机制，但腾讯批次 spec 应包含设计。

### 8.3 与监控系统的衔接

- **监控系统 spec（独立，后续）**：基于 `TaskExecutionStep.extra.antiDetection`（抖音试点已写入）+ Interceptor 全局注册化（第 5 批），实现 FlowGraphView 智能分层展示。其前置依赖是铁律 5 完全落地——所有操作经边界、所有请求可观测。
- **抖音试点不阻塞监控系统**：试点只写数据（`extra.antiDetection`），监控系统读数据。两者解耦，监控系统可在第 5 批全局化后启动。

### 8.4 各平台差异速览

| 平台 | 风控 | DOM 特性 | 收口难点 |
|---|---|---|---|
| 抖音 | webmssdk | 标准 | 43 evaluate 做减法 |
| 腾讯 | TGuard | wujie ShadowDOM | 34 frame.evaluate 穿透封装 |
| 快手 | 中 | 标准 | 14 evaluate，契约二次验证 |
| 小红书 | x-s | 标准 | 18 evaluate |

---

## 9. 错误处理与边界

1. **`safeEvaluate` 隔离世界失败**：CDP `Runtime.evaluate` 异常 → 抛错并记录 `actionPath='safeEvaluate-isolated'` + error，业务层决定是否降级 DOM 域读取。
2. **`waitForResponse` 超时**：不判失败，回退 DOM 兜底（6.4 第 3 条），埋点 `interceptor-fallback-to-dom`。
3. **CDP session 健康检查失败**：`getCDPContext` 现有逻辑删除旧 ctx 重建，标记 `cdpSessionCreated=true` 到当前 step，便于监控发现频繁重建（铁律 4 违规告警）。
4. **静态守卫误报**：若某处确需裸调用（极少数基础设施场景），需在守卫配置中显式白名单 + 注释说明，不得全局关闭。
5. **行为不回归**：拟人化前置的停顿范围必须与改造前一致（6.4 第 4 条），改造前后对同一流程的时序保持一致，避免引入新指纹。
6. **抖音试点不破坏其他平台**：旧 CDP 中心方法（`cdpFindElement` 等）保留供其他平台用，仅对抖音禁用（4.5），不删旧方法。
7. **回滚策略（双路径共存）**：新增环境变量 `ANTI_DETECTION_MODE=legacy|v2`：
   - `legacy`（默认）：抖音业务代码走旧 CDP 路径（现有行为）
   - `v2`：抖音业务代码走新原生 Locator + safeEvaluate 路径
   - 试点期双路径共存至少 2 周，通过运行时埋点对比风控触发率、拦截器命中率
   - 回滚只需将环境变量改回 `legacy`，无需代码回滚
   - 全量切换 `v2` 的判定标准：连续 7 天 `v2` 模式风控触发率不高于 `legacy`

---

## 10. 测试与验证

### 10.0 前置验证（Phase 0，阻塞项）

在开始改造前，必须完成以下前置验证：

**Patchright 原生 Locator 反检测盲测**：

spec 假定"原生 Locator 由 Patchright 内部注入框架代码（已做反检测处理）"——此假设需实际验证。盲测方案：

| 维度 | 方案 |
|------|------|
| 测试对象 | 同一批 10 个抖音视频，各跑 50 次监控采集 |
| A 组（对照） | 旧 CDP 路径（现有 `cdpClick`/`page.evaluate`） |
| B 组（实验） | 新原生 Locator 路径（`locator.click()`/`locator.textContent()`） |
| 对比指标 | `risk_control`/`login_required` 状态出现频率、验证码触发率、采集成功率 |
| 判定标准 | B 组风控触发率不高于 A 组 5% → 通过；超出 → 需评估 Patchright 注入是否被 webmssdk 检测 |

盲测在独立测试环境执行，不改动生产代码。**盲测未通过前不得开始大规模改造**。

**CDP 隔离世界 POC**：

验证 `Page.createIsolatedWorld()` + `Runtime.evaluate({ contextId })` 在 Patchright 中的可行性：
- 隔离世界 contextId 能否正确创建和缓存
- 隔离世界中执行的函数是否在主世界不可见（`window` 对象无污染）
- 性能开销（首次创建 vs 缓存命中）

**静态审计补全**：

扩展盲区计数，覆盖 spec 遗漏的变体：
- `page.evaluateHandle(`、`page.$eval(`、`page.$$eval(`、`frame.$eval(`
- `page.waitForSelector(`、`page.waitForFunction(`
- `HumanActions.cdpClickByText(`、`HumanActions.queryElementsWithInfo(`（CDP 辅助方法）

### 10.1 单元测试

- `HumanActions.readText/readAttribute/exists`：原生 Locator 路径，mock page 验证调用原生 API。
- `HumanActions.safeEvaluate`：隔离世界默认、`world:'main'` 审计、闭包捕获检测。
- `HumanActions.click/fill`：拟人化前置时序（hover→停顿→点击）。
- `RequestInterceptor.waitForResponse`：命中/超时降级/validate 过滤。
- `RequestInterceptor.pollStatus`：predicate 终止/timeout。

### 10.2 静态守卫测试

- 抖音范围文件 grep 扫描脚本：裸调用数 = 0。
- CI 集成检查项。

### 10.3 运行时埋点验证

- 抖音三功能（发布/监控/回复）端到端跑通后，查询 `TaskExecutionStep.extra.antiDetection`：
  - `actionPath` 中 native-locator/dom-domain 占绝大多数。
  - `cdpSessionCreated` 全 false（或仅首次 true）。
  - `interceptorHit` 高、`interceptor-fallback-to-dom` 低。
  - `safeEvaluate-main` 趋近 0。
  - `rawPageCallAttempted` 全 false。

### 10.4 功能不回归

- 现有 `douyinCrawler` 测试 + 新增 safeEvaluate/HumanActions/Interceptor 单测全绿。
- 抖音三功能端到端走通，行为时序与改造前一致。

---

## 11. 成功标准

1. **静态零直接调用**：抖音范围文件 `page.evaluate`/`frame.evaluate`/`page.$eval`/`page.$$eval`/`page.evaluateHandle`/`page.locator`/`page.$`/`page.keyboard`/`createCDPSession`/`page.click`/`.fill`/`page.mouse`/`page.waitForSelector`/`page.waitForFunction` 直接调用数 = 0（grep 可验证，CI 守卫）。
2. **运行时指标埋点**：`TaskExecutionStep.extra.antiDetection` 写入，`actionPath` native/dom 占绝大多数，`cdpSessionCreated`≈1/page，`safeEvaluate-main` 趋近 0，`interceptor-hit` 高。
3. **功能不回归**：抖音三功能（发布/监控/回复）端到端走通，现有 + 新增单测全绿。
4. **契约锁定**：`HumanActions` 终态 API（readText/readAttribute/readAll/exists/click/fill/press/safeEvaluate）、`safeEvaluate` 签名、`RequestInterceptor` 三方法（waitForResponse/collectResponses/pollStatus）定义完成，供后续 4 平台 rollout 复用。
5. **5 条铁律落地**：抖音范围内铁律 1-5 全部可验证满足。
6. **前置盲测通过**：Patchright 原生 Locator 反检测盲测结果——B 组风控触发率不高于 A 组 5%。
7. **双路径共存**：`ANTI_DETECTION_MODE=legacy|v2` 环境变量可切换，回滚无需代码变更。

---

## 12. 不在范围

- 其余 4 平台（腾讯/快手/小红书/Pinterest）收口——各自独立 spec，见第 8 节路线图。
- `browserApiService.ts` 裸 CDP WebSocket 收口——第 5 批 rollout。
- Interceptor 全局注册化——第 5 批 rollout。
- FlowGraphView 反检测维度展示——监控系统独立 spec。
- 调度/队列/数据库逻辑——纯浏览器层重构，不触碰。
- 删除旧 CDP 中心方法（`cdpFindElement` 等）——全平台收口后统一删除。
