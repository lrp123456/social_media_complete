# 操作员-窗口-平台账号 数据模型重构设计规格

**日期**: 2026-06-25
**状态**: 已确认
**范围**: 重构数据库逻辑，建立 `企微用户 1:1 操作员 1:N 窗口 1:N 平台账号` 四层模型，替代当前 users 表（(window+platform) 监控单元）与 OperatorPlatform 表（平台绑操作员层）并行的混乱状态。同步修复多窗口只取第一个、视频 ID 跨平台隔离薄弱、发布脱节等问题。仅做数据模型层统一，发布流程暂不接入平台账号单元。

---

## 1. 背景

### 1.1 当前两套模型并存、粒度错位

- 旧 `User` 表（`@@map("users")`，唯一键 `(fingerprintWindowId, platform)`）是监控/回复的真正执行单元，但与 Operator/Window 域无外键关联，靠 `syncOperatorToMonitorUser` 字符串同步、手工级联清理。
- 新 `Operator`/`BrowserWindow`/`OperatorPlatform`/`LoginVerification` 四表已建，但 `OperatorPlatform` 唯一键 `(operatorId, platform)` 把平台绑在**操作员层**，无法表达"窗口A登抖音、窗口B登快手"。
- `Operator.wechatUserId` 已取消唯一约束（注释"允许同一企微用户创建多个操作员"），与"1企微用户1操作员"矛盾。
- `syncOperatorToMonitorUser`/`verify-login` 都只取 `operator.windows[0]`，多窗口被忽略。

### 1.2 三大功能执行单元不一致

| 功能 | 执行单元 | 依赖表 |
|---|---|---|
| 监控 | `User.id` | User + BrowserWindow 二次过滤 |
| 回复 | `Comment → Video → User` | User |
| 发布 | 前端直传 windowId/accountId/cookies | **不查任何绑定表** |

本次仅统一数据模型层，发布脱节留待后续。

### 1.3 视频 ID 跨平台隔离薄弱

`Video.id` 全局唯一主键，无 `(platform, externalId)` 复合约束。跨平台隔离纯靠 id 格式自然差异（腾讯带 `export/` 前缀、快手多为 base62、抖音纯数字）。抖音纯数字 awemeId 与快手纯数字 photoId 理论上可撞车，`upsert where: { id }` 会串号。部分写入点（`douyinCrawler.ts:331`）未 `String()` 包裹，API 偶发返回 number 时 19 位超 `2^53` 会失精。

### 1.4 isAuthor 判断依赖

"评论是否作者本人"判断为二阶段：`label_type === 1 || userUid === platformAuthorId`，依赖 `User.platformAuthorId`/`platformAuthorName`（由 `syncPlatformAuthorId()` 写入，各爬虫 `db.getUserById()` 读取）。重构不得使其失效。

---

## 2. 根因

数据模型层级与业务层级不匹配：业务上"平台账号"天然属于"窗口"，但代码把平台绑在操作员层（OperatorPlatform），又用 users 表表达"窗口+平台"账号单元，两套表靠字符串同步、手工级联清理，导致多窗口失效、平台无法按窗口分配、isAuthor/登录态/监控状态散落两表。

---

## 3. 设计决策

### 3.1 四层实体模型

```
Operator（操作员 = 企微用户）  1:1   恢复 wechatUserId 唯一约束
   │  1:N
BrowserWindow（指纹窗口）            窗口名 + 下拉绑定操作员（N:1）
   │  1:N
PlatformAccount（平台账号）           替代 users 表，FK 挂窗口，唯一键 (windowId, platform)
   │  1:N
Video → Comment                      Video.userId 引用 PlatformAccount.id
```

### 3.2 删除 OperatorPlatform 表

平台账号本身就是"窗口+平台"单元，`loginStatus`/`lastVerifiedAt` 直接并入 PlatformAccount。删除 OperatorPlatform，消除双数据源与 sync 负担。前端流程：建操作员 → 绑窗口 → 在窗口下加平台账号（顺带验证登录）。

### 3.3 PlatformAccount 字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` | users.id | 主键继承，Video/monitor_status/task_executions 外键值不变 |
| `windowId` (FK→browser_windows) | 新增 | 替代 fingerprintWindowId 字符串，真实 FK |
| `windowExternalId` | 新增冗余 | 调度 key/BullMQ jobId 继续用 externalId 字符串，避免破坏任务队列 |
| `platform` | users.platform | douyin/kuaishou/xiaohongshu/tencent |
| `wechatUserid` | users.wechatUserid | 冗余保留，企微通知/指令路由用，避免每次 join window→operator |
| `status` | users.status | init/active/blocked/cooldown/login_required/risk_control |
| `consecutiveNoUpdate` `cooldownUntil` `monitoringEnabled` | 同名迁移 | 监控调度字段 |
| `platformAuthorId` `platformAuthorName` | users 同名 | **isAuthor 判断依赖，必须迁移** |
| `loginStatus` `lastVerifiedAt` | OperatorPlatform 迁移 | 登录态并入 |
| `skipPinnedVideos` | users 同名 | 跳过置顶配置 |
| 唯一键 | `(windowId, platform)` | 替代旧 `(fingerprintWindowId, platform)` |

### 3.4 迁移策略：一次性迁移 + 继承 id

新建 `platform_accounts` 表，prisma migration 一次性完成表结构 + 数据搬迁 + 外键重映射。**`platform_accounts.id` 继承原 `users.id`**，所有子表外键值不用改数字，只改 FK 约束引用目标，迁移风险大幅降低。

### 3.5 视频 ID 隔离修复

- 新建 `normalizeVideoId(platform, rawId): string` 工具函数，统一 `String()` 包裹 + 按平台清洗，所有 video id 写入点走该函数。
- `Video` 加 `@@unique([userId, id], name: "idx_videos_user_id")` 复合唯一约束兜底防撞车（id 已全局唯一主键，约束为兜底，不破坏现有数据）。

### 3.6 多窗口遍历修复

`syncOperatorToMonitorUser`/`verify-login`/`verify-all` 从只取 `windows[0]` 改为遍历操作员所有绑定窗口，逐窗口 try/catch，单窗口失败不阻塞。

### 3.7 解绑窗口数据保留

解绑窗口/删操作员时：窗口 `boundOperatorId=null`、窗口本身保留；**PlatformAccount 数据保留**（仅停监控），账号数据有价值、误解绑可恢复。仅删除 PlatformAccount 才级联删 Video/Comment。

---

## 4. 改动范围

### 4.1 数据库（prisma/schema.prisma + migration）

1. 新增 `PlatformAccount` 模型（`@@map("platform_accounts")`），字段见 3.3，FK `windowId → browser_windows.id`，`onDelete: Restrict`（解绑不删账号）。
2. `Video.userId` 引用目标从 `users` 改 `platform_accounts`，`onDelete: Cascade`。
3. `Video` 加 `@@unique([userId, id], name: "idx_videos_user_id")`。
4. 删除 `OperatorPlatform` 模型（`@@map("operator_platforms")`）。
5. `Operator.wechatUserId` 恢复 `@unique`。
6. `BrowserWindow` 关系 `platforms` 改指向 PlatformAccount。
7. Migration 含：建 platform_accounts → INSERT...SELECT 搬 users 数据（join browser_windows 解析 windowId）→ 搬 OperatorPlatform 的 loginStatus/lastVerifiedAt → 转移 FK 约束 → 删 users → 删 operator_platforms。

### 4.2 数据访问层（monitorDatabaseService.ts）

- 全表 `prisma.user` → `prisma.platformAccount` 改名，字段名除 `fingerprintWindowId→windowId` 外不变。
- `getAllActiveUsers()` `:378`：二次过滤改用 `windowId` FK join。
- `getUserById()` `:447` → `getPlatformAccountById()`：isAuthor 依赖字段保留。
- `syncPlatformAuthorId()` `:906`：改写 platform_accounts。
- `upsertVideosBatch()` `:30`/`reconcileVideosForUser()` `:177`：video id 经 `normalizeVideoId()` 包裹。
- 其余状态/冷却函数仅改名。

### 4.3 监控调度（monitorService.ts）

- 调度 key `"${windowId}_${platform}"` 与 BullMQ jobId **继续用 externalId 字符串**（PlatformAccount.windowExternalId 冗余字段保证），不破坏现有任务队列。
- `skipPinnedVideos` 读取（`:1055/1210/1354/1577`）、登录态恢复（`:800`）、企微通知查 wechatUserid（`:158/418/477/1029`）：改名读取。

### 4.4 回复链路（routes/matrix.ts、routes/llmReply.ts）

- `Comment.video.userId` Prisma relation 自动跟随改名，代码层 `comment.video.userId` 字段名不变（继承 id 收益）。
- `matrix.ts:987-989/1043-1045` 回复入队、`llmReply.ts:59/152` 查 platform：改名读取。

### 4.5 operators.ts（大幅简化）

- 删除 `syncOperatorToMonitorUser`/`cleanupWindowMonitorData`/删平台绑定的手工级联清理代码（`:67-103/149-177/660-704`），改靠 FK 级联。
- 绑定窗口：按窗口下已有 PlatformAccount 启用监控（PlatformAccount 随窗口归属操作员）。
- 解绑窗口：`boundOperatorId=null`，PlatformAccount 保留。
- `verify-login`/`verify-all`：遍历所有绑定窗口，逐窗口验证平台登录态，单窗口失败不阻塞。
- 登录态恢复（`:818-828/896-903`）：改写 platform_accounts。

### 4.6 wechatBotService.ts

6 处根据 wechatUserid/id 查 → 改名读 platform_accounts，wechatUserid 冗余字段保证路由不变。

### 4.7 前端路由（matrix.ts/accounts.ts/monitor.ts/system.ts）

- `GET /accounts` `:69`、`GET /monitor/accounts` `:640`、`GET /monitor/users` `:708`、`GET /hosted`、`GET /targets`、`GET /overview`：改名读取，返回结构向后兼容。
- `clear`/`restore`/`enable-all`/`toggle`/`skip-pinned`：改名，`platformAuthorId: null` 重置保留。

### 4.8 视频ID隔离（新增）

- 新建 `apps/ts-api-gateway/src/services/videoIdUtils.ts`：`normalizeVideoId(platform, rawId)`。
- 4 个爬虫 video id 写入点统一走该函数。

### 4.9 前端（apps/admin-dashboard）

- 新增"操作员管理"页：CRUD + wechatUserId 唯一校验。
- "用户管理"改名"窗口管理"+改造：列表显示窗口名+供应商+绑定操作员下拉框+平台账号登录态徽标；添加窗口含窗口名+绑定操作员下拉框；窗口详情展示各平台账号监控/登录态/统计；平台账号操作以"窗口+平台"为单元。
- 旧"用户管理"页删除或重定向。

---

## 5. 数据流

```text
操作员管理: 企微用户 → 创建 Operator(wechatUserId 唯一)
窗口管理: 添加窗口(窗口名+绑定操作员下拉) → BrowserWindow.boundOperatorId
  └─ 窗口下加平台账号 → PlatformAccount(windowId FK, platform, loginStatus=unknown)
       └─ 验证登录 → loginStatus=logged_in/not_logged_in + syncPlatformAuthorId
            └─ 监控调度: getAllActiveUsers() 读 platform_accounts
                 status NOT IN (blocked/login_required/risk_control) AND monitoringEnabled
                 调度 key = "${windowExternalId}_${platform}"
            └─ 回复: Comment→Video→PlatformAccount(userId)
            └─ isAuthor: label_type===1 || userUid===platformAuthorId

解绑窗口: boundOperatorId=null, PlatformAccount 保留(停监控)
删 PlatformAccount: 级联 Video→Comment
```

---

## 6. 错误处理与边界

1. **迁移原子性**：建表+搬数据+外键重映射在单一 `$transaction` 内，任一失败整体回滚；迁移前 `pg_dump` 备份 users+operator_platforms。
2. **孤儿 users 行**（fingerprint_window_id 在 browser_windows 找不到）：迁移脚本先列出再人工确认，不静默丢弃、不强制 NULL。
3. **OperatorPlatform → PlatformAccount 登录态迁移**：loginStatus/lastVerifiedAt 取 OperatorPlatform 末值写入对应 (windowId, platform)；无对应记录默认 loginStatus='unknown'。
4. **继承 id 外键完整性**：迁移后校验 videos.user_id、monitor_status.account_id、task_executions.user_id 全部能在 platform_accounts 找到，0 悬空。
5. **isAuthor 不失效**：platformAuthorId/platformAuthorName 原样迁移，syncPlatformAuthorId 改写新表，调用链不变；迁移后抽样校验非空率。
6. **多窗口并发登录验证**：逐窗口 try/catch，单窗口失败不阻塞。
7. **解绑窗口数据保留**：解绑仅 boundOperatorId=null，PlatformAccount 保留。
8. **视频 ID 撞车兜底**：migration 加 (userId, id) 复合唯一约束；现有数据若已撞车，migration 失败——脚本先检测撞车并报告人工处理。
9. **回滚**：还原 pg_dump + 反向 migration（删 platform_accounts、恢复 users/operator_platforms）。

---

## 7. 测试与验证

### 7.1 单元测试

- `videoIdUtils.test.ts`：normalizeVideoId 各平台包裹、null/number 输入、清洗。
- `platform_accounts` 迁移后的 isAuthor 判断链路（保持现有测试不回归）。

### 7.2 迁移校验脚本（迁移后必跑）

```
platform_accounts 行数 == users 迁移前行数（减确认孤儿）
videos.user_id 全部能在 platform_accounts 找到（0 悬空）
monitor_status.account_id 同上
随机抽 5 条评论 → Comment.video.user → platform_accounts.platformAuthorId 非预期丢失
视频 ID 撞车检测：SELECT id, count(DISTINCT userId) FROM videos GROUP BY id HAVING ... >1
```

### 7.3 运行时验证

- 多窗口操作员：验证 login 遍历所有绑定窗口。
- 解绑窗口：确认 PlatformAccount/Video/Comment 保留。
- isAuthor：触发评论采集，确认作者本人评论仍正确标记。
- 视频 ID：抖音+快手同时采集，确认无串号。

### 7.4 静态验证

- 全仓无残留 `prisma.user`、`OperatorPlatform`、`fingerprintWindowId`（除兼容注释）。
- `normalizeVideoId` 覆盖所有 video id 写入点。

---

## 8. 不在范围

- 发布流程接入平台账号单元（仍靠前端传参），留待后续。
- 不改 Phase1/Phase3 评论采集流程逻辑。
- 不采集子评论内容。
- 不调整全局队列调度策略（调度 key 仍用 externalId）。
- 视频号(tencent)三大功能补全不在本次。

---

## 9. 成功标准

1. 四层模型落地：Operator 1:1 企微用户、1:N BrowserWindow、1:N PlatformAccount。
2. `users` 表与 `OperatorPlatform` 表删除，数据全量迁入 `platform_accounts`，0 数据丢失、0 外键悬空。
3. isAuthor 判断不失效，platformAuthorId 迁移后非空率与迁移前一致。
4. 多窗口操作员所有绑定窗口均被验证/调度，不再只取 windows[0]。
5. 解绑窗口保留 PlatformAccount 数据。
6. 视频 ID 跨平台隔离有 (userId, id) 约束兜底 + normalizeVideoId 统一包裹。
7. 前端"操作员管理"+"窗口管理"落地，UI 表达与数据模型一致。
8. 全仓无残留 users/OperatorPlatform/fingerprintWindowId 调用。
9. 监控/回复/企微通知链路回归通过。
