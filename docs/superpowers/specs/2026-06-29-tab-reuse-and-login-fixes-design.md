# 标签页复用与登录态泄漏修复设计

> 日期: 2026-06-29
> 状态: 已批准
> 涉及文件: 8 个

## 1. 问题概述

### 问题1: 标签页不复用

Pinterest 爬虫在 `pinterest.ts:77` 传入 `platform='douyin'`，导致：
- 复用抖音的 `UserSession`（`sessionKey = windowId_douyin`）
- `findPlatformPage()` 按 `douyin.com` 匹配，永远找不到 Pinterest 页面
- 每次走新建标签页分支，与真实抖音爬虫产生 session 冲突

根因：`Platform` 类型定义（`types.ts:1`）不含 `'pinterest'`，无法传入正确值。

### 问题2: 快手二次刷新收到截图而非二维码

企微卡片"强制刷新"和"F5刷新"命令在 `goto`/`reload` 后页面重置为密码登录模式，未重新点击 `div.platform-switch` 切换 QR 模式。`captureQR()` 找不到 QR 元素，走全页兜底截图。

涉及文件：
- `wechatBotService.ts:789` — 强制刷新 `goto` 后无 QR 切换
- `wechatBotService.ts:835` — F5刷新 `reload` 后无 QR 切换
- `data/selectors.json` — 快手缺少 `qrActivationSelector` 配置

### 问题3: 未主动登录却能爬到数据

快手登录标签页在 `passport.kuaishou.com` 设置 `__login_tab_mark__`。扫码成功后页面跳转到 `cp.kuaishou.com`，`unregister()` 尝试清除标记但跨域名无效。该标签页成为 `cp.kuaishou.com` 上的孤儿页面，无登录标记。

第二次执行时 `findPlatformPage()` 按 URL 匹配到这个标签页，检查 `__login_tab_mark__` → 无标记 → 认为是工作标签页 → 返回它。`checkLoginStatus()` 看到 sidebar → 返回 `true` → 跳过登录直接爬取。

### 问题4: "奶油风客厅"视频评论详情无法爬取

日志确认：评论管理页加载时"奶油风客厅"（第一个视频）默认选中，`comment/home` 和 `commentList` API 已返回数据。但 Simple 模式（`processCommentsQueueSimple`）不检查已有响应，直接清空所有评论响应并打开抽屉。开抽屉触发页面 context 重建，CDP execution context 失效，`findAndClickVideoInDrawer` 报 `Protocol error: Cannot find context with specified id`。

对比 `processCommentsQueue`（完整模式）有 Pre-check 逻辑（L1677-1701），Simple 模式缺少此逻辑。

## 2. 设计方案

### 修复 A: 快手刷新 QR 模式丢失（问题2）

**单点修复策略**（避免多次切换 QR/密码模式）：

A1. `data/selectors.json` — 快手 `loginFlows.creator` 添加 `"qrActivationSelector": "div.platform-switch"`
A2. `loginTabRegistry.ts` — `captureQR()` 修改 `qrActivationSelector` 逻辑：点击前先检查 QR 元素是否已可见，已可见则不点击

**设计决策**：不在 `wechatBotService.ts` 中额外插入点击逻辑。原因：

1. `ensureLoginTab()` 在 `goto`/`reload` 之前调用，其点击效果被后续 `goto`/`reload` 重置
2. `captureQR()` 在 `goto`/`reload` 之后调用，是唯一有效的切换点
3. `div.platform-switch` 是切换按钮（奇数次→QR，偶数次→密码），多处点击会导致最终状态不确定
4. 仅在 `captureQR()` 内部处理，确保只点击一次

**A2 实现**：修改 `captureQR()` L115-136，在 `if (config.qrActivationSelector)` 块内，点击前先检查 `qrSelectors` 中任一元素是否已可见。如果 QR 已可见，跳过点击。

各平台 `closeOnLoginSuccess` 和域名对照：

| 平台 | loginUrl 域名 | domain | closeOnLoginSuccess | 跨域登录 |
|------|---------------|--------|---------------------|----------|
| 快手 | passport.kuaishou.com | cp.kuaishou.com | false | 是 |
| 抖音 | creator.douyin.com | creator.douyin.com | false | 否 |
| 小红书 creator | creator.xiaohongshu.com | creator.xiaohongshu.com | false | 否 |
| 腾讯 | channels.weixin.qq.com | channels.weixin.qq.com | false | 否 |

### 修复 B: `checkLoginStatus()` 安全默认值（问题3辅助）

B1. `kuaishouCrawler.ts:216` — 默认返回 `false`（无法确认登录态时默认未登录）
B2. `kuaishouCrawler.ts:219` — 异常返回 `false`（检测异常时默认未登录）

当前默认 `return true` 在 cookie 持久化场景下不安全。改为 `false` 后，只有 sidebar 可见性检查通过才确认已登录。

### 修复 C: 登录标签页跨域标记丢失（问题3核心）

**三层防护**：

C1. `browserManager.ts:542` — `findPlatformPage()` fallback 返回 `undefined`

当前所有候选标签页都是登录标签页时，返回 `candidates[0]`（最后一个登录标签页）。改为返回 `undefined`，让 `connect()` 走新建标签页分支。

C2. `loginTabRegistry.ts:19-32` — `unregister()` 关闭跨域跳转的标签页

`closeOnLoginSuccess: false` 的平台（如快手），登录成功后只 `unregister` 不关闭页面。页面从 `passport.kuaishou.com` 跳转到 `cp.kuaishou.com` 后标记丢失，变成孤儿工作标签页。

**跨域判定**（避免误伤抖音/小红书/腾讯等同域平台）：

给 `LoginTabRecord` 添加 `loginUrl` 字段（在 `openLoginTab()` 中从 `config.loginUrl` 存入）。`unregister()` 清除标记后，比较当前页面 URL 与 `loginUrl` 的域名：
- 当前 URL **不包含** loginUrl 的域名 → 发生了跨域跳转 → 关闭页面
- 当前 URL **包含** loginUrl 的域名 → 同域（抖音/小红书/腾讯）→ 保留页面

| 平台 | loginUrl 域名 | 登录后 URL | 跨域? | C2 行为 |
|------|---------------|-----------|-------|---------|
| 快手 | passport.kuaishou.com | cp.kuaishou.com | 是 | 关闭 ✅ |
| 抖音 | creator.douyin.com | creator.douyin.com | 否 | 保留 ✅ |
| 小红书 | creator.xiaohongshu.com | creator.xiaohongshu.com | 否 | 保留 ✅ |
| 腾讯 | channels.weixin.qq.com | channels.weixin.qq.com | 否 | 保留 ✅ |

C3. `browserManager.ts:534` — `findPlatformPage()` 排除 passport 域名

在遍历候选标签页时，跳过 URL 在 `passport.` 域名上的页面。即使标记丢失，也不会选中来源是登录页的标签页。

### 修复 D: Pinterest platform 参数（问题1）

D1. `types.ts:1` — `Platform` 类型添加 `'pinterest'`
D2. `browserManager.ts:528` — `findPlatformPage()` 添加 pinterest URL 匹配（`pinterest.com`）
D3. `pinterest.ts:77` — `'douyin'` → `'pinterest'`

### 修复 E: Simple 模式添加 Pre-check（问题4）

E1. `kuaishouCrawler.ts:3336` — 在清空旧响应之前添加 Pre-check

在 `processCommentsQueueSimple` 中，清空旧评论响应之前，检查 `comment/home` 的 `photoId` 是否匹配 `item.awemeId`。如果匹配，直接使用已有 `commentList` 响应，跳过抽屉操作。

逻辑与 `processCommentsQueue` L1677-1701 的 Pre-check 一致：
1. 获取 `COMMENT_HOME_PATTERN` 的最新响应
2. 提取 `photoId` 和 `title`
3. 如果 `photoId === item.awemeId`，检查 `COMMENT_LIST_PATTERN` 是否有响应
4. 有响应 → 直接进入评论解析流程，不清空、不开抽屉
5. 无响应或 photoId 不匹配 → 走原有抽屉流程

E2. 匹配时跳过抽屉直接用已有响应 — E1 的一部分

E3. `kuaishouCrawler.ts:2154` — CDP 上下文丢失时清除隔离世界缓存并重试

`findAndClickVideoInDrawer` 中 `evaluateOrSafe` 失败时报 `Protocol error: Cannot find context with specified id`。根因：`HumanActions.isolatedWorldIds`（`humanActions.ts:75`）缓存了隔离世界 contextId，页面 context 重建后缓存失效，但 `getIsolatedWorldId()`（L208-209）直接返回缓存不验证有效性。

修复：在 `findAndClickVideoInDrawer` 方法内，对第一个 `evaluateOrSafe` 调用添加 try-catch，捕获 `Cannot find context` 错误后：
1. 清除缓存的 contextId：`HumanActions.isolatedWorldIds.delete(page)`
2. 等待 2 秒让页面 context 重建
3. 重试一次 `evaluateOrSafe`

## 3. 修改清单

| 编号 | 文件 | 修改内容 | 优先级 | 问题 |
|------|------|----------|--------|------|
| A1 | `data/selectors.json` | 快手添加 `qrActivationSelector` | 高 | 问题2 |
| A2 | `loginTabRegistry.ts` | `captureQR()` 点击前先检查 QR 是否已可见 | 高 | 问题2 |
| B1 | `kuaishouCrawler.ts:216` | 默认返回 `false` | 高 | 问题3 |
| B2 | `kuaishouCrawler.ts:219` | 异常返回 `false` | 高 | 问题3 |
| C1 | `browserManager.ts:542` | fallback 返回 `undefined` | 高 | 问题3 |
| C2 | `loginTabRegistry.ts` + `types.ts` | `LoginTabRecord` 加 `loginUrl` 字段；`unregister()` 按跨域判定关闭 | 高 | 问题3 |
| C3 | `browserManager.ts:534` | 排除 passport 域名标签页 | 中 | 问题3 |
| D1 | `types.ts:1` | Platform 添加 `'pinterest'` | 中 | 问题1 |
| D2 | `browserManager.ts:528` | findPlatformPage 添加 pinterest | 中 | 问题1 |
| D3 | `pinterest.ts:77` | platform 改为 `'pinterest'` | 中 | 问题1 |
| E1 | `kuaishouCrawler.ts:3336` | Simple 模式添加 Pre-check，匹配时跳过抽屉 | 高 | 问题4 |
| E2 | `kuaishouCrawler.ts:2154` | CDP 上下文丢失时清除隔离世界缓存并重试 | 中 | 问题4 |

## 4. 涉及文件

| 文件 | 修改项 |
|------|--------|
| `data/selectors.json` | A1 |
| `packages/browser-core/src/loginTabRegistry.ts` | A2, C2 |
| `packages/browser-core/src/types.ts` | C2 (LoginTabRecord 加字段), D1 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | B1, B2, E1, E2 |
| `packages/browser-core/src/browserManager.ts` | C1, C3, D2 |
| `apps/ts-api-gateway/src/platforms/pinterest.ts` | D3 |

## 5. 并行化分组

按文件无冲突原则分为 4 组，可并行执行：

- **组1**: `browserManager.ts` + `types.ts`（C1, C3, D1, D2）— 注意 C2 也改 `types.ts`，需协调
- **组2**: `kuaishouCrawler.ts`（B1, B2, E1, E2）
- **组3**: `loginTabRegistry.ts` + `selectors.json`（A1, A2, C2）
- **组4**: `pinterest.ts`（D3）

> ⚠️ 组1 和组3 都修改 `types.ts`（组1 改 `Platform` 类型，组3 改 `LoginTabRecord` 接口），建议同一 fixer 先完成组1 再完成组3，或将 `types.ts` 全部修改归到同一组。

## 6. 风险评估

- **C2**（`unregister` 关闭跨域标签页）：使用 `loginUrl` 域名比较而非硬编码 `passport.*`，确保只关闭发生跨域跳转的标签页。抖音/小红书/腾讯的 loginUrl 与工作域名相同，不会被误关。
- **B1/B2**（默认返回 false）：可能导致页面加载中 sidebar 暂未渲染时被误判为未登录，触发不必要的导航。`handleLogin` 检测到 cookie 登录后页面会从 passport 自动跳回 cp，代价约 3-5 秒。
- **E1**（Simple 模式 Pre-check）：`comment/home` 和 `commentList` 是同一请求链的响应，对应同一视频。Pre-check 命中时直接使用已有数据，避免开抽屉触发 context 重建。
- **E2**（CDP 重试）：清除 `isolatedWorldIds` 缓存后重试，如果页面 context 仍在重建中，重试可能再次失败。通过 2 秒等待降低此风险。
- **A2**（captureQR 先检查 QR 可见性）：`qrSelectors` 中的选择器可能不匹配快手实际 QR 元素，导致 `qrAlreadyVisible` 始终为 false，退化为原行为（总是点击切换按钮）。不会比现状更差。
