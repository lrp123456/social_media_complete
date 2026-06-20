# XHS Phase 3 评论采集重写 + 企微卡片 F5 刷新 QR 码

> 日期: 2026-06-20
> 状态: 设计已确认，待实现
> 范围: 小红书评论采集流程重写 + 所有平台企微卡片增加 F5 刷新按钮

## 背景与问题

### 问题 1: XHS Phase 3 评论采集完全失败

日志显示 Phase 3 尝试处理 11 个笔记，全部失败：

```
"error":"No card selector","msg":"[XHS-Phase3] Failed to open new tab for note"
"queueLength":11,"successCount":0,"failCount":11
```

根本原因：`selectors.json` 中缺少 `region.note-card-by-id` 和 `region.note-card-cover` 选择器，`clickThumbnailAndWaitNewTab` 调用 `getSelector` 返回空 → `No card selector` → 全部跳过。

### 问题 2: 登录检测时机不对

之前的设计单独开标签页检测主站登录态（`checkMainsiteLogin`），与实际评论采集脱节。正确做法是：点击缩略图跳到主站时才检测登录态。

### 问题 3: 企微卡片缺少 F5 刷新按钮

QR 码过期但页面还在时，用户只能用"强制刷新"（重新导航），无法简单刷新当前页获取新 QR。

## 设计

### 第一部分: XHS Phase 3 评论采集重写（方案 B）

#### 整体流程

```
Phase 1: 笔记管理页面 → 拦截 API → 收集 20 个笔记 → 对比 DB 评论数
         ↓ 无变化 → 退出
         ↓ 有变化 → 构建 commentsQueue（含 isFirstCrawl 标记）
Phase 2: (删除 — 不再单独开标签页检测登录)
Phase 3: 遍历 commentsQueue:
         → 点击笔记卡片缩略图 → 浏览器自动开新标签页到主站笔记详情
         → 检测登录态（login-modal / #login-btn）
           → 登录失效: 截 QR → 发企微 → 设 login_required + Redis 标记 → 终止队列
           → 登录正常: 拦截评论 API → 滚动加载 → 展开子评论 → 解析评论树 → 存 DB
         → 关闭新标签页 → 回到笔记管理页面 → 处理下一个
```

#### 选择器补全（selectors.json）

CDP 探测确认的实际 DOM 结构：

| 元素 | 选择器 | CDP 验证 |
|------|--------|----------|
| 笔记卡片 | `.note-card` | 21 个匹配 |
| noteId 定位 | `.note-card[data-impression*="{noteId}"]` | `data-impression` 属性含 JSON，noteId 子串匹配 |
| 缩略图 | `.note-card__cover .note-card__media` | 可点击区域 |
| 主站登录检测 | `#login-btn` / `.login-modal` | 未登录时存在，已登录时不存在 |
| QR 码 | `.login-container .qrcode-img` | 在 `.login-modal` 内 |

`selectors.json` 新增：

```json
"region_note_card_by_id": {
  "purposes": ["monitor"],
  "primary": ".note-card[data-impression*=\"{noteId}\"]"
},
"region_note_card_cover": {
  "purposes": ["monitor"],
  "primary": ".note-card__cover .note-card__media"
}
```

#### `xiaohongshuCrawler.ts` 改动

**1. `clickThumbnailAndWaitNewTab` — 修复选择器**

使用 CDP 确认的选择器。`{noteId}` 占位符替换为实际 noteId。点击 `.note-card__cover .note-card__media` 触发浏览器自动开新标签页。

现有代码逻辑（`Promise.all` 监听新标签页 + 点击缩略图）保持不变，仅修复选择器获取。

**2. `processOneNoteComments` — 内联登录检测**

打开新标签页后，立即检测 `#login-btn` / `.login-modal`：
- 登录失效 → 截取 `.login-container .qrcode-img` → 发企微 → 返回 `{ success: false, loginRequired: true }`
- 登录正常 → 继续采集评论树

**3. 删除 `checkMainsiteLogin` 方法**

不再需要独立的登录检查方法。登录检测完全内联到 Phase 3。

**4. `processCommentsQueue` — 处理 loginRequired**

当某个笔记返回 `loginRequired: true` 时：
- 终止队列（不再处理后续笔记）
- 调用方（`runXiaohongshuCheck`）负责设 `login_required` + Redis 标记

**5. 首次初始化逻辑**

`checkForUpdates` 中，笔记在 DB 无 `RootCommentSnapshot` 记录 → 标记 `isFirstCrawl: true` 入队。`processCommentsQueue` 首次爬取全部评论存基线，后续只对比评论数变化。

`XiaohongshuCheckResult` 接口增加 `isFirstCrawl` 字段到 `commentsQueue` 项。

#### `monitorService.ts` 改动

**`runXiaohongshuCheck` 重构：**

- 删除 Phase 0（Redis recheck 独立登录检查）和 Phase 2（独立 `checkMainsiteLogin`）
- Phase 1 后直接进入 Phase 3
- Phase 3 返回 `loginRequired` 时：设 `login_required` + Redis recheck 标记 → 返回
- Redis recheck 恢复后：靠 Phase 1 DB 对比自然跳过已处理笔记

**Redis recheck 恢复流程保留：**

```
登录失效 → login_required + redis.set(xhs:login_recheck:{userId}, '1', EX=86400)
  ↓ 30 分钟后
getAllActiveUsers 自动恢复 → status: 'init' → 重新调度
  ↓
runXiaohongshuCheck 开头检测 redis 标记
  ├─ 有标记 → 正常跑 Phase 1（获取笔记列表 + 对比评论数）
  │   → 如果 Phase 1 有 queue → 进入 Phase 3 → 点击第一个缩略图时内联检测登录态
  │     ├─ 仍失效 → 再设 login_required（不发 QR，避免重复）→ 返回
  │     └─ 已恢复 → 清除标记 → 继续处理 queue
  │   → 如果 Phase 1 无 queue（无评论变化）→ 清除标记，正常退出
  └─ 无标记 → 正常流程
```

注意：recheck 时不再调用独立的 `checkMainsiteLogin`。登录检测完全依赖 Phase 3 点击缩略图打开主站标签页时的内联检测。如果 recheck 时恰好无评论变化（queue 为空），清除标记视为已恢复。

### 第二部分: 企微卡片加"F5刷新QR码"按钮

#### 现状

企微卡片已有两个按钮（`wechatBotService.ts:458-460`）：

```
✅ 已登录，继续监控  →  继续监控 <userId> <platform>
🔄 强制刷新登录页    →  强制刷新 <userId> <platform>
```

#### 改动

**1. 卡片新增第三个按钮**

```
✅ 已登录，继续监控   →  继续监控 <userId> <platform>
🔄 强制刷新登录页     →  强制刷新 <userId> <platform>   (重新导航到登录页)
♻️ F5刷新当前页       →  F5刷新 <userId> <platform>       (刷新已打开的页面，截取新QR)
```

**2. `wechatBotService.ts` — 消息处理新增 `F5刷新` 命令**

匹配 `F5刷新 <userId> <platform>`，执行逻辑：
- 找到该用户平台的浏览器页面
- `page.reload()` 刷新当前页面
- 等待页面加载完成
- 重新截取 QR 码（复用 `captureAndSendQR`）
- 发送新 QR 到企微

**3. `monitorService.ts` — 新增 `refreshQR` 辅助函数**

```typescript
// 刷新已打开的登录页，截取新 QR 码发送到企微
async function refreshQR(userId: number, platform: string): Promise<void>
```

与"强制刷新"的区别：

| | 强制刷新 | F5刷新 |
|---|---|---|
| 导航 | `page.goto(loginUrl)` 重新导航 | `page.reload()` 刷新当前页 |
| 适用场景 | 页面不在登录页或需要重新进入 | 页面已在登录页但 QR 码过期 |
| 后续 | 截 QR → 发企微 | 截 QR → 发企微 |

**4. 所有平台通用**

该按钮对所有平台生效。`refreshQR` 函数是平台无关的——找到该用户平台的活跃页面，reload，截取 QR。`captureAndSendQR` 已有各平台的 QR 选择器配置。

### 第三部分: 数据流与错误处理

#### 错误处理

| 场景 | 处理 |
|------|------|
| 缩略图点击失败（选择器未找到） | 记录 warn，跳过该笔记，继续下一个 |
| 新标签页未打开（超时） | 记录 warn，跳过该笔记，继续下一个 |
| 登录失效 | 截 QR → 发企微 → 设 login_required + Redis 标记 → **终止整个队列** |
| 评论 API 无响应 | 记录 warn，跳过该笔记，继续下一个 |
| 风控检测 | 记录 error → 设 30min cooldown → **终止整个队列** |
| 新标签页关闭失败 | `catch(() => {})` 忽略，不影响后续 |

#### 首次初始化与增量对比

- 笔记在 DB 无 `RootCommentSnapshot` → `isFirstCrawl: true` → 采集全部评论树存基线，保存每条根评论的 `cid + replyCount` 快照
- 已有快照 → `isFirstCrawl: false` → 采集全部评论树，与 DB 快照对比：新根评论直接入库；已有根评论的 `replyCount` 增加 → 标记需展开该根评论的子评论增量
- 评论数不变 → 不入队，不采集

## 涉及文件

| 文件 | 改动 |
|------|------|
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 修复 `clickThumbnailAndWaitNewTab` 选择器；`processOneNoteComments` 内联登录检测；删除 `checkMainsiteLogin`；`processCommentsQueue` 处理 loginRequired；`checkForUpdates` 增加 isFirstCrawl 标记 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 重构 `runXiaohongshuCheck`（删除独立登录检查，Phase 1 → Phase 3 直连）；新增 `refreshQR` 函数；保留 Redis recheck 逻辑 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 卡片 `jump_list` 加第三个按钮；消息处理加 `F5刷新` 命令匹配 |
| `data/selectors.json` | 新增 `region_note_card_by_id`、`region_note_card_cover` |
| `apps/ts-api-gateway/src/crawlers/menuSelectors.ts` | 新增选择器 key 映射：`'region.note-card-by-id': { category: 'regions', name: 'region_note_card_by_id' }`、`'region.note-card-cover': { category: 'regions', name: 'region_note_card_cover' }` |

## 约束

- 不改变其他平台（抖音/快手/视频号）的评论采集方式
- 不改变 Phase 1 笔记列表扫描逻辑（API 拦截 + 对比评论数）
- 复用现有的 `RequestInterceptor`、`HumanActions`、`executeExitStrategy` 等基础设施
- 复用现有的 `captureAndSendQR`、`botManager.sendLoginAlert` 等企微通知基础设施
- Redis recheck 标记 TTL 24h，`login_required` 自动恢复 30min
