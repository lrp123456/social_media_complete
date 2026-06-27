# 多平台反检测收口 Rollout 设计规格

**日期**: 2026-06-27
**状态**: 已确认，待审批
**方案**: 方案 A（按路线图批次串行：前置核心类扩展 → 腾讯 → 快手 → 小红书）
**前置**: 抖音试点（`2026-06-25-anti-detection-douyin-pilot-design.md`）已锁定核心契约并完成收口（~99%）

---

## 0. 背景与目标

抖音试点已锁定 `HumanActions` / `RequestInterceptor` 终态 API 契约，并将抖音业务代码 100% 经边界（43 处 `page.evaluate` 归入 `legacy` 分支，v2 走 49 处 `safeEvaluate`，6 处 `enterStep`/`exitStep` 探针织入）。本设计将其余 3 个平台按 spec 第 8 节路线图收口，达到与抖音同等的「样板一致性」：**反检测收口 + 维护探针织入**。

### 0.1 各平台现状（实测，业务代码排除测试）

| 平台 | 裸 `page.evaluate`/`frame.evaluate` | 已用旧 CDP 中心 HumanActions | 已用 safeEvaluate | 探针 enterStep | 风控 | DOM 特性 |
|---|---|---|---|---|---|---|
| 抖音（样板） | 43（已归 legacy） | 203 | 49 | 6 | webmssdk | 标准 |
| 腾讯 | 31 + 3 (wujie frame) | 95 | 0 | 0 | TGuard（最强） | wujie ShadowDOM + iframe 双层穿透 |
| 快手 | 14 | 128 | 0 | 0 | 中 | 标准 DOM |
| 小红书 | 0（但 7 处 `page.locator` + 1 `page.keyboard`） | 63 | 0 | 0 | x-s | 标准 DOM |

三平台均已大量使用旧 CDP 中心 `HumanActions` 方法，但均**未迁移到抖音锁定的新原生/safeEvaluate 契约**，也**未织入维护探针**。

### 0.2 `selectors.json` 现状

四平台配置已全部建好（无需新增结构，仅补充与探针 step key 的关联）：

| 平台 | selector 条目数 |
|---|---|
| 抖音 | 75 |
| 快手 | 65 |
| 小红书 | 38 |
| 腾讯 | 22 |

### 0.3 核心目标

1. 三平台业务代码浏览器交互 100% 经 `HumanActions`，网络监听 100% 经 `RequestInterceptor`（铁律 5）。
2. 三平台织入 `MaintenanceProbe.enterStep`/`exitStep`，与抖音 step key 命名规范统一，产出维护调试系统所需的完整数据。
3. 每平台独立双路径灰度，埋点对比达标后切 v2，回滚无需代码变更。
4. 锁定核心类扩展契约（`cdpPierceShadow` + `registerPlatformPierce`）供穿透场景复用。

---

## 1. 架构复用与总纲

### 1.1 复用样板契约（抖音已锁定，本设计不改）

| 契约 | 落点 | 复用方式 |
|---|---|---|
| `HumanActions` 终态 API | `readText`/`readAttribute`/`exists`/`click`/`fill`/`press`/`safeEvaluate` | 三平台裸 `page.evaluate`/`page.locator`/`.fill` 按读/交互/必须JS 三选一路由到这些方法 |
| `safeEvaluate` 签名 | `(page, fn, {world, reason, args})` | 需访问页面 JS 上下文或解析 API 响应的少数场景，默认 `isolated`，`main` 受 ESLint 配额（≤3/文件） |
| `RequestInterceptor` 三方法 | `waitForResponse`/`collectResponses`/`pollStatus` | 三平台列表分页/发布结果/登录态/QR 状态统一走拦截器，DOM 降为兜底 |
| 5 条铁律 | 原生为主/CDP为辅/消除注入/禁CDP重建/边界唯一 | 三平台盲区收口的归类判据 |
| 双路径共存 | `ANTI_DETECTION_MODE` | 扩展为每平台独立开关（见 1.2） |
| 运行时埋点 | `TaskExecutionStep.extra.antiDetection`（actionPath/cdpSessionCreated/interceptorHit…） | 三平台沿用，不改结构 |

### 1.2 每平台独立双路径开关

抖音单一 `ANTI_DETECTION_MODE` 扩展为每平台独立环境变量：

| 平台 | 环境变量 | 现状 |
|---|---|---|
| 抖音 | `ANTI_DETECTION_MODE`（保留不动） | v2 已~99% |
| 腾讯 | `ANTI_DETECTION_MODE_TENCENT` | 新增，默认 `legacy` |
| 快手 | `ANTI_DETECTION_MODE_KUAISHOU` | 新增，默认 `legacy` |
| 小红书 | `ANTI_DETECTION_MODE_XIAOHONGSHU` | 新增，默认 `legacy` |

- 新增 `antiDetectionMode.ts` 的 helper：`isEnabled(platform)` 读对应变量，`'v2'` 启用新路径，其余 `legacy`。
- 每个爬虫内的盲区点用 `if (isEnabled('<platform>')) { v2 } else { legacy }` 分支包络（对齐抖音 `douyinCrawler` 的 43 处 else 分支结构）。
- 回滚：改回 `legacy`，无需代码回滚。
- 全量切 v2 判据：某平台连续 7 天 v2 风控触发率不劣于 legacy。

**环境变量命名规范**：
1. **统一前缀**：所有反检测相关环境变量使用 `ANTI_DETECTION_` 前缀
2. **平台标识**：平台名称使用大写字母，与现有命名保持一致
3. **命名格式**：`ANTI_DETECTION_<PLATFORM>_<OPTION>`（可选）
4. **示例**：
   - `ANTI_DETECTION_MODE`：抖音平台模式（向后兼容）
   - `ANTI_DETECTION_MODE_TENCENT`：腾讯平台模式
   - `ANTI_DETECTION_MODE_KUAISHOU`：快手平台模式
   - `ANTI_DETECTION_MODE_XIAOHONGSHU`：小红书平台模式
   - `ANTI_DETECTION_LOG_LEVEL`：日志级别（可选扩展）
   - `ANTI_DETECTION_METRICS_ENABLED`：指标开关（可选扩展）
5. **文档要求**：在项目README或环境变量文档中列出所有反检测相关环境变量及其说明

### 1.3 范围边界

- **改**：`tencentCrawler.ts`、`kuaishouCrawler.ts`、`xiaohongshuCrawler.ts`、各自 `platforms/<p>.ts`、`loginFlowHelpers.ts` 相关部分；`humanActions.ts`（新增 `cdpPierceShadow` + `registerPlatformPierce`）、`antiDetectionMode.ts`、静态守卫脚本扩展。
- **不改**：抖音已收口代码、调度/队列/数据库、`selectors.json` 结构（已有四平台配置，仅补充与探针 step key 关联）。
- **不在范围**：第 5 批 `browserApiService` 裸 CDP 收口 + Interceptor 全局注册化（跨平台基础设施，独立排期）；FlowGraphView 反检测维度展示（维护调试系统独立 spec）；删除旧 CDP 中心方法（四平台全 v2 后独立清理任务）。

### 1.4 批次总览

```
前置批次：核心类扩展
  └─ humanActions.cdpPierceShadow + registerPlatformPierce 插件机制
  └─ 静态守卫脚本泛化（支持多平台范围 + 每平台独立白名单）
  └─ antiDetectionMode 每平台独立开关
   │  核心类契约稳定后，业务层批次……
   ▼
第 2 批：腾讯（wujie 穿透，最难，TGuard 风控最强）
   ▼
第 3 批：快手（标准 DOM，14 evaluate，契约二次验证）
   ▼
第 4 批：小红书（标准 DOM，7 locator，x-s 风控，已较干净）
```

业务层批次在核心类稳定后**可 worktree 并行编码**（各改各的 crawler，不碰共享核心类），但**灰度上线/埋点对比仍按批次串行**，避免风控变量混淆。

---

## 2. 核心类前置扩展

这一批在三个业务批次之前完成，稳定共享核心类的契约，避免业务层批次改核心类互相冲突。**本批次不改任何业务 crawler 的运行时行为**——只新增能力 + 守卫，所有平台仍跑 legacy。

### 2.1 `cdpPierceShadow` 穿透方法（铁律 5 落地）

腾讯业务代码当前在 `page.evaluate` 内手写 `wujie-app` → `shadowRoot` → `iframe` → `document` 穿透（如 `tencentCrawler.ts:1422`、`:1586`），裸注入业务函数到主世界，违反铁律 3/5。新增 `HumanActions.cdpPierceShadow` 封装多级穿透。

```typescript
// humanActions.ts 新增
static async cdpPierceShadow(
  page: Page,
  chain: PierceStep[],          // 穿透路径，每个 step 描述一层
  target: { selector: string; read?: 'text' | 'attr' | 'exists' | 'count' | 'outerHTML'; attr?: string },
  opts?: { timeout?: number; reason?: string }
): Promise<unknown | null>
```

**`PierceStep` 类型**（对齐 `selectors.json` 的 `chain` 字段结构）：

```typescript
type PierceStep =
  | { type: 'css'; selector: string }                              // 主文档 CSS 选择器
  | { type: 'shadow'; selector: string }                           // 进入 shadowRoot（wujie-app 等）
  | { type: 'frame'; name?: string; urlIncludes?: string }         // 进入 iframe（wujie 预加载 frame）
```

**实现路径（CDP DOM 域，零注入）**：

1. 沿 `chain` 逐层用 CDP `DOM.querySelector` 定位节点；遇 `shadow` step 用 `DOM.describeNode` 取 `shadowRoots`，进 shadow 树继续 querySelector；遇 `frame` step 用 `Page.getFrameTree` + `contentDocument` 切换 frame context。
2. 最终在末层容器内 `DOM.querySelector(target.selector)`，按 `target.read` 用结构化 CDP 输出读取（`DOM.getOuterHTML`/`DOM.resolveNode`+`Runtime.callFunctionOn`），**不注入业务函数字符串**。
3. 复用现有 `cdpContexts` WeakMap 长连接（铁律 4），不新建 session。

**关键边界**：穿透失败不静默降级，返回 `null` + 记录 `actionPath='cdp-pierce-shadow'`，业务层决定是否改用 `safeEvaluate`（需 reason）。

**穿透失败处理指导**：
1. **默认策略**：业务层应优先尝试 `safeEvaluate` 作为降级方案，但需提供明确的 `reason` 参数说明降级原因
2. **错误分类**：区分穿透失败类型（元素不存在、shadowRoot不可访问、iframe跨域等），记录到埋点数据便于分析
3. **重试机制**：对于临时性失败（如页面未完全加载），建议实现有限次重试（最多3次，间隔500ms）
4. **兜底方案**：若 `safeEvaluate` 也失败，应回退到 legacy 路径并记录 `actionPath='cdp-pierce-shadow-fallback-to-legacy'`
5. **监控告警**：穿透失败率超过5%时触发告警，便于及时发现平台DOM结构变更

### 2.2 `registerPlatformPierce` 插件注册表（spec 8.2 要求）

避免后续平台各自硬编码穿透逻辑进核心类导致膨胀：

```typescript
// humanActions.ts 新增
type PierceHandler = (page: Page, params: any) => Promise<unknown | null>;
private static platformPierceRegistry = new Map<string, Map<string, PierceHandler>>();

static registerPlatformPierce(platform: string, name: string, handler: PierceHandler): void;
static getPlatformPierce(platform: string, name: string): PierceHandler | undefined;
```

- 平台把**独特**的穿透逻辑注册为命名 handler（如 `registerPlatformPierce('tencent', 'wujie-comment-feed', handler)`），业务代码调 `HumanActions.getPlatformPierce('tencent','wujie-comment-feed')(page, params)`，不直接碰 CDP。
- **通用穿透**走 `cdpPierceShadow`（2.1）；**平台特有、无法用 chain 表达**的穿透才注册 handler。腾讯批次首次使用此机制。
- 注册时机：各平台 crawler 模块加载时注册（幂等）。

**穿透机制选择指南**：
1. **优先使用 `cdpPierceShadow`**：适用于标准CSS选择器链、shadowRoot穿透、iframe穿透等可声明式表达的场景
2. **使用 `registerPlatformPierce`**：仅当穿透逻辑涉及复杂条件判断、循环遍历、或平台特有DOM结构无法用chain表达时
3. **决策流程**：
   - 尝试用 `PierceStep[]` 数组描述穿透路径 → 使用 `cdpPierceShadow`
   - 无法用数组表达（如需要遍历多个元素、条件分支等） → 注册为平台特有handler
4. **文档要求**：每个注册的handler必须包含JSDoc注释，说明其用途、适用场景和参数结构
5. **测试覆盖**：平台特有handler需要独立单元测试，验证其在特定DOM结构下的行为

### 2.3 静态守卫脚本泛化

抖音守卫只覆盖抖音范围文件。扩展为多平台配置驱动：

```typescript
// scripts/audit-blindspots.ts（扩展，不改抖音既有行为）
const PLATFORM_SCOPES = {
  douyin:      ['crawlers/douyin*.ts', 'platforms/douyin.ts', /* loginFlowHelpers 抖音部分 */],
  tencent:     ['crawlers/tencent*.ts', 'platforms/tencent.ts', /* ... */],
  kuaishou:    ['crawlers/kuaishou*.ts', 'platforms/kuaishou.ts', /* ... */],
  xiaohongshu: ['crawlers/xiaohongshu*.ts', 'platforms/xiaohongshu*.ts', /* ... */],
};
// 每平台独立禁用模式集 + 白名单（极少数基础设施场景显式放行 + 注释）
```

- 禁用模式沿用抖音清单：`page.evaluate(`/`frame.evaluate(`/`page.$eval`/`page.$$eval`/`page.evaluateHandle`/`page.locator(`/`page.$(`/`page.keyboard.`/`createCDPSession`/`page.click`/`.fill(`/`page.mouse`/`page.waitForSelector(`/`page.waitForFunction(`。
- CI 按平台分别报告裸调用数；某平台批次完成后该平台期望 = 0。
- 现状基线：腾讯 31+3、快手 14、小红书 0 evaluate 但 7 locator——守卫上线后这些即为本批次清零目标。

### 2.4 `antiDetectionMode.ts` 每平台开关

新增 `isEnabled(platform): boolean`，读 `ANTI_DETECTION_MODE_<PLATFORM>`，`'v2'` 为 true。抖音保留原 `ANTI_DETECTION_MODE` 不动（向后兼容）。`getIsolatedWorldId`、`safeEvaluate` 等核心方法本身不依赖此开关——开关仅用于业务层选择 v2/legacy 分支。

### 2.5 前置批次交付物与测试

**测试覆盖率目标**：
- `cdpPierceShadow`：行覆盖率 ≥90%，分支覆盖率 ≥85%
- `registerPlatformPierce`：行覆盖率 ≥95%，分支覆盖率 ≥90%
- `antiDetectionMode.isEnabled`：行覆盖率 100%
- 静态守卫脚本：行覆盖率 ≥80%

**具体测试用例设计**：

**cdpPierceShadow 测试用例**：
1. **css step 测试**：验证标准CSS选择器穿透
2. **shadow step 测试**：验证shadowRoot穿透（需mock shadowRoot结构）
3. **frame step 测试**：验证iframe穿透（需mock frame结构）
4. **混合chain测试**：验证css→shadow→frame多级穿透
5. **失败场景测试**：
   - 元素不存在返回null
   - shadowRoot不可访问返回null
   - iframe跨域返回null
   - 超时返回null
6. **CDP context复用测试**：验证不新建session
7. **性能测试**：验证穿透操作在100ms内完成

**registerPlatformPierce 测试用例**：
1. **注册幂等测试**：重复注册同一handler不报错
2. **平台隔离测试**：同名不同平台handler不互相影响
3. **未注册返回undefined测试**：查询未注册handler返回undefined
4. **handler执行测试**：验证注册的handler能正确执行
5. **参数传递测试**：验证params正确传递给handler

**静态守卫测试用例**：
1. **抖音范围回归测试**：确保不破坏抖音已有的零调用
2. **多平台范围测试**：验证能正确检测各平台裸调用
3. **白名单测试**：验证白名单机制正常工作
4. **CI集成测试**：验证CI守卫能正确报告结果

**antiDetectionMode.isEnabled 测试用例**：
1. **环境变量解析测试**：验证正确读取各平台环境变量
2. **v2启用测试**：验证值为'v2'时返回true
3. **legacy禁用测试**：验证其他值返回false
4. **未设置默认值测试**：验证环境变量未设置时的默认行为

---

## 3. 腾讯批次（wujie ShadowDOM 收口，第 2 批）

腾讯是本设计最难的批次：TGuard 风控最强 + 31 处 `page.evaluate` + 3 处 `frame.evaluate` + wujie 微前端双层穿透（shadowRoot + iframe）。当前虽已用 95 处旧 CDP 中心 `HumanActions` 方法 + 12 处 Interceptor，但未迁移到新契约、未织入探针。

### 3.1 wujie 穿透结构（收口对象）

腾讯视频号助手是 wujie 微前端，主 URL 始终 `/platform`，真实内容在：

```
主文档 → wujie-app (custom element) → shadowRoot → iframe[name="interaction"/...]
                                                          → iframe document → .comment-feed-wrap / .feed-title
```

当前两套裸穿透（需收口）：

| 位置 | 现状（裸注入） | 收口后 |
|---|---|---|
| `tencentCrawler.ts:1422` | `page.evaluate` 内 `querySelectorAll('wujie-app')` → `shadowRoot` → `querySelectorAll('*')` | `cdpPierceShadow(page, [{type:'shadow',selector:'wujie-app'}], target)` |
| `tencentCrawler.ts:1586` | `page.evaluate` 内手写 `wujie-app` → `shadowRoot` 回退查找视频列表 | `cdpPierceShadow(page, [{type:'shadow',selector:'wujie-app'},{type:'frame',name:'interaction'}], {selector:'.feed-title',read:'text'})` |
| `:471`/`:585`/`:618` 等 3 处 `frame.evaluate` | iframe 内 `querySelectorAll` 读 QR/过期/刷新 | `cdpPierceShadow(page, [{type:'frame',name:'interaction'}], {selector, read})` 或 `pollStatus` 拦 QR 状态 API |

### 3.2 31 处 `page.evaluate` 分类路由

按抖音样板三选一路由（每处标注归类 + reason，对齐 spec 6.4）：

| 归类 | 数量（估） | 路由到 | 典型场景 |
|---|---|---|---|
| 纯 DOM 读 | ~22 | `readText`/`readAttribute`/`exists` + `cdpPierceShadow` | 侧边栏菜单解析（`:253`-`:409` 大量 `sidebar.querySelector`）、视频列表文本、元素存在性 |
| 必须访问页面 JS | ~3 | `safeEvaluate(world:'main', reason)` | 读 `window.__INITIAL_STATE__` 等上下文，受 ESLint 配额（≤3/文件） |
| API 响应解析 | ~6 | `collectResponses`/`pollStatus` | QR 扫码状态、登录态、视频/评论列表 API |

**侧边栏菜单解析特例**：`:253`-`:409` 多处 `page.evaluate` 在主文档读 `#side-bar`（非 wujie 内），属标准 DOM 读，统一改 `readAll`（批量读）+ `cdpPierceShadow` 单点穿透——这是腾讯 `page.evaluate` 的最大集中区，一次 `readAll` 替代多次循环 `evaluate`。

### 3.3 Interceptor 四盲区收口（腾讯版）

腾讯独有的网络盲区（对齐抖音 spec 5.3 四盲区模式）：

| 盲区 | 旧（DOM 轮询） | 新（Interceptor） |
|---|---|---|
| QR 扫码状态 | `frame.evaluate` 轮询二维码 DOM（`:471`/`:585`） | `pollStatus` 拦扫码状态 API（成功/过期/取消） |
| 登录态校验 | DOM 判断 | `pollStatus` 拦用户信息 API |
| 视频列表 | `page.evaluate` + wujie 穿透混读 | `collectResponses` 拦视频列表 API，DOM 仅点击翻页 |
| 评论分页 | 散落捕获 | `collectResponses` 统一 |

兜底：`pollStatus`/`waitForResponse` 超时回退 DOM（保留现有 QR/登录态 DOM 逻辑为 fallback），埋点 `interceptor-fallback-to-dom`。

### 3.4 维护探针织入（enterStep/exitStep）

对齐抖音样板（`douyinCrawler.ts:194/278/1897` 的 `enterStep('monitor','douyin','Phase1',step)` 模式），腾讯织入关键子步骤：

```typescript
MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase1', 'navigateToSidebar');
// ... 侧边栏菜单定位（cdpPierceShadow / readAll）
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase1', 'fetchVideoListFromSource');
// ... collectResponses 拦视频列表 API
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'tencent', 'Phase3', 'processCommentsQueue');
// ... 评论树采集
MaintenanceProbe.exitStep();
```

- `probeBootstrap`/`teardownProbe` 已是平台无关的样板（`crawlers/probeBootstrap.ts`），腾讯直接复用，在任务入口 `bootstrapProbe({isDebugMode, taskExecutionId})`、出口 `teardownProbe()`。
- 探针在 `HumanActions.clickWithFallback`/`findInScope` + `Interceptor` 内部自动采集选择器/URL/响应结果，业务层只管 `enterStep`/`exitStep` 包络。
- `selectors.json` 的 `tencent` 段（22 条已有）通过 `SelectorRegistry` 桥接 `platform.flow.key`，探针自动关联——不需新增 selector，只需确保织入的 step key 与现有 `flowRules` 对齐。

**探针step key命名规范**：
1. **格式**：`<flow>.<platform>.<phase>.<step>`
2. **命名规则**：
   - `flow`：业务流程类型，使用小写字母（如`monitor`、`publish`、`reply`）
   - `platform`：平台标识，使用小写字母（如`douyin`、`tencent`、`kuaishou`、`xiaohongshu`）
   - `phase`：阶段标识，使用PascalCase（如`Phase1`、`Phase2`、`Phase3`）
   - `step`：步骤标识，使用camelCase（如`navigateToSidebar`、`fetchVideoListFromSource`）
3. **示例**：
   - `monitor.tencent.Phase1.navigateToSidebar`
   - `monitor.kuaishou.Phase3.processCommentsQueue`
   - `publish.xiaohongshu.Phase2.submitContent`
4. **验证规则**：
   - 步骤标识必须以动词开头（如`navigate`、`fetch`、`process`、`submit`）
   - 避免使用缩写，确保可读性
   - 同一phase下的step名称必须唯一
5. **自动化验证**：
   - 在CI中添加step key格式验证脚本
   - 验证所有step key符合命名规范
   - 验证四平台step key命名一致性

### 3.5 腾讯双路径与上线

- `ANTI_DETECTION_MODE_TENCENT=legacy|v2`，默认 `legacy`。
- 31+3 处盲区用 `if (isEnabled('tencent')) { v2: cdpPierceShadow/safeEvaluate/Interceptor } else { legacy: 原 page.evaluate }` 包络。
- 灰度：先 `v2` 跑监控采集（最低风险功能），埋点对比 `actionPath`（native/pierce 占绝大多数、`safeEvaluate-main` 趋近 0）+ 风控触发率，连续 7 天 v2 不劣于 legacy → 全量切 v2 → 删 legacy 分支。
- **可选针对性盲测**：腾讯 TGuard 最强，若埋点对比中 v2 风控触发率逼近 legacy，加一轮抖音式 Phase 0 盲测（同批视频 A/B 各 50 次）定位是 Patchright 注入被检测还是穿透路径指纹问题。

### 3.6 腾讯批次交付物

- `tencentCrawler.ts`：31 `page.evaluate` + 3 `frame.evaluate` 全部归入 legacy 分支，v2 走新契约；侧边栏菜单解析改 `readAll`+`cdpPierceShadow`。
- `platforms/tencent.ts`、`loginFlowHelpers.ts` 腾讯部分：发布/登录 DOM 轮询 → Interceptor。
- 探针织入：Phase1/Phase3 关键子步骤 `enterStep`/`exitStep`。
- 静态守卫：腾讯范围裸调用 = 0（CI 守卫）。
- 测试：现有 `tencentCrawler` 测试 + 新增穿透/Interceptor 单测全绿；端到端监控采集走通。

---

## 4. 快手批次（标准 DOM 收口，第 3 批）

快手是契约二次验证批次：标准 DOM（无 wujie 穿透）、风控较轻、14 处 `page.evaluate`。当前已用 128 处旧 CDP 中心 `HumanActions` + 56 处 Interceptor，是三平台中旧契约使用最密集的——正好验证新契约能否平滑承接。

### 4.1 14 处 `page.evaluate` 分类路由

快手无 wujie、无 ShadowDOM，14 处全是标准 DOM 读/解析，路由最直接：

| 归类 | 数量（估） | 路由到 | 典型场景 |
|---|---|---|---|
| 纯 DOM 读 | ~9 | `readText`/`readAttribute`/`exists`/`readAll` | 评论计数、元素存在性、视频信息文本 |
| 必须访问页面 JS | ~1 | `safeEvaluate(world:'main', reason)` | 读快手页面全局状态，受 ESLint 配额 |
| API 响应解析 | ~4 | `collectResponses`/`waitForResponse` | 视频列表、评论分页、发布结果 |

**契约二次验证要点**：快手批次的核心价值不是"啃硬骨头"，而是验证抖音锁定的 `readText`/`readAll`/`exists`/`safeEvaluate` 契约在第二个标准 DOM 平台上无歧义、无补丁需求。若快手出现契约不适配（如 `readAll` 批量读返回结构不够用），暴露的是契约本身缺陷，需回溯核心类而非快手本地 hack——这是把快手排在腾讯之后、小红书之前的理由：比小红书盲区多（验证强度够），比腾讯简单（契约问题不会被 wujie 复杂度掩盖）。

### 4.2 2 处 `page.locator` + 旧 CDP 方法迁移

- 2 处 `page.locator(` → `HumanActions.click`/`exists`（原生 Locator + 拟人化前置）。
- 128 处旧 CDP 中心方法（`cdpClick`/`cdpFindElement`/`cdpIsElementVisible`/`queryElementsWithInfo` 等）按 spec 4.7 分类：
  - 交互/查找/读取类 → 迁移到新原生 API（`click`/`exists`/`readAll`）。
  - 物理滚动 `cdpSmartScroll`/键盘扫描码 `cdpKeyboard`/贝塞尔 `humanMove` → **保留**（铁律 2）。
- 迁移遵循 spec 4.6 四阶段：新增 API 已就位（阶段①抖音已完成）→ 快手只用新 API（阶段③）→ 旧方法标 `@deprecated` 但不删（其他平台仍在用）。

### 4.3 Interceptor 收口

快手已有 56 处 Interceptor 调用（三平台最多），盲区较少：

| 盲区 | 旧 | 新 |
|---|---|---|
| 视频列表/评论分页 | 部分混 DOM 读取 | `collectResponses` 统一，DOM 仅翻页交互 |
| 发布结果 | DOM 文本轮询 | `waitForResponse` 拦发布 API + DOM 兜底 |
| 登录态 | DOM 判断 | `pollStatus` 拦登录态 API |

兜底策略与抖音/腾讯一致：拦截器超时回退 DOM，埋点 `interceptor-fallback-to-dom`。

### 4.4 维护探针织入

对齐抖音样板，快手织入：

```typescript
MaintenanceProbe.enterStep('monitor', 'kuaishou', 'Phase1', 'fetchVideoListFromSource');
// ... collectResponses
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'kuaishou', 'Phase3', 'processCommentsQueue');
// ... 评论树采集
MaintenanceProbe.exitStep();
```

- `probeBootstrap`/`teardownProbe` 复用（平台无关）。
- `selectors.json` 的 `kuaishou` 段（65 条，三平台最多）通过 `SelectorRegistry` 桥接，探针自动关联——65 条已有配置是快手批次的优势，织入 step key 对齐现有 `flowRules` 即可。
- 快手批次的探针织入同时验证：抖音/腾讯的探针 step key 命名规范（`<flow>.<platform>.<phase>.<step>`）在第三个平台上仍一致、可被维护面板按平台分组展示。

### 4.5 快手双路径与上线

- `ANTI_DETECTION_MODE_KUAISHOU=legacy|v2`，默认 `legacy`。
- 14 处盲区用 `if (isEnabled('kuaishou')) { v2 } else { legacy }` 包络。
- 灰度：监控采集先 `v2`，埋点对比（风控较轻，预期 v2 快速达标）→ 连续 7 天不劣于 legacy → 全量切 v2 → 删 legacy。
- **契约回溯触发条件**：若快手迁移中发现 `readAll`/`safeEvaluate` 契约需修改，暂停快手批次，回核心类改契约 + 抖音/腾讯回归验证，再继续。这是快手作为"契约二次验证"批次的护栏职责。

**契约回溯详细流程**：
1. **问题识别**：快手开发人员在迁移过程中发现契约不适配（如`readAll`批量读返回结构不够用、`safeEvaluate`参数不满足需求等）
2. **暂停快手批次**：立即暂停快手批次的开发工作，标记为"blocked-契约回溯"
3. **问题分析**：
   - 记录具体的不适配场景和用例
   - 分析是契约设计缺陷还是快手平台特殊性
   - 评估对抖音/腾讯现有实现的影响
4. **契约修改**：
   - 在`humanActions.ts`中修改相关契约
   - 确保修改向后兼容（不破坏抖音/腾讯现有功能）
   - 更新相关类型定义和文档
5. **回归验证**：
   - 运行抖音全量测试套件，确保不回归
   - 运行腾讯全量测试套件，确保不回归
   - 运行核心类单元测试，确保新契约正常工作
6. **快手批次恢复**：
   - 使用修改后的契约继续快手批次开发
   - 验证快手场景现在能正常工作
   - 更新快手批次的测试用例
7. **文档更新**：
   - 更新契约文档，说明修改原因和影响
   - 更新快手批次设计文档，记录回溯过程
   - 通知相关团队成员契约变更

**回溯时间预估**：
- 简单契约调整：1-2天
- 复杂契约重构：3-5天
- 包含回归验证：额外1-2天

**风险缓解**：
- 提前识别：在快手批次开始前，先用小规模原型验证契约在快手平台的适用性
- 并行准备：在快手批次开发的同时，准备抖音/腾讯的回归测试套件
- 沟通机制：建立快速沟通渠道，确保契约问题能及时反馈和解决

### 4.6 快手批次交付物

- `kuaishouCrawler.ts`：14 `page.evaluate` + 2 `page.locator` 全归 legacy 分支，v2 走新契约；旧 CDP 方法迁移到新 API（物理类保留）。
- `platforms/kuaishou.ts`、`loginFlowHelpers.ts` 快手部分：发布/登录 → Interceptor。
- 探针织入：Phase1/Phase3 关键子步骤。
- 静态守卫：快手范围裸调用 = 0。
- 测试：现有 `kuaishouCrawler` 测试 + 新增单测全绿；端到端走通；**契约回归**（确认快手未触发核心类契约修改，或已回溯处理）。

---

## 5. 小红书批次（标准 DOM 收口，第 4 批）

小红书是收尾批次：x-s 风控、标准 DOM、当前最干净（0 处 `page.evaluate`，但 7 处 `page.locator` + 1 处 `page.keyboard`）。已用 63 处旧 CDP 中心 `HumanActions` + 53 处 Interceptor。盲区最少，但 x-s 风控对**网络层接管**要求最高——Interceptor 收口是本批次重点。

### 5.1 盲区现状与路由

小红书无 `page.evaluate`/`frame.evaluate`，盲区集中在交互入口：

| 盲区 | 数量 | 路由到 | 说明 |
|---|---|---|---|
| `page.locator(` | 7 | `HumanActions.click`/`exists`/`readText` | 原生 Locator + 拟人化前置，替代裸 locator |
| `page.keyboard.` | 1 | `HumanActions.press`/`cdpKeyboard` | 视为扫描码场景走 CDP（铁律 2），或 `press` 原生 |
| 旧 CDP 中心方法 | 63 处中交互/查找/读取类 | 新原生 API（`click`/`exists`/`readAll`） | 物理类（`cdpSmartScroll`/`humanMove`）保留 |

**收口强度低但完整性要求高**：小红书盲区少，但 x-s 风控环境下任何残留裸调用都可能被风控用作指纹。静态守卫在小红书范围期望 = 0 是硬指标，7 处 `page.locator` 是主要清零目标。

### 5.2 Interceptor 收口（x-s 风控，本批次重点）

小红书 x-s 签名风控意味着请求头/响应体是风控判定关键。Interceptor 收口从"可见性"升级为"接管完整性"：

| 盲区 | 旧 | 新 |
|---|---|---|
| 视频列表/评论分页 | 部分混 DOM 读取 | `collectResponses` 统一，DOM 仅翻页 |
| 发布结果 | DOM 文本轮询 | `waitForResponse` 拦发布 API + DOM 兜底 |
| 登录态/QR 状态 | DOM 判断 | `pollStatus` 拦登录态/扫码 API |
| **x-s 签名请求观测** | 散落捕获 | `collectResponses` 拦 x-s 相关 API，埋点记录签名命中率 |

兜底策略一致：拦截器超时回退 DOM，埋点 `interceptor-fallback-to-dom`。小红书因 x-s 风控，**Interceptor 1% 无兜底采样**（对齐抖音 spec 5.4）格外重要——验证拦截器在 x-s 签名场景下自身可靠性，采样失败率 >10% 触发告警。

### 5.3 维护探针织入

对齐抖音样板：

```typescript
MaintenanceProbe.enterStep('monitor', 'xiaohongshu', 'Phase1', 'fetchVideoListFromSource');
// ... collectResponses
MaintenanceProbe.exitStep();

MaintenanceProbe.enterStep('monitor', 'xiaohongshu', 'Phase3', 'processCommentsQueue');
// ... 评论树采集
MaintenanceProbe.exitStep();
```

- `probeBootstrap`/`teardownProbe` 复用。
- `selectors.json` 的 `xiaohongshu` 段（38 条）通过 `SelectorRegistry` 桥接，探针自动关联。
- 小红书批次完成时，**四平台探针 step key 命名规范统一**（`<flow>.<platform>.<phase>.<step>`），维护面板可按平台分组、跨平台对比同 phase 健康度——这是维护调试系统 FlowGraphView 智能分层的前置数据完整性。

### 5.4 小红书双路径与上线

- `ANTI_DETECTION_MODE_XIAOHONGSHU=legacy|v2`，默认 `legacy`。
- 7 处 `page.locator` + 1 处 `page.keyboard` 用 `if (isEnabled('xiaohongshu')) { v2 } else { legacy }` 包络。
- 灰度：监控采集先 `v2`，埋点对比（x-s 风控，重点关注 Interceptor 命中率 + 签名观测）→ 连续 7 天不劣于 legacy → 全量切 v2 → 删 legacy。
- 小红书盲区少，灰度周期预期最短，但 x-s 风控判定需更谨慎观察 Interceptor 采样指标。

### 5.5 小红书批次交付物

- `xiaohongshuCrawler.ts`：7 `page.locator` + 1 `page.keyboard` 全归 legacy 分支，v2 走新契约；旧 CDP 方法迁移（物理类保留）。
- `platforms/xiaohongshu*.ts`、`loginFlowHelpers.ts` 小红书部分：发布/登录 → Interceptor（含 x-s 签名观测）。
- 探针织入：Phase1/Phase3 关键子步骤。
- 静态守卫：小红书范围裸调用 = 0。
- 测试：现有 `xiaohongshuCrawler` 测试 + 新增单测全绿；端到端走通。

### 5.6 四平台收口完成后的终态

小红书批次完成 = spec 第 8 节路线图第 2-4 批全部落地，达到：

- **静态零直接调用**：四平台范围文件裸调用 = 0（CI 守卫全覆盖）。
- **运行时埋点全覆盖**：四平台 `TaskExecutionStep.extra.antiDetection` 写入，`actionPath` native/pierce 占绝大多数，`safeEvaluate-main` 趋近 0，`interceptor-hit` 高。
- **探针数据完整**：四平台 `<flow>.<platform>.<phase>.<step>` 一致，维护面板可跨平台对比——为维护调试系统 FlowGraphView 提供完整数据。
- **双路径全切 v2**：四平台独立开关均达判据后切 v2，legacy 分支删除。
- **旧 CDP 中心方法可清理**：spec 4.6 阶段④前置满足，`cdpClick`/`cdpFindElement` 等 `@deprecated` 方法可统一删除（独立清理任务，不塞进本批次）。

---

## 6. 批次排期、验证策略与风险

### 6.1 串行/并行边界（对齐 spec 8.2）

| 阶段 | 内容 | 编码并行性 |
|---|---|---|
| 前置批次 | `cdpPierceShadow` + `registerPlatformPierce` + 静态守卫泛化 + `antiDetectionMode` 每平台开关 | 串行（改共享 `humanActions.ts`） |
| 第 2 批 腾讯 | `tencentCrawler` + `platforms/tencent` + `loginFlowHelpers` 腾讯部分 | 核心类已稳定后，可与快手/小红书业务层 worktree 并行 |
| 第 3 批 快手 | `kuaishouCrawler` + `platforms/kuaishou` | 同上 |
| 第 4 批 小红书 | `xiaohongshuCrawler` + `platforms/xiaohongshu` | 同上 |
| 灰度上线 | 每平台 `v2` 灰度 + 埋点对比 + 切 v2 | **严格串行**（风控变量隔离，一次只灰度一个平台） |

**关键约束**：
- 设计文档已并行写完（本 spec 即总纲）。编码阶段，前置批次必须先合并稳定，业务层三批次才可 worktree 并行——但任一批次若需改 `humanActions.ts`/`interceptor.ts`（如快手契约回溯），立即退出并行、回串行改核心类。
- 灰度上线绝不并行：同时灰度多平台会混淆风控触发率的归因（无法判断是哪平台的 v2 引发风控波动）。

### 6.2 验证策略（埋点对比为主）

每平台批次验证分四层（对齐抖音 spec 第 10 节，但 Phase 0 盲测降级为可选）：

**层 1 — 静态守卫（CI 硬门）**
- 该平台范围文件裸调用数 = 0（grep + CI 守卫）。
- `safeEvaluate(world:'main')` ≤ 3/文件（ESLint 配额）。

**层 2 — 单元测试**
- 现有 crawler 测试全绿（不回归）。
- 新增：穿透/Interceptor/探针 step key 单测。
- 腾讯额外：`cdpPierceShadow` css/shadow/frame 三类 step + 失败返回 null。

**层 3 — 运行时埋点对比（核心判据）**
- `v2` 灰度跑监控采集，查 `TaskExecutionStep.extra.antiDetection`：
  - `actionPath`：native/dom/pierce 占绝大多数。
  - `cdpSessionCreated` ≈ 1/page（长连接，铁律 4）。
  - `interceptorHit` 高、`interceptor-fallback-to-dom` 低。
  - `safeEvaluate-main` 趋近 0。
  - `rawPageCallAttempted` 全 false。
- **风控触发率对比**：`v2` vs `legacy` 同期 `risk_control`/`login_required`/验证码触发频率。
- 判据：连续 7 天 `v2` 风控触发率不劣于 `legacy` → 达标。

**层 4 — 功能不回归**
- 三功能（发布/监控/回复）端到端走通。
- 行为时序与改造前一致（spec 6.4 第 4 条，避免拟人化前置引入新指纹）。

**可选盲测（腾讯/小红书）**：
- 腾讯 TGuard 最强：若埋点对比中 v2 风控逼近 legacy，加一轮 Phase 0 盲测（同批视频 A/B 各 50 次）定位是 Patchright 注入被检测还是穿透路径指纹。
- 小红书 x-s：若 Interceptor 1% 无兜底采样失败率 >10%，加盲测定位拦截器在签名场景的可靠性。
- 快手风控轻，不盲测。

### 6.3 上线与回滚

| 阶段 | 动作 | 回滚 |
|---|---|---|
| 灰度 | 平台开关置 `v2`，跑监控采集 | 改回 `legacy`，无需代码回滚 |
| 观察 | 7 天埋点对比 | 任意时刻可回 legacy |
| 全量切 v2 | 达判据后删 legacy 分支 | git revert（删分支后失去运行时回滚，需确保达判据） |
| 旧方法清理 | 四平台全 v2 后，删 `@deprecated` CDP 方法 | 独立任务，非本设计范围 |

**双路径共存窗口**：每平台 legacy/v2 共存至少 2 周（对齐抖音 spec 9 第 7 条），埋点对比达标后才删 legacy。

### 6.4 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `cdpPierceShadow` CDP DOM 域穿透在 wujie 双层结构下不完整 | 腾讯视频列表/评论采集失败 | 前置批次单测覆盖 shadow/frame；腾讯批次先用 `registerPlatformPierce` 注册特有 handler 兜底；失败返回 null + 业务层显式决定降级（不静默） |
| 契约不适配（快手二次验证暴露） | 回溯核心类，影响抖音/腾讯 | 快手批次护栏：发现不适配立即暂停，回核心类改契约 + 抖音/腾讯回归，再继续 |
| x-s 签名场景 Interceptor 可靠性不足 | 小红书网络判定频繁降级 DOM | 1% 无兜底采样 + 失败率 >10% 告警 + 可选盲测 |
| 并行业务层批次误改核心类 | 合并冲突、契约漂移 | worktree 并行仅限业务 crawler；改核心类立即退并行回串行 |
| 灰度期风控波动归因困难 | 误判 v2 劣化 | 严格串行灰度，一次一平台；埋点 `actionPath` 细粒度归因 |
| 拟人化前置引入新行为指纹 | 风控触发率反升 | 行为时序对齐改造前（spec 6.4）；埋点对比以风控触发率为准绳 |
| 探针 step key 跨平台不一致 | 维护面板无法跨平台对比 | 四平台统一 `<flow>.<platform>.<phase>.<step>`，小红书批次验收时核对 |

### 6.5 成功标准（四平台终态）

1. **静态零直接调用**：四平台范围裸调用 = 0（CI 守卫全覆盖）。
2. **运行时埋点**：四平台 `extra.antiDetection` 写入，`actionPath` native/pierce 占绝大多数，`cdpSessionCreated`≈1/page，`safeEvaluate-main` 趋近 0，`interceptor-hit` 高。
3. **功能不回归**：四平台三功能端到端走通，现有 + 新增单测全绿。
4. **契约复用无回溯**：快手二次验证未触发核心类契约修改（或已回溯处理并回归）。
5. **探针数据完整**：四平台 step key 命名统一，维护面板可跨平台对比。
6. **双路径全切 v2**：四平台独立开关达判据后切 v2，legacy 删除。
7. **5 条铁律落地**：四平台范围内铁律 1-5 全部可验证满足。

### 6.6 不在范围

- 第 5 批 `browserApiService` 裸 CDP WebSocket 收口 + Interceptor 全局注册化（spec 8.3，跨平台基础设施，独立排期）。
- FlowGraphView 反检测维度展示（维护调试系统独立 spec 职责，本设计只产数据）。
- 删除旧 CDP 中心方法（spec 4.6 阶段④，四平台全 v2 后独立清理任务）。
- 抖音已收口代码（不改，作为样板）。
- 调度/队列/数据库逻辑（纯浏览器层重构）。
