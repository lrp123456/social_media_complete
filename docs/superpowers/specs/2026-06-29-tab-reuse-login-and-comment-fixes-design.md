# 标签页复用、登录态泄漏、快手刷新二维码与评论爬取修复设计

> 日期：2026-06-29
> 状态：待审查

## 1. 问题概述

项目存在四个关联问题，均涉及浏览器标签页管理与快手平台逻辑：

| 编号 | 问题 | 严重程度 |
|------|------|----------|
| P1 | 标签页未复用（Pinterest platform 参数错误） | 中 |
| P2 | 快手二次刷新后收到的是密码登录页截图而非二维码 | 高 |
| P3 | 未主动登录快手却爬到数据（登录标签页跨域标记丢失） | 高 |
| P4 | 特定视频"奶油风客厅"评论无法爬取（Simple 模式缺少 Pre-check） | 高 |

## 2. 根因分析

### 2.1 P1：Pinterest platform 参数错误

**位置**：`apps/ts-api-gateway/src/platforms/pinterest.ts:77`

```typescript
const { browser, page } = await bm.connect(task.windowId, '', 'douyin');
```

Pinterest 传入了 `platform='douyin'`，导致：
- `sessionKey = windowId_douyin`，复用抖音的 `UserSession`，可能与真实抖音爬虫产生 session 冲突
- `findPlatformPage()` 按 `douyin.com` 匹配 URL，永远找不到 Pinterest 页面
- 每次都走新建标签页分支

**根因**：`Platform` 类型（`packages/browser-core/src/types.ts:1`）不含 `'pinterest'`，开发者用了 `'douyin'` 作为占位。

### 2.2 P2：快手刷新 QR 模式丢失

**位置**：`apps/ts-api-gateway/src/services/wechatBotService.ts`

**故障流程（"强制刷新" L786-793）**：

```
① ensureLoginTab() → 点击 div.platform-switch 切换到 QR 扫码模式 ✅
② record.page.goto(config.loginUrl) → 重新导航到登录页 ❌ 页面重置为密码登录模式
③ 等待3秒
④ captureQR() → 找不到 QR 元素 → 走全页兜底截图 ❌
⑤ 发送企微卡片 → 用户收到的是密码登录页的全页截图 ❌
```

"F5刷新"（L831-839）有同样问题：`record.page.reload()` 也会重置页面到默认密码模式。

**补充**：快手的 `data/selectors.json` 中 `loginFlows.creator` 缺少 `qrActivationSelector` 配置，`captureQR()` 内部不知道需要先点击 `div.platform-switch` 来激活 QR 模式。

### 2.3 P3：登录标签页跨域标记丢失

**位置**：`packages/browser-core/src/loginTabRegistry.ts` + `packages/browser-core/src/browserManager.ts`

**故障链路**：

1. 登录标签页在 `passport.kuaishou.com` 上设置 `__login_tab_mark__`（L208-211）
2. 用户扫码登录成功，页面跳转到 `cp.kuaishou.com`（创作者中心）
3. 快手配置 `closeOnLoginSuccess: false`，登录成功后走 `unregister()`（`monitorService.ts:789-792`）
4. `unregister()` 尝试清除 `localStorage` 标记（L27-29），但此时页面在 `cp.kuaishou.com`，清除的是 `cp.kuaishou.com` 的 localStorage——标记本来就不在这个域名下
5. `passport.kuaishou.com` 的标记残留在那（不再被访问），`cp.kuaishou.com` 上没有标记
6. 第二次执行时：`findPlatformPage()` 按 URL 匹配到这个标签页（URL 含 `kuaishou.com`），检查 `__login_tab_mark__` → 无标记 → 认为是工作标签页 → 返回它
7. `checkLoginStatus()` 看到 sidebar → 返回 `true` → 跳过登录直接爬取

**补充问题**：
- `findPlatformPage()` 的 fallback（L542）在所有候选都是登录标签页时返回 `candidates[0]`，把登录标签页当工作标签页
- `checkLoginStatus()` 默认返回 `true`（L216, L219），无法确认登录态时默认认为已登录

### 2.4 P4：Simple 模式缺少 Pre-check

**位置**：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` `processCommentsQueueSimple()` (L3313)

**日志证据**：

```
11:25:36  [Phase2] 评论管理页加载 → comment/home API 返回（默认选中"奶油风客厅"）→ commentList API 返回
11:25:40  [Simple] Phase3 start
11:25:40  [Simple] 清空所有评论响应 ← 把已有的 commentList 响应清掉了
11:25:40  [Drawer] 直接开抽屉 ← 没有检查已有响应是否匹配目标视频
11:25:45  ❌ cdpSession.send: Protocol error (Runtime.evaluate): Cannot find context
```

**根因**：`processCommentsQueueSimple` 缺少 `processCommentsQueue`（L1677-1701）中的 Pre-check 逻辑。评论管理页加载时默认选中的第一个视频就是目标视频"奶油风客厅"，其评论数据已经通过 API 返回，但 Simple 模式直接清空响应、开抽屉，导致：
- 已有的匹配响应被清空
- 开抽屉触发页面 iframe/context 重建
- `findAndClickVideoInDrawer` 调用 `evaluateOrSafe` 时 CDP execution context 已失效 → `Protocol error: Cannot find context`

## 3. 修复方案

### 3.1 修复 A：快手刷新 QR 模式丢失（P2）

**A1 + A2**：在 `wechatBotService.ts` 中，"强制刷新"和"F5刷新"在 `goto`/`reload` 之后、`captureQR` 之前，重新点击 `div.platform-switch`。

**A3**：在 `data/selectors.json` 中给快手 `loginFlows.creator` 添加 `"qrActivationSelector": "div.platform-switch"`，让 `captureQR()` 自身具备切换能力（双重保障）。

### 3.2 修复 B：`checkLoginStatus()` 安全默认值（P3 辅助）

将默认返回值从 `true` 改为 `false`：
- L216：无法确认登录态时默认未登录
- L219：检测异常时默认未登录

### 3.3 修复 C：登录标签页跨域标记丢失（P3 核心）

**C1**：`findPlatformPage()` fallback 返回 `undefined` 而非 `candidates[0]`。

**C2**：`unregister()` 在 `closeOnLoginSuccess: false` 时，如果页面已跳转到非登录域名（如 `cp.kuaishou.com`），关闭该页面，防止残留为孤儿标签页被误用为工作标签页。

**C3**：`findPlatformPage()` 检查页面 URL 是否在登录页域名（`passport.*`），是则跳过该候选。

### 3.4 修复 D：Pinterest platform 参数（P1）

**D1**：`Platform` 类型添加 `'pinterest'`。
**D2**：`findPlatformPage()` 添加 pinterest URL 匹配（`pinterest.com`）。
**D3**：`pinterest.ts:77` 的 `'douyin'` 改为 `'pinterest'`。

### 3.5 修复 E：Simple 模式添加 Pre-check（P4）

**E1 + E2**：在 `processCommentsQueueSimple` 清空旧响应之前，添加 Pre-check：检查 `comment/home` 的 `photoId` 是否匹配 `item.awemeId`。如果匹配，直接使用已有 `commentList` 响应，跳过抽屉操作。

**E3**：`findAndClickVideoInDrawer` 中的 `evaluateOrSafe` 在 CDP 上下文丢失（`Cannot find context`）时，自动重新获取 CDP session 重试一次。

## 4. 修改清单

| 编号 | 文件 | 修改内容 | 优先级 |
|------|------|----------|--------|
| A1 | `wechatBotService.ts:789-790` | 强制刷新 goto 后重新点击 platform-switch | 高 |
| A2 | `wechatBotService.ts:835-836` | F5刷新 reload 后重新点击 platform-switch | 高 |
| A3 | `data/selectors.json` | 快手 loginFlows.creator 添加 qrActivationSelector | 高 |
| B1 | `kuaishouCrawler.ts:216` | checkLoginStatus 默认返回 false | 高 |
| B2 | `kuaishouCrawler.ts:219` | checkLoginStatus 异常返回 false | 高 |
| C1 | `browserManager.ts:542` | findPlatformPage fallback 返回 undefined | 高 |
| C2 | `loginTabRegistry.ts:19-32` | unregister() 关闭跨域标签页 | 高 |
| C3 | `browserManager.ts:534` | findPlatformPage 排除 passport 域名 | 中 |
| D1 | `types.ts:1` | Platform 添加 'pinterest' | 中 |
| D2 | `browserManager.ts:528` | findPlatformPage 添加 pinterest 匹配 | 中 |
| D3 | `pinterest.ts:77` | platform 改为 'pinterest' | 中 |
| E1 | `kuaishouCrawler.ts:3336` | Simple 模式添加 Pre-check | 高 |
| E2 | `kuaishouCrawler.ts:3336` | 匹配时跳过抽屉直接用已有响应 | 高 |
| E3 | `kuaishouCrawler.ts:2154` | CDP 上下文丢失时重试 | 中 |

## 5. 文件归属

为避免并行写入冲突，按文件分组：

| 文件 | 涉及修复项 |
|------|-----------|
| `packages/browser-core/src/browserManager.ts` | C1, C3, D2 |
| `packages/browser-core/src/types.ts` | D1 |
| `packages/browser-core/src/loginTabRegistry.ts` | C2 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | A1, A2 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | B1, B2, E1, E2, E3 |
| `apps/ts-api-gateway/src/platforms/pinterest.ts` | D3 |
| `data/selectors.json` | A3 |

## 6. 测试策略

- **P1**：验证 Pinterest 爬虫使用 `sessionKey = windowId_pinterest`，不再与抖音冲突
- **P2**：验证"强制刷新"/"F5刷新"后收到的卡片包含 QR 码而非密码登录页截图
- **P3**：验证快手登录成功后，登录标签页被关闭（closeOnLoginSuccess: false 时），第二次监控不会复用已登录的登录标签页
- **P4**：验证"奶油风客厅"视频在 Simple 模式下，当页面默认选中该视频时，直接使用已有 API 响应，不触发抽屉操作
- 现有单元测试：`kuaishouDrawerUtils.test.ts` 和 `commentCrawlRules.test.ts` 应继续通过

## 7. 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| B1/B2 改默认值可能导致已登录用户被误判为未登录 | 中 | `checkLoginStatus` 仍会检查 sidebar 可见性，已登录页面不会误判 |
| C2 关闭跨域标签页可能影响需要保留的标签页 | 低 | 仅在 `closeOnLoginSuccess: false` 且页面已跳转到非 passport 域名时关闭 |
| E1/E2 Pre-check 可能误判 | 低 | 严格匹配 `photoId === item.awemeId`，不匹配时仍走原抽屉流程 |
