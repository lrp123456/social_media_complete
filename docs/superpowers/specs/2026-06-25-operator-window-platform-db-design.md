# 操作员-窗口-平台账号 数据模型重构设计规格

**日期**: 2026-06-25
**状态**: 已确认
**范围**: 重构数据库逻辑，建立 `企微用户 1:1 操作员 1:N 窗口 1:N 平台账号` 四层模型，替代当前 users 表（(window+platform) 监控单元）与 OperatorPlatform 表（平台绑操作员层）并行的混乱状态。同步修复多窗口只取第一个、视频 ID 跨平台隔离薄弱、发布脱节等问题。仅做数据模型层统一，发布流程暂不接入平台账号单元。

---

## 1. 背景

### 1.1 当前两套模型并存、粒度错位

- 旧 `User` 表（`@@map("users")`，唯一键 `(fingerprintWindowId, platform)`）是监控/回复的真正执行单元，但与 Operator/Window 域无外键关联，靠 `syncOperatorToMonitorUser` 字符串同步、手工级联清理。
- 新 `Operator`/`BrowserWindow`/`OperatorPlatform`/`LoginVerification` 四表已建，但 `OperatorPlatform` 唯一键 `(operatorId, platform)` 把平台绑在**操作员层**，无法表达"窗口A登抖音、窗口B登快手"。
- `Operator.wechatUserId` 当前 schema 仍有 `@unique` 约束（代码注释"允许同一企微用户创建多个操作员"与 schema 矛盾），需确认实际意图并统一。
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
| `windowExternalId` | 新增冗余 | 调度 key/BullMQ jobId 继续用 externalId 字符串，避免破坏任务队列。**注意**：BrowserWindow 唯一键是 `(externalId, browserVendor)`，纯 externalId 跨厂商可能重复，调度 key 改为 `"${browserVendor}:${windowExternalId}_${platform}"` 保证全局唯一 |
| `platform` | users.platform | douyin/kuaishou/xiaohongshu/tencent |
| `wechatUserid` | users.wechatUserid | 冗余保留，企微通知/指令路由用，避免每次 join window→operator |
| `status` | users.status | init/active/blocked/cooldown/login_required/risk_control |
| `consecutiveNoUpdate` `cooldownUntil` `monitoringEnabled` | 同名迁移 | 监控调度字段 |
| `platformAuthorId` `platformAuthorName` | users 同名 | **isAuthor 判断依赖，必须迁移** |
| `loginStatus` `lastVerifiedAt` | OperatorPlatform 迁移 | 登录态并入 |
| `skipPinnedVideos` | users 同名 | 跳过置顶配置 |
| 唯一键 | `(windowId, platform)` | 替代旧 `(fingerprintWindowId, platform)` |

### 3.4 迁移策略：一次性脚本 + 分阶段执行

新建 `platform_accounts` 表，单个迁移脚本内分阶段执行（非 Prisma interactive transaction，因为需执行 raw DDL）。**`platform_accounts.id` 继承原 `users.id`**，所有子表外键值不用改数字，只改 FK 约束引用目标，迁移风险大幅降低。

**脚本结构**（顺序执行，任一阶段失败则中止并报告）：

```
Phase 0: 预检（只读，不改数据）
├── 检测 wechatUserId 重复 → 若有重复则中止并报告
├── 检测 OperatorPlatform 多 operator 同 (windowId, platform) 冲突 → 报告
├── 检测 videos.id 撞车（同 id 不同 userId）→ 报告
├── 检测孤儿 users 行（fingerprint_window_id 在 browser_windows 找不到）→ 报告
├── 统计 users 行数、platformAuthorId 非空率 → 记录基线
└── 任一检测发现问题 → 中止，人工确认后重跑

Phase 1: 建表 + 数据搬迁（每批 1000 行独立事务，可中断恢复）
├── CREATE TABLE platform_accounts（raw DDL，Prisma migration push）
├── 分批 INSERT INTO platform_accounts ... SELECT FROM users（join browser_windows 解析 windowId）
├── 搬 OperatorPlatform 的 loginStatus/lastVerifiedAt（按 (operatorId→windowId, platform) 映射）
├── setval('platform_accounts_id_seq', max(id)) ← 防止自增序列冲突
└── 每批事务独立，失败可从断点续跑

Phase 2: FK 重映射（独立 DDL 语句）
├── ALTER TABLE videos DROP CONSTRAINT ... → ADD CONSTRAINT ... REFERENCES platform_accounts(id)
├── ALTER TABLE task_executions ADD CONSTRAINT ... REFERENCES platform_accounts(id)（新增 FK）
├── ALTER TABLE monitor_status.account_id 确认 String(id) 兼容（类型不变，无需改）
├── LoginVerification 迁移：新增 windowId + platform 字段，通过 operatorId→operator→window 映射填充
├── 删除 OperatorPlatform 表
└── 删除 users 表

Phase 3: 后验证（只读）
├── platform_accounts 行数 == Phase 0 记录的 users 行数（减确认孤儿）
├── videos.user_id 0 悬空
├── task_executions.user_id 0 悬空
├── platformAuthorId 非空率与 Phase 0 基线差值 < 1%
├── 视频 ID 撞车检测：SELECT id, count(DISTINCT userId) FROM videos GROUP BY id HAVING count > 1
└── 全部通过 → 迁移完成；任一失败 → 回滚（还原 pg_dump）
```

**关键约束**：
- Phase 1 开始前暂停 API 写入服务（或设置维护模式标记），防止迁移期间产生新数据导致不一致
- Phase 0 的预检脚本可独立多次运行，确认无问题后再执行 Phase 1-3

### 3.5 视频 ID 隔离修复

- 新建 `normalizeVideoId(platform, rawId): string` 工具函数，统一 `String()` 包裹 + 按平台清洗，所有 video id 写入点走该函数。
- `Video` 加 `@@unique([userId, id], name: "idx_videos_user_id")` 复合唯一约束兜底防撞车（id 已全局唯一主键，约束为兜底，不破坏现有数据）。

### 3.6 多窗口遍历修复

`syncOperatorToMonitorUser`/`verify-login`/`verify-all` 从只取 `windows[0]` 改为遍历操作员所有绑定窗口，逐窗口 try/catch，单窗口失败不阻塞。

### 3.7 解绑窗口数据保留

解绑窗口/删操作员时：窗口 `boundOperatorId=null`、窗口本身保留；**PlatformAccount 数据保留**（仅停监控），账号数据有价值、误解绑可恢复。仅删除 PlatformAccount 才级联删 Video/Comment。

### 3.8 BrowserWindow 删除前置逻辑

`PlatformAccount.windowId` 使用 `onDelete: Restrict`，阻止直接删除有关联账号的窗口。删除 BrowserWindow 的前置流程：
1. 检查窗口下是否有 PlatformAccount → 若有则拒绝删除，提示"请先删除或迁移该窗口下的平台账号"
2. 若无关联账号，正常删除
3. 软删除场景：给 BrowserWindow 加 `deletedAt` 字段（可选，不在本次范围，后续按需）

### 3.9 LoginVerification 表处理

当前 `LoginVerification` 模型有 `operatorId` + `platform` 但无 FK 约束、无 `windowId`。删除 `OperatorPlatform` 后此表失去参照完整性。处理方案：
- LoginVerification 新增 `windowId` (FK→browser_windows) + 保留 `platform`
- 迁移脚本通过 `operatorId → operator.windows` 映射填充 `windowId`
- 删除 `operatorId` 字段（不再需要，登录验证以窗口+平台为单元）
- 唯一索引改为 `@@index([windowId, platform])`

### 3.10 TaskExecution.userId 添加 FK 约束

当前 `TaskExecution.userId` 是裸 `Int?` 无 FK 约束。趁此次迁移补上：
- 添加 `@relation("PlatformAccountTaskExecutions", fields: [userId], references: [id], onDelete: SetNull)`
- 迁移前先校验现有数据：`SELECT userId FROM task_executions WHERE userId IS NOT NULL AND userId NOT IN (SELECT id FROM users)` → 若有悬空则先清理

---

## 4. 改动范围

### 4.1 数据库（prisma/schema.prisma + migration）

1. 新增 `PlatformAccount` 模型（`@@map("platform_accounts")`），字段见 3.3，FK `windowId → browser_windows.id`，`onDelete: Restrict`（解绑不删账号）。
2. `Video.userId` 引用目标从 `users` 改 `platform_accounts`，`onDelete: Cascade`。
3. `Video` 加 `@@unique([userId, id], name: "idx_videos_user_id")`。
4. 删除 `OperatorPlatform` 模型（`@@map("operator_platforms")`）。
5. `Operator.wechatUserId` 保持 `@unique`（当前已有）。
6. `BrowserWindow` 关系 `platforms` 改指向 PlatformAccount。
7. `TaskExecution.userId` 添加 FK 约束：`@relation(fields: [userId], references: [id], onDelete: SetNull)`。
8. `LoginVerification` 重构：删除 `operatorId`，新增 `windowId` (FK→browser_windows)，唯一索引改为 `@@index([windowId, platform])`。
9. Migration 含：预检（Phase 0）→ 建 platform_accounts（Phase 1）→ 分批 INSERT...SELECT 搬 users 数据（join browser_windows 解析 windowId）→ 搬 OperatorPlatform 的 loginStatus/lastVerifiedAt → setval 自增序列 → FK 重映射（Phase 2）→ 后验证（Phase 3）→ 删 users → 删 operator_platforms。

### 4.2 数据访问层（monitorDatabaseService.ts）

- 全表 `prisma.user` → `prisma.platformAccount` 改名，字段名除 `fingerprintWindowId→windowId` 外不变。
- `getAllActiveUsers()` `:378`：二次过滤改用 `windowId` FK join。
- `getUserById()` `:447` → `getPlatformAccountById()`：isAuthor 依赖字段保留。
- `syncPlatformAuthorId()` `:906`：改写 platform_accounts。
- `upsertVideosBatch()` `:30`/`reconcileVideosForUser()` `:177`：video id 经 `normalizeVideoId()` 包裹。**集中化策略**：`normalizeVideoId` 在数据库服务层统一调用（`upsertVideosBatch`/`reconcileVideosForUser` 入口处），各爬虫无需单独调用。
- `updateVideoCommentCount()` `:76`：`where: { id, userId }` 中 userId 字段名不变，FK 目标改后需重新生成 Prisma Client。
- 其余状态/冷却函数仅改名。

### 4.3 监控调度（monitorService.ts）

- 调度 key 改为 `"${browserVendor}:${windowExternalId}_${platform}"`（BrowserWindow 唯一键是 `(externalId, browserVendor)`，纯 externalId 跨厂商可能重复）。BullMQ jobId 同步更新格式，**需在 Redis 中迁移存量 delayed/waiting 任务的 key**（或在迁移脚本中清空旧任务队列重新调度）。
- `skipPinnedVideos` 读取（`:1055/1210/1354/1577`）、登录态恢复（`:800`）、企微通知查 wechatUserid（`:158/418/477/1029`）：改名读取。

### 4.4 回复链路（routes/matrix.ts、routes/llmReply.ts）

- `Comment.video.userId` Prisma relation 自动跟随改名，代码层 `comment.video.userId` 字段名不变（继承 id 收益）。
- `matrix.ts:987-989/1043-1045` 回复入队、`llmReply.ts:59/152` 查 platform：改名读取。

### 4.5 operators.ts（大幅简化）

- 删除 `syncOperatorToMonitorUser`/`cleanupWindowMonitorData`/删平台绑定的手工级联清理代码（`:67-103/149-177/660-704`），改靠 FK 级联。
- 绑定窗口：按窗口下已有 PlatformAccount 启用监控（PlatformAccount 随窗口归属操作员）。
- 解绑窗口：`boundOperatorId=null`，PlatformAccount 保留。**停监控逻辑**：遍历窗口下所有 PlatformAccount，设置 `monitoringEnabled=false`，并取消对应的 BullMQ 延迟任务（`removeJob` by jobId pattern `${browserVendor}:${windowExternalId}_${platform}`）。
- `verify-login`/`verify-all`：遍历所有绑定窗口，逐窗口验证平台登录态，单窗口失败不阻塞。
- 登录态恢复（`:818-828/896-903`）：改写 platform_accounts。
- `POST /windows/:id/bind`：使用 `updateMany({ where: { id, boundOperatorId: null }, data: {...} })` 判断 affected rows 防止并发覆盖竞态。

### 4.6 wechatBotService.ts + Operator wechatUserid 级联更新

- 6 处根据 wechatUserid/id 查 → 改名读 platform_accounts，wechatUserid 冗余字段保证路由不变。
- **级联更新**：Operator 的 `wechatUserId` 变更时（管理员修改），需同步更新所有关联 PlatformAccount 的 `wechatUserid` 字段。在 `operators.ts` 的 update 路由中加 `prisma.platformAccount.updateMany({ where: { window: { boundOperatorId: id } }, data: { wechatUserid: newWechatUserId } })`。
- **迁移兼容**：BullMQ 持久化任务中可能携带旧的 `fingerprintWindowId` 字段，迁移后该字段变为冗余但不影响执行（id 值不变），保留以确保向后兼容。

### 4.7 前端 API 路由（matrix.ts/accounts.ts/monitor.ts/system.ts）

- `GET /accounts` `:69`、`GET /monitor/accounts` `:640`、`GET /monitor/users` `:708`、`GET /hosted`、`GET /targets`、`GET /overview`：改名读取，返回结构向后兼容（`windowId` 字段返回 `windowExternalId` 保持兼容）。
- `clear`/`restore`/`enable-all`/`toggle`/`skip-pinned`：改名，`platformAuthorId: null` 重置保留。
- `routes/system.ts`：`prisma.user.count()` → `prisma.platformAccount.count()`。
- `routes/accounts.ts`：2 处 `prisma.user` 调用改名。
- `routes/llmReply.ts`：2 处 `prisma.user.findUnique` 改名。

### 4.8 视频ID隔离（新增）

- 新建 `apps/ts-api-gateway/src/services/videoIdUtils.ts`：`normalizeVideoId(platform, rawId)`。
- **集中化调用**：在 `monitorDatabaseService.ts` 的 `upsertVideosBatch()` 和 `reconcileVideosForUser()` 入口处统一调用 `normalizeVideoId`，各爬虫无需单独修改（爬虫传入原始 id，数据库服务层统一清洗）。
- 覆盖范围：所有 `Video` 写入路径（`upsertVideosBatch`、`reconcileVideosForUser`、以及直接 upsert 的代码路径）。

### 4.9 前端（apps/admin-dashboard）

- 新增"操作员管理"页：CRUD + wechatUserId 唯一校验。
- "用户管理"改名"窗口管理"+改造：列表显示窗口名+供应商+绑定操作员下拉框+平台账号登录态徽标；添加窗口含窗口名+绑定操作员下拉框；窗口详情展示各平台账号监控/登录态/统计；平台账号操作以"窗口+平台"为单元。
- 旧"用户管理"页删除或重定向。
- 类型定义更新：`fingerprintWindowId` → `windowId`/`windowExternalId`（`useApi.ts` 及相关类型文件）。

### 4.10 爬虫及其他受影响文件

以下文件含 `prisma.user` 或 `fingerprintWindowId` 引用，需同步改名：

| 文件 | 改动点 |
|------|--------|
| `crawlers/douyinCrawler.ts` | `prisma.user` 调用 + video id 写入（已由 4.8 集中化处理） |
| `crawlers/kuaishouCrawler.ts` | `prisma.user` + `fingerprintWindowId` 引用 |
| `crawlers/xiaohongshuCrawler.ts` | `prisma.user` + `fingerprintWindowId` 引用 |
| `crawlers/tencentCrawler.ts` | `prisma.user` + `fingerprintWindowId` 引用 |
| `platforms/tencent.ts` | `prisma.user` 调用 |
| `services/unifiedQueue.ts` | `MonitorTask` 接口中 `fingerprintWindowId` 字段改名 |
| `lib/taskExecutionRecorder.test.ts` | 测试数据中 `fingerprintWindowId` 引用 |
| `routes/monitor.ts` | 2 处 `prisma.user` + `fingerprintWindowId` |

**Prisma Client 重新生成后，所有引用 `prisma.user` 的 TypeScript 代码将编译失败**（~76 处），必须全部改名后才能构建。这是构建时阻断，非运行时问题。

---

## 5. 数据流

```text
操作员管理: 企微用户 → 创建 Operator(wechatUserId 唯一)
窗口管理: 添加窗口(窗口名+绑定操作员下拉) → BrowserWindow.boundOperatorId
  └─ 窗口下加平台账号 → PlatformAccount(windowId FK, platform, loginStatus=unknown)
       └─ 验证登录 → loginStatus=logged_in/not_logged_in + syncPlatformAuthorId
            └─ 监控调度: getAllActiveUsers() 读 platform_accounts
                 status NOT IN (blocked/login_required/risk_control) AND monitoringEnabled
                 调度 key = "${browserVendor}:${windowExternalId}_${platform}"
            └─ 回复: Comment→Video→PlatformAccount(userId)
            └─ isAuthor: label_type===1 || userUid===platformAuthorId

解绑窗口: boundOperatorId=null, PlatformAccount 保留(停监控+取消BullMQ任务)
删 BrowserWindow: 前置检查无PlatformAccount关联才允许删除
删 PlatformAccount: 级联 Video→Comment
Operator.wechatUserId 变更: 级联更新所有关联PlatformAccount.wechatUserid
```

---

## 6. 错误处理与边界

### 6.1 迁移原子性（分阶段，非单一事务）

迁移使用独立原始 SQL 脚本（非 Prisma interactive transaction，因需执行 DDL）。分 4 个 Phase 顺序执行（详见 3.4）：
- **Phase 0 预检**：只读，可多次运行，确认无阻塞问题
- **Phase 1 建表+搬数据**：每批 1000 行独立事务，失败可从断点续跑（记录最后成功 id）
- **Phase 2 FK 重映射**：独立 DDL 语句，PostgreSQL 支持事务内 DDL
- **Phase 3 后验证**：只读，校验完整性
- **迁移前**：`pg_dump` 备份 `users` + `operator_platforms` + `login_verifications` + `videos` + `task_executions`
- **迁移期间**：暂停 API 写入服务（或设置维护模式标记），防止新数据导致不一致

### 6.2 预检项（Phase 0，必须全部通过）

| 预检项 | SQL / 检查逻辑 | 失败处理 |
|--------|----------------|----------|
| wechatUserId 重复 | `SELECT wechat_user_id, count(*) FROM operators GROUP BY wechat_user_id HAVING count > 1` | 中止，人工合并重复 operator（将重复的窗口迁移到主 operator 下） |
| OperatorPlatform 冲突 | 检测多 operator 同一 (windowId, platform) 的登录态 | 中止，人工指定保留哪条（或取最新 updated） |
| 视频 ID 撞车 | `SELECT id, count(DISTINCT user_id) FROM videos GROUP BY id HAVING count(DISTINCT user_id) > 1` | 中止，人工处理撞车记录（加平台前缀重命名） |
| 孤儿 users 行 | `SELECT * FROM users WHERE fingerprint_window_id NOT IN (SELECT external_id FROM browser_windows)` | 列出孤儿行，人工确认：映射到默认窗口 / 创建新窗口 / 丢弃 |
| TaskExecution 悬空 | `SELECT user_id FROM task_executions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)` | 清理悬空记录（设为 NULL） |
| 基线统计 | 记录 users 行数、platformAuthorId 非空率 | 用于 Phase 3 对比 |

### 6.3 OperatorPlatform → PlatformAccount 登录态迁移

- loginStatus/lastVerifiedAt 取 OperatorPlatform 末值写入对应 (windowId, platform)
- 通过 `operatorId → operator.windows` 映射确定 windowId
- 多 operator 同 (windowId, platform) 时取最新 `updatedAt` 的记录
- 无对应记录默认 `loginStatus='unknown'`

### 6.4 继承 id 外键完整性

- 迁移后校验 `videos.user_id`、`monitor_status.account_id`、`task_executions.user_id` 全部能在 `platform_accounts` 找到，0 悬空
- **自增序列一致性**：Phase 1 末尾执行 `SELECT setval('platform_accounts_id_seq', (SELECT max(id) FROM platform_accounts))`，防止新行插入时 duplicate key

### 6.5 isAuthor 不失效

- `platformAuthorId`/`platformAuthorName` 原样迁移，`syncPlatformAuthorId` 改写新表，调用链不变
- 迁移后校验：`platformAuthorId` 非空率与 Phase 0 基线差值 < 1%

### 6.6 多窗口并发

- 多窗口登录验证：逐窗口 try/catch，单窗口失败不阻塞
- 窗口绑定竞态：`POST /windows/:id/bind` 使用 `updateMany({ where: { id, boundOperatorId: null } })` 判断 affected rows

### 6.7 解绑窗口数据保留

- 解绑仅 `boundOperatorId=null`，PlatformAccount 保留
- 同时设置 `monitoringEnabled=false` 并取消 BullMQ 延迟任务

### 6.8 BrowserWindow 删除限制

- `PlatformAccount.windowId` 使用 `onDelete: Restrict`，阻止删除有关联账号的窗口
- 删除 BrowserWindow 前置检查：若窗口下有 PlatformAccount 则拒绝删除，提示先清理

### 6.9 LoginVerification 迁移

- 新增 `windowId` 字段，通过 `operatorId → operator.windows` 映射填充
- 删除 `operatorId` 字段
- 唯一索引改为 `@@index([windowId, platform])`

### 6.10 视频 ID 撞车兜底

- Migration 加 `(userId, id)` 复合唯一约束
- Phase 0 已检测撞车，若 Phase 2 创建唯一索引失败 → 回滚（还原 pg_dump）

### 6.11 调度 key 安全性

- BrowserWindow 唯一键是 `(externalId, browserVendor)`，纯 `externalId` 跨厂商可能重复
- 调度 key 改为 `"${browserVendor}:${windowExternalId}_${platform}"` 保证全局唯一
- BullMQ 存量任务：迁移脚本中清空旧任务队列（或 Redis key 迁移），服务重启后自动重新调度

### 6.12 回滚方案

- **回滚触发条件**：Phase 3 后验证任一校验失败
- **回滚执行**：还原 `pg_dump`（`pg_restore`）+ 反向 migration（删 `platform_accounts`、恢复 `users`/`operator_platforms`）
- **回滚后校验**：确认 `users` 行数与备份一致、监控/回复链路正常
- **RTO**：预计 `pg_restore` 耗时与数据量成正比，需在维护窗口内完成

---

## 7. 测试与验证

### 7.1 单元测试

- `videoIdUtils.test.ts`：normalizeVideoId 各平台包裹、null/number 输入、清洗。
- `platform_accounts` 迁移后的 isAuthor 判断链路（保持现有测试不回归）。

### 7.2 迁移校验脚本（Phase 3，迁移后必跑）

```
平台账号行数一致性:
  platform_accounts 行数 == Phase 0 记录的 users 行数（减确认孤儿）

外键完整性:
  SELECT count(*) FROM videos WHERE user_id NOT IN (SELECT id FROM platform_accounts) → 0
  SELECT count(*) FROM monitor_status WHERE account_id NOT IN (SELECT id FROM platform_accounts) → 0
  SELECT count(*) FROM task_executions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM platform_accounts) → 0

isAuthor 字段完整性:
  迁移后 platformAuthorId 非空率与 Phase 0 基线差值 < 1%

视频 ID 撞车检测:
  SELECT id, count(DISTINCT userId) FROM videos GROUP BY id HAVING count(DISTINCT userId) > 1 → 0 行

自增序列正确性:
  SELECT nextval('platform_accounts_id_seq') > (SELECT max(id) FROM platform_accounts) → true

LoginVerification 迁移:
  SELECT count(*) FROM login_verifications WHERE window_id IS NULL → 0（全部已映射）

静态检查:
  grep -r "prisma\.user" apps/ --include="*.ts" → 0 匹配（除注释外）
  grep -r "fingerprintWindowId" apps/ --include="*.ts" → 0 匹配（除注释外）
  grep -r "OperatorPlatform" apps/ --include="*.ts" → 0 匹配（除注释外）
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
- 不调整全局队列调度策略（但调度 key 格式从 `${windowExternalId}_${platform}` 改为 `${browserVendor}:${windowExternalId}_${platform}` 以保证跨厂商唯一）。
- 视频号(tencent)三大功能补全不在本次。
- BrowserWindow 软删除（`deletedAt` 字段）不在本次，后续按需。
- 前端 localStorage/IndexedDB 缓存清理不在本次，但需注意迁移后可能的渲染异常。

---

## 9. 成功标准

1. 四层模型落地：Operator 1:1 企微用户、1:N BrowserWindow、1:N PlatformAccount。
2. `users` 表与 `OperatorPlatform` 表删除，数据全量迁入 `platform_accounts`，0 数据丢失、0 外键悬空。
3. isAuthor 判断不失效，platformAuthorId 迁移后非空率与迁移前差值 < 1%。
4. 多窗口操作员所有绑定窗口均被验证/调度，不再只取 windows[0]。
5. 解绑窗口保留 PlatformAccount 数据 + 停监控 + 取消 BullMQ 任务。
6. 视频 ID 跨平台隔离有 (userId, id) 约束兜底 + normalizeVideoId 统一包裹。
7. 前端"操作员管理"+"窗口管理"落地，UI 表达与数据模型一致。
8. 全仓无残留 users/OperatorPlatform/fingerprintWindowId 调用。
9. 监控/回复/企微通知链路回归通过。
10. LoginVerification 以 windowId+platform 为索引，无 operatorId 残留。
11. TaskExecution.userId 有 FK 约束，0 悬空。
12. 调度 key 使用 `${browserVendor}:${windowExternalId}_${platform}` 格式，跨厂商唯一。
13. Operator wechatUserId 变更时级联更新所有关联 PlatformAccount。
14. BrowserWindow 删除受 Restrict 保护，有关联 PlatformAccount 时拒绝删除。
