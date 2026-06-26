# 反检测收口与数据库重构融合落地设计规格

**日期**: 2026-06-26
**状态**: 已确认
**范围**: 修复"反检测收口（抖音试点）"与"数据库重构（operator-window-platform）"两个设计合并到 master 后未真正生效的缺口。经核查，两设计后端核心契约真实落地，但"前端可见层 + schema 收尾 + 编译验证"三类项声称落地实则未落地。本 spec 补齐这些缺口，使两个设计在 master 上真正可用。

---

## 1. 背景

### 1.1 两设计已合并 master

- **反检测收口**：`docs/superpowers/specs/2026-06-25-anti-detection-douyin-pilot-design.md`（HumanActions/Interceptor 收口 + 抖音双路径）
- **DB 重构**：`docs/superpowers/specs/2026-06-25-operator-window-platform-db-design.md`（四层模型 + prisma.user→platformAccount 改名）

### 1.2 用户反馈"未生效"

- 前端"正确展示但没有新增操作员选项，新增用户也没有下拉选择操作员的选项"。
- 怀疑"昨天的修改未合并到主分支"。

### 1.3 核查结论：代码已合并，但有三类真实缺口

核查 master 代码 + 运行容器 + 物理库表后确认：**代码都合并了，部署也是最新的**（容器前端 BUILD_ID 为当天，后端跑 tsx 实时转译 + ANTI_DETECTION_MODE=v2）。未生效是"声称落地实则没落地"的缺口，集中在三处。

---

## 2. 核查报告（spec 声明 vs 实际实现）

### 2.1 反检测收口核查

| spec 关键项 | 实际核查 | 判定 |
|---|---|---|
| HumanActions 终态 API（readText/readAttribute/exists/click/fill/press/safeEvaluate） | `humanActions.ts` 全部真实实现，含 recordActionPath | ✅ 真落地 |
| safeEvaluate 隔离世界（CDP createIsolatedWorld + WeakMap 缓存） | `getIsolatedWorldId` 真实实现 | ✅ 真落地 |
| Interceptor 三方法 + 1% 采样 | `interceptor.ts` 全部实现，含 shouldSampleNoFallback | ✅ 真落地 |
| 双路径 ANTI_DETECTION_MODE | `antiDetectionMode.ts` 实现，容器实际跑 v2 | ✅ 真落地 |
| 抖音范围双路径收口 | 43 处 page.evaluate 全在 else(legacy) 分支，v2 走 safeEvaluate，语义正确 | ✅ 真落地 |
| 静态守卫脚本 | guard.sh/audit-blindspots.ts 存在，设计为趋势监控非强制阻断 | ⚠️ 降级（符合过渡策略） |
| 埋点挂载 extra.antiDetection | taskExecutionRecorder.ts 中 grep 无 antiDetection | ❌ 未落地 |
| 前置盲测（Phase 0） | 仅有骨架脚本，无盲测结果 | ❌ 未执行 |
| douyinCrawler 编译通过 | 259 行 tsc 错误（safeEvaluate 返回 unknown 缺断言） | ❌ 未完成 |

### 2.2 DB 重构核查

| spec 关键项 | 实际核查 | 判定 |
|---|---|---|
| 四层模型（Operator/Window/PlatformAccount） | schema 全部建立 | ✅ 真落地 |
| 删除 OperatorPlatform 表 | 物理表已不存在 | ✅ 真落地 |
| 代码改名 prisma.user→platformAccount | 0 处残留，73 处用新名 | ✅ 真落地 |
| 调度key改 ${vendor}:${ext}_${platform} | stateKey() 已实现新格式 | ✅ 真落地 |
| 删 syncOperatorToMonitorUser 手工级联 | operators.ts grep 不到（已删） | ✅ 真落地 |
| normalizeVideoId 集中化 | videoIdUtils.ts + monitorDatabaseService 入口调用 | ✅ 真落地 |
| TaskExecution.userId 加 FK | 物理库 FK task_executions_userId_fkey→platform_accounts 已存在 | ✅ 真落地 |
| 多窗口遍历修复（spec 3.6） | verify-login(行590)/verify-all(行712) 已 `for window of operator.windows` 遍历 | ✅ 真落地 |
| 数据搬迁脚本（Phase 0-3） | 未编写未执行，但 users 表 0 行，平凡满足零丢失 | ⚠️ 无数据可搬 |
| **删除 users 表 + User 模型（spec 4.1）** | User 模型仍在 schema 第17行，users 物理表仍在（0行孤儿） | ❌ 未落地 |
| **前端"操作员管理"+"窗口管理"双页（spec 4.9）** | 只有单一"用户管理"混合组件，方向反（操作员选窗口），无独立新增操作员入口、无窗口侧绑定操作员下拉 | ❌ 未落地 |
| **operators.ts 平台操作迁移到 PlatformAccount（spec 3.2/4.5）** | 7 处 `prisma.operatorPlatform` 调用仍存（行476/484/516/580/633/640/740），OperatorPlatform 表/模型已删、Prisma Client 不含 operatorPlatform → 编译报错且运行时崩溃。添加平台/验证登录/verify-all 等核心流程未迁移到窗口下的 PlatformAccount | ❌ 未落地 |

### 2.3 物理库实际数据量

```
users=0  platform_accounts=0  operators=0  browser_windows=5
videos=0  comments=0  task_executions=0  login_verifications=0
```

系统刚搭好、未真正跑过业务。除 5 个同步窗口外无任何业务数据。

---

## 3. 设计决策

### 3.1 总目标

补齐三类缺口：前端 4.9 双区块重构 + 删 users 孤儿 + 反检测编译清零。多窗口遍历核查通过无需改动。埋点挂载与前置盲测**不在本 spec 范围**（用户后续有独立埋点设计；盲测需真实环境独立排期）。

### 3.2 改动域 1：前端双区块重构（对齐 DB spec 4.9）

把 `OperatorManagement.tsx` 单一混合组件拆成双区块，纠正绑定方向：

- **区块 A「操作员管理」**：纯操作员 CRUD。新增/编辑表单仅含企微ID（必填，带"获取ID"企微机器人按钮）/显示名称（必填）/手机号/角色。**去掉"绑定窗口"字段**。这是独立的"新增操作员"入口。
- **区块 B「窗口管理」**：窗口列表（BitBrowser/RoxyBrowser 分组），每行显示窗口名+供应商，带**「绑定操作员」下拉框**（选项=已建操作员列表），下拉即触发 bindWindow；已绑定窗口显示操作员名+「解绑」按钮；窗口卡片可展开显示该窗口下各平台账号登录态徽标（复用 PlatformRow/LoginBadge）。

绑定方向从"操作员选窗口"纠正为"窗口选操作员"。

### 3.3 改动域 2：删 users 孤儿（对齐 DB spec 4.1）

- 删 `prisma/schema.prisma` 第 17-34 行 `model User { ... }` 整段（已确认无 @relation 引用，完全孤立）。
- 运行 `npx prisma generate`，确认业务代码无 `prisma.user` 类型残留。
- 删物理 `users` 表（0 数据、videos/task_executions 外键已指向 platform_accounts 不指向 users，安全）：`DROP TABLE users;`。
- 后端启动命令已含 `prisma db push --accept-data-loss`，删 User 模型后重启自然同步，不再重建 users 表。

### 3.4 改动域 3：反检测编译清零（`douyinCrawler.ts`）

仅类型修改，不改运行时逻辑。按错误类型分批：

仅修本次两设计涉及文件（operators.ts + douyinCrawler.ts，共 71 个错误）。tencentCrawler/kuaishouCrawler/oss/test 的预存错误（与本次两设计无关）不在范围。仅类型修改，不改运行时逻辑。按错误类型分批：

| 错误类型 | 数量 | 修复模式 |
|---|---|---|
| safeEvaluate 返回 unknown | ~20 | 补 `as ExpectedType`（string/boolean/对象\|null） |
| NodeList 迭代（TS2488） | 6 | `Array.from(nodeList)` 包裹 |
| 空对象 {} 属性访问（TS2339） | ~20 | 函数加返回类型注解 + 调用处 `as Type` + 必要时 `'prop' in obj` 守卫 |
| Element.innerText（TS2339） | 2 | `(el as HTMLElement).innerText` |
| Spread types（TS2698） | 1 | `{ ...(x as Record<string, unknown>) }` |

### 3.5 改动域 4：多窗口遍历——无改动

核查确认 `verify-login`/`verify-all` 已遍历所有窗口（operators.ts 行590/712），spec 3.6 已落地，本域无代码改动。

### 3.5b 改动域 5：operators.ts 平台操作迁移到 PlatformAccount（对齐 DB spec 3.2/4.5/3.9）

**这是最致命的缺口**——`operators.ts` 的平台操作仍停留在已删除的 OperatorPlatform 模型，导致编译报错 + 运行时崩溃。OperatorPlatform 表/模型已删、Prisma Client 不含 `operatorPlatform`，但 7 处调用未迁移。需把这些操作改写为操作"窗口下的 PlatformAccount"，对齐"平台账号属于窗口"的四层模型：

| 行号 | 旧调用（operatorPlatform） | 迁移后（platformAccount） |
|---|---|---|
| 476-478 | `findUnique` 查 (operatorId,platform) 重复 | 改为对操作员所有绑定窗口的 PlatformAccount 查重：`findFirst({ where: { window: { boundOperatorId: id }, platform } })` |
| 484-486 | `create` 建平台绑定 | **添加平台语义变更**：平台账号属窗口，不能凭空加在操作员上。此接口改为：遍历操作员绑定窗口，为每个窗口 `upsert` PlatformAccount(windowId, platform, loginStatus:'unknown')；若无绑定窗口则 400 提示"请先绑定窗口" |
| 516-518 | `delete` 删平台绑定 | 已部分迁移（行509-512 已查 platformAccount），删掉 operatorPlatform.delete，改为直接删 platformAccount（行522已做），去重 |
| 580-583 | `update` loginStatus=checking | 改为 `platformAccount.updateMany({ where: { window: { boundOperatorId: id }, platform }, data: { loginStatus: 'checking' } })` |
| 633-636 | `findUnique` 取上次 loginStatus | 改为 `platformAccount.findFirst({ where: { window: { boundOperatorId: id }, platform }, select: { loginStatus: true } })` |
| 640-643 | `update` 写 loginStatus | 改为 `platformAccount.updateMany({ where: { window: { boundOperatorId: id }, platform }, data: { loginStatus, lastVerifiedAt: new Date() } })` |
| 740-743 | `update`（verify-all） | 改为 `platformAccount.updateMany({ where: { windowId: window.id, platform: plat.platform }, data: { loginStatus, lastVerifiedAt: new Date() } })` |

**连带缺口（LoginVerification）**：行 666-672 `loginVerification.create` 传 `operatorId`，但 schema 已改为 `windowId+platform`（无 operatorId，DB spec 3.9）。需改为在验证窗口循环内、按实际验证的窗口写入：`create({ data: { windowId: window.id, platform, status: loginStatus, detail } })`，移到 for-window 循环体内。

**关键语义**：verify-login 遍历窗口时，每个窗口验证结果应分别写入该窗口的 PlatformAccount 与 LoginVerification（而非操作员级单一状态）。bestResult 取最佳结果用于响应，但持久化按窗口分别记录。

### 3.6 执行顺序与依赖

```
改动域2(删User模型+prisma generate) ─→ 改动域5(operators.ts迁移) ─→ 改动域3(编译清零) ─→ 改动域1(前端) ─→ 端到端验证
```

先 DB（影响 Prisma Client 类型）→ operators.ts 迁移（解 operatorPlatform 编译错误）→ 编译清零（解 douyinCrawler 编译错误）→ 前端（独立）→ 重启容器端到端验证。改动域 5 必须在改动域 3 之前，否则 operators.ts 的编译错误与 douyinCrawler 混在一起难以定位。

---

## 4. 改动范围

### 4.1 前端

- `apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx`：拆双区块，操作员表单去窗口字段，窗口卡片加绑定操作员下拉。
- `apps/admin-dashboard/src/hooks/useApi.ts`：确认 useBindWindow/useUnbindWindow/useOperators 已存在（核查已确认），无需新增。

### 4.2 数据库

- `prisma/schema.prisma`：删第 17-34 行 `model User`。
- 物理库：`DROP TABLE users;`（手动执行）。

### 4.3 后端编译

- `apps/ts-api-gateway/src/routes/operators.ts`：7 处 `prisma.operatorPlatform` 调用迁移到 `prisma.platformAccount`；`loginVerification.create` 改用 windowId+platform（改动域 5）。
- `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`：259 行类型错误修复（改动域 3）。

### 4.4 不改动

- 其余历史表（VideoCommentRecord/Blogger/BGM 等）——DB spec 未规划删除。
- 反检测埋点挂载（extra.antiDetection）——用户后续独立设计。
- 前置盲测——需真实环境独立排期。
- 反检测其余平台 rollout、监控系统 UI——独立 spec。

---

## 5. 数据流

```
操作员管理(区块A): 新增操作员(企微ID+名称) → POST /operators → operators 表
窗口管理(区块B): 窗口卡片选操作员下拉 → POST /windows/:id/bind {operatorId}
                → BrowserWindow.boundOperatorId 更新
  └─ 窗口下加平台账号 → PlatformAccount(windowId, platform)
       └─ 验证登录 → loginStatus + syncPlatformAuthorId
            └─ 监控调度: getAllActiveUsers() 读 platform_accounts
删 users: User 模型移除 + DROP TABLE users → db push 同步 → 服务重启
operators.ts 迁移: operatorPlatform → platformAccount（按窗口） + loginVerification 用 windowId
编译清零: douyinCrawler.ts 类型断言 → tsc --noEmit 0 错误
```

---

## 6. 错误处理与边界

1. **删 users 表无外键阻塞**：核查确认 videos/task_executions 外键已指向 platform_accounts，users 无任何 FK 引用，DROP 安全。
2. **db push 不重建 users**：删 User 模型后，`prisma db push` 不会重建 users（模型已不存在），需 `--accept-data-loss`（启动命令已带）。
3. **前端绑定方向**：bindWindow mutation 入参 `{ windowId, operatorId }`，窗口侧发起，与后端 `POST /windows/:id/bind` 语义一致。
4. **编译修复不改逻辑**：所有改动为类型断言/Array.from 包装，运行时行为与改造前一致。
5. **未真正跑过业务**：物理库仅 5 个窗口无业务数据，端到端验证从零创建操作员开始，无历史数据兼容负担。

---

## 7. 测试与验证

### 7.1 编译验证

- `cd apps/ts-api-gateway && npx tsc --noEmit` → `operators.ts` 与 `douyinCrawler.ts` 零错误（其余预存错误不在范围）。
- `npx prisma generate` → 无 `prisma.user` 类型残留。
- `pnpm build:dashboard` → 通过。

### 7.2 数据库验证

- `DROP TABLE users` 后，`users` 表不存在。
- 重启 sm-ts-api 后服务正常启动，`platform_accounts` 可读写。
- 添加平台账号 → `platform_accounts` 写入正确（windowId/platform/loginStatus）。
- verify-login → `platform_accounts.loginStatus` + `login_verifications`（windowId+platform）正确写入，无 operatorId 残留。

### 7.3 前端验证

- 双区块渲染：操作员管理 + 窗口管理。
- 「新增操作员」表单无窗口字段。
- 窗口卡片有「绑定操作员」下拉，选定后窗口显示操作员名。
- 已绑定窗口有「解绑」按钮。

### 7.4 端到端验证

建操作员 → 绑定 5 个窗口之一 → 加平台账号 → 验证登录 → 确认 platform_accounts 写入、表格有数据。

### 7.5 功能不回归

- `npx jest` 全绿。
- 抖音三功能（发布/监控/回复）链路不回归（编译修复仅类型）。

---

## 8. 不在范围

- 反检测埋点挂载（extra.antiDetection）——用户后续独立埋点设计。
- 前置盲测（Phase 0）——需真实浏览器环境，独立排期。
- 其余历史表清理——DB spec 未规划，后续单独核查。
- 数据搬迁脚本——users 0 行无数据可搬。
- 反检测其余平台 rollout、监控系统 UI、Interceptor 全局注册化——独立 spec。

---

## 9. 成功标准

1. 前端双区块落地：独立「新增操作员」入口 + 窗口侧「绑定操作员」下拉，方向正确。
2. `User` 模型从 schema 删除，物理 `users` 表删除，服务重启不重建。
3. `operators.ts` 无 `prisma.operatorPlatform` 调用残留，平台操作全部走 `prisma.platformAccount`（按窗口），`loginVerification` 用 windowId+platform。
4. `cd apps/ts-api-gateway && npx tsc --noEmit` 在 `operators.ts` 与 `douyinCrawler.ts` 上零错误（其余文件预存错误不在本次范围）。
5. 端到端：建操作员→绑窗口→加平台账号→验证登录→platform_accounts 写入正常、表格有数据、verify-login/verify-all 不崩溃。
6. `npx jest` 全绿，抖音三功能不回归。
7. 业务代码无 `prisma.user` / `prisma.operatorPlatform` 残留。
