# 视频流程节点监控与维护调试系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为三大视频流程（发布/监控/评论回复）构建企业级流程节点健康监控与维护调试系统，实现精细化健康监控、快捷修复重试、Debug 快照、配置快照回滚与导出导入。

**Architecture:** 方案A（探针织入）。在 `browser-core` 新增 `MaintenanceProbe`（健康探针）+ `PageProxy`（旁路报警器）+ `HumanActions`/`RequestInterceptor` 扩展方法，探针数据经 Redis list 异步传输到 `MaintenanceCollector`（API Gateway 进程）批量落库；新增 6 张 Prisma 表存储执行/步骤/选择器/URL/快照/配置数据；新增 `/api/v1/maintenance/*` REST API 与 admin-dashboard `/maintenance` 页面。新表 `maintenance_selector_record` **替代**现有 `TaskExecutionStep.selectorTries` 字段。抖音作为样板平台完整接入，其他平台经 PageProxy 旁路兜底。

**Tech Stack:** TypeScript、pnpm monorepo、Prisma 6、PostgreSQL、Redis (ioredis)、Playwright/CDP (browser-core)、Next.js App Router (admin-dashboard)、Express (ts-api-gateway)、Jest + ts-jest (测试)。

**Spec 依据:** `docs/superpowers/specs/2026-06-26-maintenance-debug-system-design.md` v1.2。

---

## 关键代码现状（执行前必读）

| 事实 | 位置 | 对计划的影响 |
|------|------|------------|
| `HumanActions` 是静态方法类，无降级封装 | `packages/browser-core/src/humanActions.ts:63` | `clickWithFallback`/`findInScope` 为新增静态方法 |
| `RequestInterceptor` 现有方法：`register`/`setValidationConfig`/`getRejectionLog`/`clearRejectionLog`/`getResponses`/`getResponseCount`/`storeResponse`/`waitForResponse`/`unregister`/`unregisterAll`/`clear`/`clearAll`；模块级函数 `extractItems` 也已存在 | `packages/browser-core/src/interceptor.ts:226` | **真正新增仅 `attachByConfig`/`hotReloadRules`**；`extractItems`/`waitForResponse` 已存在，复用即可。spec 的"新增 extractItems/waitForNext"是偏差 |
| **方法名修正**：spec 写 `waitForNext`，实际为 `waitForResponse(pattern, timeout)`（`interceptor.ts:613`）；`extractItems` 是模块级函数（`:67`），非类方法 | `interceptor.ts:67,613` | 计划沿用现有名，不另造 |
| `selectorTries` 仅在 **debug 模式** 写入，3 个爬虫调用 `recordSelectorTry` | `lib/taskExecutionRecorder.ts:67-106`；调用点 `douyinCrawler.ts:4136`/`kuaishouCrawler.ts:2475`/`tencentCrawler.ts:2646` | 替代迁移必须保留"非 debug 模式不写明细"语义，否则性能约束破坏 |
| `TaskExecution` 已有 `userId`/`isDebugMode`/`windowId`/`taskType`/`platform` | `prisma/schema.prisma:383` | `MaintenanceExecution` 关联复用，不重复字段 |
| `selectors.json` 旧结构：`platforms.douyin.{menus,buttons,regions,textboxes,flowRules,apiPatterns,dataSources,...}` | `apps/ts-api-gateway/data/selectors.json` | 迁移期保留旧结构，新增字段为可选；`apiMonitors` 顶级键与 `apiPatterns` 并存 |
| `SelectorReader` 是现有读取类（无 `SelectorRegistry`） | `packages/browser-core/src/selectorConfig.ts:236` | `SelectorRegistry` 为新增封装层，内部委托 `SelectorReader` |
| browser-core 测试经 ts-api-gateway jest 运行 | `apps/ts-api-gateway/jest.config.js:3` | 测试命令：`pnpm --filter ts-api-gateway test`，可加路径缩窄 |
| admin-dashboard 是 Next.js App Router | `apps/admin-dashboard/src/app/*/page.tsx` | 新页面为 `src/app/maintenance/page.tsx` |
| API 信封：`{ success: true, data: ... }` 被前端自动解包 | `apps/admin-dashboard/src/lib/api.ts:26` | 后端 maintenance 路由统一用此信封 |

---

## 文件结构

### 新建文件

| 路径 | 职责 |
|------|------|
| `packages/browser-core/src/maintenanceProbe.ts` | `MaintenanceProbe`：AsyncLocalStorage 上下文 + 探针事件收集 + Redis 推送 |
| `packages/browser-core/src/pageProxy.ts` | `PageProxy`：apply 拦截器，捕获旁路 page 调用 |
| `packages/browser-core/src/selectorRegistry.ts` | `SelectorRegistry`：新命名空间 `platform.flow.key` 的注册/读取，委托 `SelectorReader` |
| `packages/browser-core/src/snapshotSanitizer.ts` | `sanitizeSnapshot`：令牌清洗 |
| `packages/browser-core/src/__tests__/maintenanceProbe.test.ts` | 探针测试 |
| `packages/browser-core/src/__tests__/pageProxy.test.ts` | 旁路代理测试 |
| `packages/browser-core/src/__tests__/selectorRegistry.test.ts` | 注册中心测试 |
| `packages/browser-core/src/__tests__/snapshotSanitizer.test.ts` | 清洗测试 |
| `apps/ts-api-gateway/src/services/maintenanceCollector.ts` | `MaintenanceCollector`：Redis BRPOP 消费 + 批量 flush + 健康汇总 |
| `apps/ts-api-gateway/src/services/maintenanceCollector.test.ts` | 收集器测试 |
| `apps/ts-api-gateway/src/services/configSnapshotService.ts` | 配置快照 CAS 回滚/导出/导入 |
| `apps/ts-api-gateway/src/services/configSnapshotService.test.ts` | 快照服务测试 |
| `apps/ts-api-gateway/src/routes/maintenance.ts` | `/api/v1/maintenance/*` 路由 |
| `apps/ts-api-gateway/src/routes/maintenance.test.ts` | 路由测试 |
| `apps/admin-dashboard/src/app/maintenance/page.tsx` | 维护页主入口（Tab 容器） |
| `apps/admin-dashboard/src/app/maintenance/ExecutionHealthTab.tsx` | 执行健康 Tab |
| `apps/admin-dashboard/src/app/maintenance/ExecutionDetailTab.tsx` | 执行详情 Tab |
| `apps/admin-dashboard/src/app/maintenance/SelectorHealthTab.tsx` | 选择器健康 Tab |
| `apps/admin-dashboard/src/app/maintenance/ConfigSnapshotTab.tsx` | 配置管理 Tab |
| `apps/admin-dashboard/src/app/maintenance/components.tsx` | 共享 UI 组件（健康徽章、树形展开） |

### 修改文件

| 路径 | 修改 |
|------|------|
| `packages/browser-core/src/humanActions.ts` | 新增 `clickWithFallback`/`findInScope` 静态方法，内部调 `MaintenanceProbe.recordSelectorOp` |
| `packages/browser-core/src/interceptor.ts` | 新增 `attachByConfig`/`hotReloadRules`（`extractItems`/`waitForResponse` 已存在，复用）；`storeResponse`/validation 失败处调 `MaintenanceProbe.recordUrlIntercept`（透传 `pageKey`/`commentId`） |
| `packages/browser-core/src/browserManager.ts` | `connect()` 内 `newPage()` 后包 `PageProxy.createProxiedPage` |
| `packages/browser-core/src/index.ts` | 导出 `MaintenanceProbe`/`PageProxy`/`SelectorRegistry` |
| `prisma/schema.prisma` | 新增 6 个 model；`MaintenanceStep` 加 `taskStepId` |
| `apps/ts-api-gateway/src/index.ts`（或 app 入口） | 启动 `MaintenanceCollector.startConsuming()` |
| `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts` | `recordSelectorTry` 改为委托 `MaintenanceProbe`（替代直接写 `selectorTries`） |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 子步骤入口加 `MaintenanceProbe.enterStep`/`exitStep`；选择器调用迁至 `clickWithFallback` |
| `apps/ts-api-gateway/src/index.ts` 路由注册 | 挂载 `maintenance` 路由 |

---

## 阶段划分

- **阶段 1（Task 1-2）**：数据模型 + Prisma schema —— 落库基建
- **阶段 2（Task 3-8）**：探针层 —— `MaintenanceProbe`/`PageProxy`/`SelectorRegistry`/清洗 + `HumanActions`/`interceptor` 扩展
- **阶段 3（Task 9-11）**：数据收集 + 配置快照服务
- **阶段 4（Task 12-14）**：REST API
- **阶段 5（Task 15-19）**：admin-dashboard UI
- **阶段 6（Task 20-21）**：抖音爬虫接入 + selectorTries 迁移
- **阶段 7（Task 22）**：端到端验证 + 收尾

每个任务独立可测、独立提交。测试命令约定：
- browser-core 测试：`pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/<file>.test.ts`
- gateway 测试：`pnpm --filter ts-api-gateway test -- src/<path>.test.ts`
- Prisma 迁移：`pnpm prisma:migrate -- --name <name>`（在仓库根目录）

---

## Task 1: Prisma schema — 6 张维护表 + MaintenanceStep.taskStepId 关联

**Files:**
- Modify: `prisma/schema.prisma`（在 `TaskExecutionStep` model 之后追加）

- [ ] **Step 1: 追加 6 个 model 到 schema.prisma**

在 `prisma/schema.prisma` 末尾（`TaskExecutionStep` model 之后）追加：

```prisma
model MaintenanceExecution {
  id              String    @id @default(cuid())
  taskExecutionId String    @unique @map("task_execution_id")
  platform        String    @db.VarChar(32)
  flowType        String    @map("flow_type") @db.VarChar(16) // monitor | publish | reply
  windowId        String    @map("window_id") @db.VarChar(128)
  userId          Int?      @map("user_id")
  overallHealth   String    @default("healthy") @db.VarChar(16) // healthy | degraded | failed
  totalSteps      Int       @default(0) @map("total_steps")
  healthySteps    Int       @default(0) @map("healthy_steps")
  degradedSteps   Int       @default(0) @map("degraded_steps")
  failedSteps     Int       @default(0) @map("failed_steps")
  totalSelectors  Int       @default(0) @map("total_selectors")
  passedSelectors Int       @default(0) @map("passed_selectors")
  failedSelectors Int       @default(0) @map("failed_selectors")
  totalUrlChecks  Int       @default(0) @map("total_url_checks")
  passedUrlChecks Int       @default(0) @map("passed_url_checks")
  startedAt       DateTime  @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")

  taskExecution TaskExecution @relation(fields: [taskExecutionId], references: [id], onDelete: Cascade)
  steps         MaintenanceStep[]

  @@index([platform, startedAt], name: "idx_maint_exec_platform_time")
  @@index([overallHealth], name: "idx_maint_exec_health")
  @@index([userId], name: "idx_maint_exec_user")
  @@map("maintenance_executions")
}

model MaintenanceStep {
  id              String    @id @default(cuid())
  executionId     String    @map("execution_id")
  taskStepId      String?   @map("task_step_id")
  phase           String    @db.VarChar(64)
  stepName        String    @map("step_name") @db.VarChar(128)
  subStepName     String?   @map("sub_step_name") @db.VarChar(128)
  healthStatus    String    @default("healthy") @map("health_status") @db.VarChar(16)
  outcomeSuccess  Boolean   @default(true) @map("outcome_success")
  outcomeDetail   String?   @map("outcome_detail") @db.Text
  durationMs      Int?      @map("duration_ms")
  selectorCount   Int       @default(0) @map("selector_count")
  selectorPassed  Int       @default(0) @map("selector_passed")
  urlCount        Int       @default(0) @map("url_count")
  urlPassed       Int       @default(0) @map("url_passed")
  createdAt       DateTime  @default(now()) @map("created_at")

  execution       MaintenanceExecution @relation(fields: [executionId], references: [id], onDelete: Cascade)
  taskStep        TaskExecutionStep?   @relation(fields: [taskStepId], references: [id], onDelete: SetNull)
  selectorRecords MaintenanceSelectorRecord[]
  urlRecords      MaintenanceUrlRecord[]
  snapshots       DebugSnapshot[]

  @@index([executionId, phase], name: "idx_maint_step_exec_phase")
  @@index([healthStatus], name: "idx_maint_step_health")
  @@index([taskStepId], name: "idx_maint_step_task_step")
  @@map("maintenance_steps")
}

model MaintenanceSelectorRecord {
  id                 String    @id @default(cuid())
  stepId             String    @map("step_id")
  selectorKey        String    @map("selector_key") @db.VarChar(128)
  selectorUsed       String    @map("selector_used") @db.Text
  selectorSource     String    @map("selector_source") @db.VarChar(20) // primary | fallback_1 | fallback_2 | bypass_detected
  result             String    @db.VarChar(20) // found | not_found | timeout | error | honeypot_blocked | scope_not_found | bypass_detected
  durationMs         Int?      @map("duration_ms")
  elementTag         String?   @map("element_tag") @db.VarChar(32)
  elementText        String?   @map("element_text") @db.VarChar(256)
  isVisible          Boolean?  @map("is_visible")
  isHoneypotBlocked  Boolean?  @map("is_honeypot_blocked")
  honeypotReason     String?   @map("honeypot_reason") @db.VarChar(32)
  scopeSelector      String?   @map("scope_selector") @db.VarChar(256)
  scopeMatchTimeMs   Int?      @map("scope_match_time_ms")
  errorMessage       String?   @map("error_message") @db.Text
  createdAt          DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId], name: "idx_maint_sel_step")
  @@index([selectorKey, result], name: "idx_maint_sel_key_result")
  @@map("maintenance_selector_records")
}

model MaintenanceUrlRecord {
  id              String    @id @default(cuid())
  stepId          String    @map("step_id")
  healthKey       String?   @map("health_key") @db.VarChar(128)
  urlPattern      String    @map("url_pattern") @db.VarChar(256)
  actualUrl       String?   @map("actual_url") @db.Text
  httpStatus      Int?      @map("http_status")
  result          String    @db.VarChar(24) // matched | no_match | timeout | extraction_failed | validation_failed
  validationStep  String?   @map("validation_step") @db.VarChar(64)
  itemsFound      Int?      @map("items_found")
  hasMore         Boolean?  @map("has_more")
  cursorValue     String?   @map("cursor_value") @db.VarChar(256)
  extractionValid Boolean?  @map("extraction_valid")
  missingFields   String?   @map("missing_fields") @db.Text
  requestParams   String?   @map("request_params") @db.Text
  videoId         String?   @map("video_id") @db.VarChar(64)
  commentCid      String?   @map("comment_cid") @db.VarChar(64)
  durationMs      Int?      @map("duration_ms")
  responseSize    Int?      @map("response_size")
  createdAt       DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId], name: "idx_maint_url_step")
  @@index([healthKey, result], name: "idx_maint_url_healthkey_result")
  @@index([videoId], name: "idx_maint_url_video")
  @@map("maintenance_url_records")
}

model DebugSnapshot {
  id           String    @id @default(cuid())
  stepId       String    @map("step_id")
  snapshotType String    @map("snapshot_type") @db.VarChar(16) // dom | response | network
  selectorKey  String?   @map("selector_key") @db.VarChar(128)
  urlPattern   String?   @map("url_pattern") @db.VarChar(256)
  content      String    @db.Text
  contentSize  Int       @default(0) @map("content_size")
  mimeType     String?   @map("mime_type") @db.VarChar(32)
  expiresAt    DateTime  @map("expires_at")
  createdAt    DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId, snapshotType], name: "idx_debug_snap_step_type")
  @@index([expiresAt], name: "idx_debug_snap_expires")
  @@map("debug_snapshots")
}

model ConfigSnapshot {
  id           String    @id @default(cuid())
  snapshotName String    @map("snapshot_name") @db.VarChar(128)
  platform     String    @db.VarChar(32)
  configType   String    @map("config_type") @db.VarChar(32) // selectors | url_monitors | flow_rules
  configData   String    @map("config_data") @db.Text
  version      Int       @default(1)
  createdBy    String    @default("system") @map("created_by") @db.VarChar(32)
  description  String    @default("") @db.VarChar(255)
  isActive     Boolean   @default(false) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")

  @@index([platform, configType, isActive], name: "idx_config_snap_active")
  @@index([platform, createdAt], name: "idx_config_snap_platform_time")
  @@map("config_snapshots")
}
```

- [ ] **Step 2: 给 `TaskExecutionStep` 加反向 relation**

在 `prisma/schema.prisma` 的 `model TaskExecutionStep` 内（`execution` relation 之后）追加一行反向关系：

```prisma
  maintenanceSteps MaintenanceStep[]
```

同时给 `TaskExecution` model 内追加反向关系：

```prisma
  maintenanceExecution MaintenanceExecution?
```

- [ ] **Step 3: 生成 Prisma client 并创建迁移**

Run:
```bash
pnpm prisma:generate
pnpm prisma:migrate -- --name add_maintenance_debug_tables
```
Expected: 迁移成功创建 `prisma/migrations/<timestamp>_add_maintenance_debug_tables/`，6 张表 + 索引建好，无报错。

- [ ] **Step 4: 验证表结构**

Run:
```bash
pnpm --filter ts-api-gateway exec -- npx prisma db pull --print | grep -E "model (Maintenance|DebugSnapshot|ConfigSnapshot)"
```
Expected: 输出 6 个 model，确认 schema 与 DB 一致。

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(prisma): add maintenance/debug 6 tables + taskStepId relation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: MaintenanceStep ↔ TaskExecutionStep 反向 relation 编译验证

**Files:**
- 无新文件（仅验证 Task 1 的 relation 字段编译通过）

- [ ] **Step 1: 验证 Prisma client 类型生成包含新 relation**

Run:
```bash
pnpm --filter ts-api-gateway exec -- tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep -iE "maintenance|error" | head
```
Expected: 无 `TaskExecutionStep.maintenanceSteps` / `TaskExecution.maintenanceExecution` 相关类型错误（空输出或仅有不相关的既有错误）。

- [ ] **Step 2: 写一个冒烟测试确认 client 可查询空表**

Create: `apps/ts-api-gateway/src/services/maintenanceSmoke.test.ts`

```typescript
import { prisma } from '../lib/prisma';

describe('maintenance tables smoke', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('can query all 6 new tables without error', async () => {
    await expect(prisma.maintenanceExecution.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceStep.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceSelectorRecord.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceUrlRecord.findMany()).resolves.toEqual([]);
    await expect(prisma.debugSnapshot.findMany()).resolves.toEqual([]);
    await expect(prisma.configSnapshot.findMany()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: 运行冒烟测试**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/services/maintenanceSmoke.test.ts
```
Expected: PASS（6 个表可空查询）。若失败提示表不存在，回查 Task 1 迁移是否执行。

- [ ] **Step 4: Commit**

```bash
git add apps/ts-api-gateway/src/services/maintenanceSmoke.test.ts
git commit -m "test(maintenance): smoke test for 6 new tables

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: snapshotSanitizer — Debug 快照令牌清洗

**Files:**
- Create: `packages/browser-core/src/snapshotSanitizer.ts`
- Test: `packages/browser-core/src/__tests__/snapshotSanitizer.test.ts`

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/snapshotSanitizer.test.ts`

```typescript
import { sanitizeSnapshot } from '../snapshotSanitizer';

describe('sanitizeSnapshot', () => {
  it('redacts csrf_token value in JSON', () => {
    const input = '{"csrf_token":"abcdef1234567890","ok":1}';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toMatch(/abcd\*\*\*REDACTED\*\*\*/);
    expect(out).toContain('"ok":1');
  });

  it('redacts Bearer authorization header', () => {
    const input = 'authorization:Bearer xyz1234567890abc';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toContain('xyz1234567890abc');
    expect(out).toMatch(/xyz1\*\*\*REDACTED\*\*\*/);
  });

  it('redacts session_id and X-Token and ticket', () => {
    const input = '{"session_id":"sess1234567890","X-Token":"tok1234567890","ticket":"tkt1234567890"}';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toMatch(/sess\d+/);
    expect(out).not.toMatch(/tok\d+/);
    expect(out).not.toMatch(/tkt\d+/);
  });

  it('leaves non-token content untouched', () => {
    const input = '<div class="comment">hello world</div>';
    expect(sanitizeSnapshot(input, 'text/html')).toBe(input);
  });

  it('records which patterns were redacted (via log callback)', () => {
    const redacted: string[] = [];
    sanitizeSnapshot('{"csrf_token":"abcdef1234567890"}', 'application/json', (p) => redacted.push(p));
    expect(redacted).toContain('csrf_token');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/snapshotSanitizer.test.ts
```
Expected: FAIL — `Cannot find module '../snapshotSanitizer'`。

- [ ] **Step 3: 实现 sanitizer**

Create: `packages/browser-core/src/snapshotSanitizer.ts`

```typescript
// @social-media/browser-core/snapshotSanitizer.ts
// Debug 快照存储前的令牌清洗：DOM/响应体可能含认证令牌，落库前必须脱敏。

export const TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'csrf_token', re: /(csrf_token['":\s]*['"])([\w-]+)(['"])/gi },
  { name: 'session_id', re: /(session_id['":\s]*['"])([\w-]+)(['"])/gi },
  { name: 'authorization', re: /(authorization['":\s]*['"])(Bearer\s+[\w-]+)(['"])/gi },
  { name: 'ticket', re: /(ticket['":\s]*['"])([\w-]+)(['"])/gi },
  { name: 'X-Token', re: /(X-Token['":\s]*['"])([\w-]+)(['"])/gi },
];

function redactValue(value: string): string {
  // 保留前 4 字符，其余替换为 ***REDACTED***
  return value.replace(/([\w-]{4})[\w-]+/, '$1***REDACTED***');
}

export function sanitizeSnapshot(
  content: string,
  _mimeType: string,
  onRedacted?: (patternName: string) => void,
): string {
  let sanitized = content;
  for (const { name, re } of TOKEN_PATTERNS) {
    let matched = false;
    sanitized = sanitized.replace(re, (match, prefix: string, value: string, suffix: string) => {
      matched = true;
      return `${prefix}${redactValue(value)}${suffix}`;
    });
    if (matched && onRedacted) onRedacted(name);
  }
  return sanitized;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/snapshotSanitizer.test.ts
```
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/snapshotSanitizer.ts packages/browser-core/src/__tests__/snapshotSanitizer.test.ts
git commit -m "feat(browser-core): snapshotSanitizer for debug snapshot token redaction

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: MaintenanceProbe — 健康探针（AsyncLocalStorage 上下文 + Redis 推送）

**Files:**
- Create: `packages/browser-core/src/maintenanceProbe.ts`
- Test: `packages/browser-core/src/__tests__/maintenanceProbe.test.ts`

> 设计要点：探针运行在浏览器进程（爬虫 worker）侧，收集事件后经 Redis `LPUSH` 推到 `probe_events` list，由 gateway 侧 `MaintenanceCollector`（Task 9）`BRPOP` 消费。Redis client 通过 `setRedisPusher` 注入（解耦，便于测试）。Redis 不可用时静默丢弃。

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/maintenanceProbe.test.ts`

```typescript
import { MaintenanceProbe } from '../maintenanceProbe';

type Pushed = { channel: string; payload: any };
function makeProbe() {
  const pushed: Pushed[] = [];
  const pusher = async (channel: string, payload: any) => { pushed.push({ channel, payload }); };
  return { pushed, pusher };
}

describe('MaintenanceProbe', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('is disabled by default and drops events silently', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    // enabled=false
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'found', durationMs: 5,
    });
    await MaintenanceProbe.flush();
    expect((await emitted())).toHaveLength(0);
  });

  it('propagates context across async hops via AsyncLocalStorage', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'expandMenu', 'sub1', 'exec-1');
    await new Promise(r => setImmediate(r));
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'menu_home', selectorUsed: 'getByRole', selectorSource: 'primary',
      result: 'found', durationMs: 12,
    });
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    expect(evts).toHaveLength(1);
    expect(evts[0].type).toBe('selector');
    expect(evts[0].context.flow).toBe('monitor');
    expect(evts[0].context.taskExecutionId).toBe('exec-1');
    expect(evts[0].context.step).toBe('expandMenu');
  });

  it('getContext returns undefined outside enterStep', () => {
    expect(MaintenanceProbe.getContext()).toBeUndefined();
  });

  it('recordUrlIntercept emits a url event with videoId/commentCid', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'scroll');
    await MaintenanceProbe.recordUrlIntercept({
      healthKey: 'video_list', urlPattern: '/aweme/v1/web/aweme/post', actualUrl: 'http://x',
      httpStatus: 200, result: 'matched', itemsFound: 12, hasMore: true,
      durationMs: 180, responseSize: 4096, videoId: 'aweme-1',
    });
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    expect(evts[0].type).toBe('url');
    expect(evts[0].payload.videoId).toBe('aweme-1');
  });

  it('recordBypass emits bypass event with method+stack', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'phase1', 'step');
    await MaintenanceProbe.recordBypass('evaluate', 'stack-trace-here', 'win-1');
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    expect(evts[0].type).toBe('bypass');
    expect(evts[0].payload.method).toBe('evaluate');
    expect(evts[0].payload.windowId).toBe('win-1');
  });

  it('caps bypass events per step at 100', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'phase1', 'step');
    for (let i = 0; i < 150; i++) {
      await MaintenanceProbe.recordBypass('evaluate', 's', 'w');
    }
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    expect(evts.length).toBe(100);
  });

  it('does not push when pusher throws (silent drop)', async () => {
    const pusher = async () => { throw new Error('redis down'); };
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's');
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'found', durationMs: 1,
    });
    MaintenanceProbe.exitStep();
    await expect(emitted()).resolves.toHaveLength(0); // 不抛
  });

  it('recordSnapshot respects 50-per-exec cap', async () => {
    MaintenanceProbe.setRedisPusher(async (_c, p) => {});
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'exec-cap');
    // 先制造连续失败以满足 DEBUG_TRIGGER_AFTER_N
    for (let i = 0; i < 5; i++) {
      await MaintenanceProbe.recordSelectorOp({
        selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
        result: 'not_found', durationMs: 1,
      });
    }
    // 采样率用 hash，多调几次确保跨过采样门限；上限 50 后丢弃
    let pushed = 0;
    for (let i = 0; i < 200; i++) {
      await MaintenanceProbe.recordSnapshot('dom', { content: `<div>${i}</div>`, mimeType: 'text/html' });
    }
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    const snaps = evts.filter(e => e.type === 'snapshot');
    expect(snaps.length).toBeLessThanOrEqual(50);
  });

  it('recordSnapshot skips when consecutive failures < 3', async () => {
    MaintenanceProbe.setRedisPusher(async (_c, p) => {});
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'exec-trig');
    // 仅 1 次失败，未达 DEBUG_TRIGGER_AFTER_N=3
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'not_found', durationMs: 1,
    });
    await MaintenanceProbe.recordSnapshot('dom', { content: '<div></div>', mimeType: 'text/html' });
    MaintenanceProbe.exitStep();
    const evts = await emitted();
    expect(evts.filter(e => e.type === 'snapshot')).toHaveLength(0);
  });

  async function emitted(): Promise<any[]> {
    await MaintenanceProbe.flush();
    return (MaintenanceProbe as any).__lastPushed ?? [];
  }
});
```

> 注：测试用 `__lastPushed` 暴露推送到 pusher 的事件，实现中需在 pusher 调用处同步写入该字段供测试读取。见 Step 3 实现。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/maintenanceProbe.test.ts
```
Expected: FAIL — `Cannot find module '../maintenanceProbe'`。

- [ ] **Step 3: 实现 MaintenanceProbe**

Create: `packages/browser-core/src/maintenanceProbe.ts`

```typescript
// @social-media/browser-core/maintenanceProbe.ts
// 健康探针：AsyncLocalStorage 隔离并发任务上下文，事件经 Redis LPUSH 异步推送。
// Redis 不可用时静默丢弃，绝不阻塞业务流程。

import { AsyncLocalStorage } from 'async_hooks';
import { rootLogger } from '../logger';

const logger = rootLogger.child({ name: 'maintenanceProbe' });

export interface ProbeContext {
  flow: string;
  platform: string;
  phase: string;
  step: string;
  subStep?: string;
  taskExecutionId?: string;
}

export type RedisPusher = (channel: string, payload: string) => Promise<void>;

export const PROBE_CHANNEL = 'probe_events';
const BYPASS_CAP_PER_STEP = 100;
// 5.8 Debug 快照熔断参数
const DEBUG_SAMPLE_RATE = 0.2;            // 采样率 20%
const DEBUG_TRIGGER_AFTER_N = 3;          // 连续 3 次失败后才保存快照
const DEBUG_MAX_SNAPSHOTS_PER_EXEC = 50;  // 单次执行上限 50 条

export interface SelectorOp {
  selectorKey: string;
  selectorUsed: string;
  selectorSource: 'primary' | 'fallback_1' | 'fallback_2';
  result: 'found' | 'not_found' | 'timeout' | 'error' | 'honeypot_blocked' | 'scope_not_found';
  durationMs: number;
  elementTag?: string;
  elementText?: string;
  isVisible?: boolean;
  isHoneypotBlocked?: boolean;
  honeypotReason?: 'off-screen' | 'obscured' | 'too-small';
  scopeSelector?: string;
  scopeMatchTimeMs?: number;
  errorMessage?: string;
}

export interface UrlInterceptOp {
  healthKey: string;
  urlPattern: string;
  actualUrl: string;
  httpStatus: number;
  result: 'matched' | 'no_match' | 'timeout' | 'extraction_failed' | 'validation_failed';
  validationStep?: string;
  itemsFound?: number;
  hasMore?: boolean;
  cursorValue?: string;
  extractionValid?: boolean;
  missingFields?: string[];
  requestParams?: Record<string, unknown>;
  durationMs: number;
  responseSize: number;
  videoId?: string;
  commentCid?: string;
}

interface ProbeEvent {
  type: 'selector' | 'url' | 'bypass' | 'snapshot';
  context: ProbeContext;
  payload: Record<string, unknown>;
  ts: number;
}

class MaintenanceProbeClass {
  private enabled = false;
  private contextStore = new AsyncLocalStorage<ProbeContext>();
  private pusher: RedisPusher | null = null;
  private buffer: ProbeEvent[] = [];
  private bypassCountInStep = 0;
  // 5.8 熔断状态（按 taskExecutionId 维度）
  private snapshotCountPerExec = new Map<string, number>();
  private consecutiveFailuresPerExec = new Map<string, number>();
  // 测试观测口
  __lastPushed: any[] = [];

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  setRedisPusher(p: RedisPusher | null): void { this.pusher = p; }

  // 测试复位
  reset(): void {
    this.enabled = false;
    this.pusher = null;
    this.buffer = [];
    this.bypassCountInStep = 0;
    this.snapshotCountPerExec.clear();
    this.consecutiveFailuresPerExec.clear();
    this.__lastPushed = [];
  }

  enterStep(
    flow: string, platform: string, phase: string, step: string,
    subStep?: string, taskExecutionId?: string,
  ): void {
    this.bypassCountInStep = 0;
    const ctx: ProbeContext = { flow, platform, phase, step, subStep, taskExecutionId };
    this.contextStore.enterWith(ctx);
  }

  exitStep(): void {
    // AsyncLocalStorage 无法显式 pop；下游 await 自然脱离上下文。
    // bypassCountInStep 在下次 enterStep 复位。
  }

  getContext(): ProbeContext | undefined {
    return this.contextStore.getStore();
  }

  async recordSelectorOp(op: SelectorOp): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    this.trackFailure(ctx.taskExecutionId, op.result !== 'found');
    this.buffer.push({ type: 'selector', context: ctx, payload: { ...op }, ts: 0 });
  }

  async recordUrlIntercept(op: UrlInterceptOp): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    this.trackFailure(ctx.taskExecutionId, op.result !== 'matched');
    this.buffer.push({ type: 'url', context: ctx, payload: { ...op }, ts: 0 });
  }

  // 5.8 熔断：累计连续失败次数（仅用于快照触发判定，不落库）
  private trackFailure(execId: string | undefined, isFailure: boolean): void {
    if (!execId) return;
    const cur = this.consecutiveFailuresPerExec.get(execId) ?? 0;
    this.consecutiveFailuresPerExec.set(execId, isFailure ? cur + 1 : 0);
  }

  async recordBypass(method: string, stack: string | undefined, windowId: string): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    if (this.bypassCountInStep >= BYPASS_CAP_PER_STEP) return;
    this.bypassCountInStep++;
    this.buffer.push({
      type: 'bypass', context: ctx,
      payload: { method, stack, windowId, selectorSource: 'bypass_detected' }, ts: 0,
    });
  }

  async recordSnapshot(
    type: 'dom' | 'response' | 'network',
    data: { selectorKey?: string; urlPattern?: string; content: string; mimeType: string },
  ): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx || !ctx.taskExecutionId) return;
    const execId = ctx.taskExecutionId;

    // 5.8 熔断 1：单次执行上限 50 条，超出丢弃最旧的（这里直接丢弃新的）
    const count = this.snapshotCountPerExec.get(execId) ?? 0;
    if (count >= DEBUG_MAX_SNAPSHOTS_PER_EXEC) return;

    // 5.8 熔断 2：连续失败 N 次后才保存快照（成功时不存快照）
    const failures = this.consecutiveFailuresPerExec.get(execId) ?? 0;
    if (failures < DEBUG_TRIGGER_AFTER_N) return;

    // 5.8 熔断 3：采样率 20%（伪随机用 hash 替代 Math.random，因运行时禁用 Math.random）
    if (!this.sampleByHash(execId, count, data.content)) return;

    this.snapshotCountPerExec.set(execId, count + 1);
    this.buffer.push({ type: 'snapshot', context: ctx, payload: { snapshotType: type, ...data }, ts: 0 });
  }

  // 采样：用 execId+count 的 hash 取模替代 Math.random（运行时禁用 Math.random）
  private sampleByHash(execId: string, count: number, content: string): boolean {
    let h = 0;
    const s = `${execId}:${count}:${content.length}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % 100) < DEBUG_SAMPLE_RATE * 100;
  }

  async flush(): Promise<void> {
    if (!this.pusher || this.buffer.length === 0) {
      this.__lastPushed = [];
      return;
    }
    const events = this.buffer.splice(0);
    this.__lastPushed = [];
    for (const ev of events) {
      try {
        await this.pusher(PROBE_CHANNEL, JSON.stringify(ev));
        this.__lastPushed.push(ev);
      } catch (err: any) {
        // 静默丢弃，不阻塞业务
        logger.debug({ err: err.message }, 'probe push failed (silent drop)');
      }
    }
  }
}

export const MaintenanceProbe = new MaintenanceProbeClass();
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/maintenanceProbe.test.ts
```
Expected: PASS（9 个用例）。若 AsyncLocalStorage 跨 `setImmediate` 上下文丢失，确认 `enterWith` 在 `enterStep` 同步调用、`recordXxx` 在同一异步链。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/maintenanceProbe.ts packages/browser-core/src/__tests__/maintenanceProbe.test.ts
git commit -m "feat(browser-core): MaintenanceProbe with AsyncLocalStorage + Redis pusher

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: SelectorRegistry — 新命名空间注册中心（委托 SelectorReader）

**Files:**
- Create: `packages/browser-core/src/selectorRegistry.ts`
- Test: `packages/browser-core/src/__tests__/selectorRegistry.test.ts`

> 设计：目标态命名空间 `platform.flow.key`（如 `douyin.monitor.menu_creator_home`）。迁移期内部映射到现有 `SelectorReader.getSelector(platform, category, name)`。flow→category 解析规则：key 中可显式带 category 前缀（如 `menu_*`→menus、`btn_*`/`button_*`→buttons、`region_*`→regions、`input_*`/`textbox_*`→textboxes），未匹配时 registry 按注册表查所有 category。返回统一的 `ResolvedSelector`（含 strategy/primary/fallbacks/scope/anti_honeypot 可选字段，旧结构无则缺省）。

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/selectorRegistry.test.ts`

```typescript
import { SelectorRegistry } from '../selectorRegistry';
import type { SelectorReader } from '../selectorConfig';

// 构造一个最小 mock reader
function mockReader(getSelectorImpl: any): SelectorReader {
  return { getSelector: getSelectorImpl, getSelectorList: () => [] } as any;
}

describe('SelectorRegistry', () => {
  it('resolves douyin.monitor.menu_home via flow→category mapping', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      cat === 'menus' && name === 'menu_home'
        ? { primary: '#home', fallbacks: ['.home'], selectorType: 'css', purposes: ['monitor'] }
        : null,
    );
    SelectorRegistry.setReader(reader);
    const r = SelectorRegistry.get('douyin.monitor.menu_home');
    expect(r).not.toBeNull();
    expect(r!.primary).toBe('#home');
    expect(r!.fallbacks).toEqual(['.home']);
    expect(r!.selectorKey).toBe('douyin.monitor.menu_home');
  });

  it('returns null for unknown key', () => {
    SelectorRegistry.setReader(mockReader(() => null));
    expect(SelectorRegistry.get('douyin.monitor.no_such')).toBeNull();
  });

  it('maps key prefixes: btn_→buttons, region_→regions, input_→textboxes', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      ({ primary: `#${cat}-${name}`, fallbacks: [], selectorType: 'css', purposes: [] }));
    SelectorRegistry.setReader(reader);
    expect(SelectorRegistry.get('douyin.publish.btn_submit')!.primary).toBe('#buttons-submit');
    expect(SelectorRegistry.get('douyin.monitor.region_work_list')!.primary).toBe('#regions-work_list');
    expect(SelectorRegistry.get('douyin.publish.input_caption')!.primary).toBe('#textboxes-caption');
  });

  it('falls back to scanning all categories when prefix is ambiguous', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      cat === 'regions' && name === 'work_list'
        ? { primary: '#rl', fallbacks: [], selectorType: 'css', purposes: [] }
        : null);
    SelectorRegistry.setReader(reader);
    expect(SelectorRegistry.get('douyin.monitor.work_list')!.primary).toBe('#rl');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/selectorRegistry.test.ts
```
Expected: FAIL — `Cannot find module '../selectorRegistry'`。

- [ ] **Step 3: 实现 SelectorRegistry**

Create: `packages/browser-core/src/selectorRegistry.ts`

```typescript
// @social-media/browser-core/selectorRegistry.ts
// 新命名空间注册中心：'platform.flow.key' → 现有 SelectorReader (platform, category, name)
// 迁移期桥接层，不破坏现有 selectors.json 旧结构。

import type { SelectorReader, SelectorCategory, SelectorEntry } from './selectorConfig';
import { rootLogger } from '../logger';

const logger = rootLogger.child({ name: 'selectorRegistry' });

export interface ResolvedSelector {
  selectorKey: string;
  platform: string;
  flow: string;
  strategy: string;           // text_role | data_attr | scoped_css | relative | xpath（缺省 scoped_css）
  primary: string;
  fallbacks: string[];
  scope?: string;
  chain?: string[];
  target?: string;
  antiHoneypot?: {
    minWidth: number; minHeight: number; mustBeInViewport: boolean; elementFromPoint: boolean;
  };
  timeout: number;
  description?: string;
}

const ALL_CATEGORIES: SelectorCategory[] = ['menus', 'buttons', 'regions', 'textboxes'];

// key 前缀 → category
function inferCategory(key: string): SelectorCategory[] {
  if (/^menu_/.test(key)) return ['menus'];
  if (/^(btn_|button_)/.test(key)) return ['buttons'];
  if (/^region_/.test(key)) return ['regions'];
  if (/^(input_|textbox_)/.test(key)) return ['textboxes'];
  return ALL_CATEGORIES; // 模糊：扫描全部
}

function adapt(entry: SelectorEntry, selectorKey: string, platform: string, flow: string): ResolvedSelector {
  return {
    selectorKey,
    platform,
    flow,
    strategy: (entry as any).strategy || 'scoped_css',
    primary: entry.primary,
    fallbacks: entry.fallbacks ?? [],
    scope: (entry as any).scope,
    chain: (entry as any).chain,
    target: (entry as any).target,
    antiHoneypot: (entry as any).anti_honeypot,
    timeout: (entry as any).timeout ?? 5000,
    description: entry.description,
  };
}

class SelectorRegistryClass {
  private reader: SelectorReader | null = null;

  setReader(reader: SelectorReader | null): void { this.reader = reader; }
  getReader(): SelectorReader | null { return this.reader; }

  /** 解析 'platform.flow.key' → ResolvedSelector | null */
  get(path: string): ResolvedSelector | null {
    if (!this.reader) {
      logger.warn('SelectorRegistry reader not set');
      return null;
    }
    const parts = path.split('.');
    if (parts.length < 3) {
      logger.warn({ path }, 'invalid selector path, expected platform.flow.key');
      return null;
    }
    const platform = parts[0];
    const flow = parts[1];
    const key = parts.slice(2).join('.');

    for (const category of inferCategory(key)) {
      const entry = this.reader.getSelector(platform, category, key);
      if (entry) return adapt(entry, path, platform, flow);
    }
    return null;
  }
}

export const SelectorRegistry = new SelectorRegistryClass();
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/selectorRegistry.test.ts
```
Expected: PASS（4 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/selectorRegistry.ts packages/browser-core/src/__tests__/selectorRegistry.test.ts
git commit -m "feat(browser-core): SelectorRegistry bridging 'platform.flow.key' to SelectorReader

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: PageProxy — 旁路报警器（apply 拦截器）

**Files:**
- Create: `packages/browser-core/src/pageProxy.ts`
- Test: `packages/browser-core/src/__tests__/pageProxy.test.ts`

> 设计：仅对返回函数的方法（`evaluate`/`evaluateHandle`/`$`/`$$`/`locator`）用 apply 拦截器，在实际调用时记录旁路。排除 `goto`/`screenshot`/`waitForTimeout`/`keyboard` 等非选择器旁路。返回的 Proxy 对调用方透明，业务逻辑不变。

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/pageProxy.test.ts`

```typescript
import { createProxiedPage, PROXY_INTERCEPT_METHODS } from '../pageProxy';
import { MaintenanceProbe } from '../maintenanceProbe';

function fakePage() {
  const calls: string[] = [];
  return {
    calls,
    page: {
      evaluate: async (fn: any) => { calls.push('evaluate'); return fn ? 42 : 0; },
      $: async () => { calls.push('$'); return null; },
      $$: async () => { calls.push('$$'); return []; },
      locator: () => { calls.push('locator'); return { click: async () => {} }; },
      goto: async () => { calls.push('goto'); return {}; },
      screenshot: async () => { calls.push('screenshot'); return Buffer.from(''); },
      waitForTimeout: async () => { calls.push('waitForTimeout'); },
      keyboard: { press: async () => {} },
      url: 'http://x',
    } as any,
  };
}

describe('PageProxy', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('intercepts evaluate/$/$$/locator calls', async () => {
    const { calls, page } = fakePage();
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async () => {});
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's', undefined, 'exec-x');
    const proxied = createProxiedPage(page, 'win-1');
    await proxied.evaluate(() => 42);
    await proxied.$('.a');
    await proxied.$$('.b');
    proxied.locator('.c');
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(calls).toEqual(['evaluate', '$', '$$', 'locator']);
  });

  it('does NOT intercept goto/screenshot/waitForTimeout/keyboard', async () => {
    const { calls, page } = fakePage();
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async () => {});
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's');
    const proxied = createProxiedPage(page, 'win-1');
    await proxied.goto('http://x');
    await proxied.screenshot();
    await proxied.waitForTimeout(10);
    MaintenanceProbe.exitStep();
    expect(calls).toEqual(['goto', 'screenshot', 'waitForTimeout']);
  });

  it('records bypass event with method + windowId', async () => {
    const { page } = fakePage();
    const pushed: any[] = [];
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's', undefined, 'exec-1');
    const proxied = createProxiedPage(page, 'win-7');
    await proxied.evaluate(() => 1);
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].type).toBe('bypass');
    expect(pushed[0].payload.method).toBe('evaluate');
    expect(pushed[0].payload.windowId).toBe('win-7');
  });

  it('forwards non-function properties transparently', () => {
    const { page } = fakePage();
    const proxied = createProxiedPage(page, 'w') as any;
    expect(proxied.url).toBe('http://x');
  });

  it('PROXY_INTERCEPT_METHODS excludes navigation/screenshot/wait/input', () => {
    expect(PROXY_INTERCEPT_METHODS).not.toContain('goto');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('screenshot');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('waitForTimeout');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('keyboard');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/pageProxy.test.ts
```
Expected: FAIL — `Cannot find module '../pageProxy'`。

- [ ] **Step 3: 实现 PageProxy**

Create: `packages/browser-core/src/pageProxy.ts`

```typescript
// @social-media/browser-core/pageProxy.ts
// 旁路报警器：对未收口到 HumanActions 的 page.evaluate/$/$$/locator 调用，
// 用 apply 拦截器在实际调用时记录旁路，不影响业务流程。
// 排除导航/截图/等待/输入等非选择器旁路。

import type { Page } from 'patchright';
import { MaintenanceProbe } from './maintenanceProbe';

export const PROXY_INTERCEPT_METHODS = ['evaluate', 'evaluateHandle', '$', '$$', 'locator'] as const;

// 已知非选择器旁路（白名单排除）
const EXCLUDED = new Set(['goto', 'screenshot', 'waitForTimeout', 'keyboard', 'mouse', 'fill']);

export function createProxiedPage(rawPage: Page, windowId: string): Page {
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const name = typeof prop === 'string' ? prop : String(prop);
      // 仅拦截目标方法，且排除白名单
      if (
        PROXY_INTERCEPT_METHODS.includes(name as any) &&
        !EXCLUDED.has(name) &&
        typeof value === 'function'
      ) {
        return new Proxy(value, {
          apply(fnTarget, thisArg, args) {
            // 仅在实际调用时记录旁路（不阻塞、不抛错）
            void MaintenanceProbe.recordBypass(
              name,
              new Error().stack,
              windowId,
            );
            return Reflect.apply(fnTarget, thisArg, args);
          },
        });
      }
      return value;
    },
  };
  return new Proxy(rawPage, handler) as Page;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/pageProxy.test.ts
```
Expected: PASS（5 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/pageProxy.ts packages/browser-core/src/__tests__/pageProxy.test.ts
git commit -m "feat(browser-core): PageProxy apply-interceptor for bypass detection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: HumanActions.clickWithFallback / findInScope（多路降级 + 防蜜罐 + 探针接线）

**Files:**
- Modify: `packages/browser-core/src/humanActions.ts`（在类末尾追加方法）
- Test: `packages/browser-core/src/__tests__/humanActionsFallback.test.ts`

> 设计：`clickWithFallback(page, config, opts)` 按 primary→fallbacks 顺序尝试，命中后记录 `recordSelectorOp`；fallback 命中触发 `onFallbackTriggered` 回调。`findInScope(page, config, vars)` 实现 scope 隔离 + 物理校验（≥15px + 视口内）+ elementFromPoint 三层防蜜罐，返回 `FindResult`。两者失败/异常均记录探针，不抛错阻断业务（除非全失败且 `opts.required`）。
>
> 复用现有：`page.locator(selector).count()`/`.waitFor({state:'visible', timeout})` 判定命中，`HumanActions.click(page, selector)` 执行点击，`page.evaluate` 做 elementFromPoint 校验。

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/humanActionsFallback.test.ts`

```typescript
import { HumanActions } from '../humanActions';
import { MaintenanceProbe } from '../maintenanceProbe';
import type { ResolvedSelector } from '../selectorRegistry';

function mockPage(locatorHits: Record<string, boolean>) {
  const clicks: string[] = [];
  const page: any = {
    locator: (sel: string) => ({
      count: async () => (locatorHits[sel] ? 1 : 0),
      waitFor: async () => {},
      first: () => ({ count: async () => (locatorHits[sel] ? 1 : 0) }),
      isVisible: async () => !!locatorHits[sel],
      boundingBox: async () => locatorHits[sel] ? { x: 10, y: 10, width: 100, height: 40 } : null,
      click: async () => { clicks.push(sel); },
    }),
    evaluate: async (fn: any, ...args: any[]) => {
      // elementFromPoint 校验：返回 selector 对应元素（模拟命中）
      return args[0];
    },
    waitForTimeout: async () => {},
  };
  return { page, clicks };
}

function cfg(over: Partial<ResolvedSelector> = {}): ResolvedSelector {
  return {
    selectorKey: 'douyin.monitor.menu_home', platform: 'douyin', flow: 'monitor',
    strategy: 'scoped_css', primary: '#primary', fallbacks: ['.fb1', '.fb2'],
    timeout: 5000, ...over,
  } as ResolvedSelector;
}

describe('HumanActions.clickWithFallback', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('uses primary when it hits', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page, clicks } = mockPage({ '#primary': true });
    await HumanActions.clickWithFallback(page, cfg(), {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(clicks).toEqual(['#primary']);
    expect(pushed[0].payload.selectorSource).toBe('primary');
    expect(pushed[0].payload.result).toBe('found');
  });

  it('falls back to fallback_1 when primary misses, fires onFallbackTriggered', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page, clicks } = mockPage({ '.fb1': true });
    let triggered: any = null;
    await HumanActions.clickWithFallback(page, cfg(), {
      onFallbackTriggered: (failed, success, key) => { triggered = { failed, success, key }; },
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(clicks).toEqual(['.fb1']);
    expect(pushed[0].payload.selectorSource).toBe('primary');
    expect(pushed[0].payload.result).toBe('not_found');
    expect(pushed[1].payload.selectorSource).toBe('fallback_1');
    expect(pushed[1].payload.result).toBe('found');
    expect(triggered).toEqual({ failed: '#primary', success: '.fb1', key: 'douyin.monitor.menu_home' });
  });

  it('records timeout when nothing hits', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({});
    await HumanActions.clickWithFallback(page, cfg(), {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const selEvents = pushed.filter(e => e.type === 'selector');
    expect(selEvents.every(e => e.payload.result === 'not_found')).toBe(true);
  });
});

describe('HumanActions.findInScope', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('finds element inside scope and passes physical checks', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({ '.scope': true, '.target': true });
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(true);
    expect(pushed[0].payload.result).toBe('found');
    expect(pushed[0].payload.scopeSelector).toBe('.scope');
  });

  it('returns scope_not_found when scope missing', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({ '.target': true }); // scope 不在
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(false);
    expect(r.scopeNotFound).toBe(true);
    expect(pushed[0].payload.result).toBe('scope_not_found');
  });

  it('flags honeypot_blocked when element too small', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    // 自定义 page：scope 命中，target 命中但 boundingBox 很小
    const page: any = {
      locator: (sel: string) => ({
        count: async () => 1,
        first: () => ({ count: async () => 1 }),
        isVisible: async () => true,
        boundingBox: async () => sel === '.target' ? { x: 0, y: 0, width: 5, height: 5 } : { x: 0, y: 0, width: 200, height: 200 },
        waitFor: async () => {},
        click: async () => {},
      }),
      evaluate: async () => null,
      waitForTimeout: async () => {},
    };
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(false);
    expect(pushed[0].payload.result).toBe('honeypot_blocked');
    expect(pushed[0].payload.honeypotReason).toBe('too-small');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/humanActionsFallback.test.ts
```
Expected: FAIL — `HumanActions.clickWithFallback is not a function`。

- [ ] **Step 3: 实现两个方法**

在 `packages/browser-core/src/humanActions.ts` 顶部 import 区追加：

```typescript
import { MaintenanceProbe } from './maintenanceProbe';
import type { ResolvedSelector } from './selectorRegistry';
```

在 `HumanActions` 类内末尾（最后一个方法之后、类闭合 `}` 之前）追加：

```typescript
  // ===== 维护调试收口：clickWithFallback / findInScope =====

  static async clickWithFallback(
    page: Page,
    config: ResolvedSelector,
    opts: {
      onFallbackTriggered?: (failedSel: string, successSel: string, selectorKey: string) => void;
      required?: boolean; // true 时全失败抛错
    } = {},
  ): Promise<void> {
    const candidates: Array<{ sel: string; source: 'primary' | 'fallback_1' | 'fallback_2' }> = [
      { sel: config.primary, source: 'primary' },
      ...config.fallbacks.slice(0, 2).map((sel, i) => ({
        sel,
        source: (i === 0 ? 'fallback_1' : 'fallback_2') as 'fallback_1' | 'fallback_2',
      })),
    ];

    for (const { sel, source } of candidates) {
      const start = Date.now();
      try {
        const locator = page.locator(sel).first();
        const count = await locator.count();
        if (count > 0) {
          await HumanActions.click(page, sel);
          await MaintenanceProbe.recordSelectorOp({
            selectorKey: config.selectorKey,
            selectorUsed: sel,
            selectorSource: source,
            result: 'found',
            durationMs: Date.now() - start,
            scopeSelector: config.scope,
          });
          if (source !== 'primary') {
            opts.onFallbackTriggered?.(config.primary, sel, config.selectorKey);
          }
          return;
        }
        await MaintenanceProbe.recordSelectorOp({
          selectorKey: config.selectorKey,
          selectorUsed: sel,
          selectorSource: source,
          result: 'not_found',
          durationMs: Date.now() - start,
          scopeSelector: config.scope,
        });
      } catch (err: any) {
        await MaintenanceProbe.recordSelectorOp({
          selectorKey: config.selectorKey,
          selectorUsed: sel,
          selectorSource: source,
          result: 'error',
          durationMs: Date.now() - start,
          errorMessage: err?.message ?? String(err),
          scopeSelector: config.scope,
        });
      }
    }

    if (opts.required) {
      throw new Error(`clickWithFallback: all selectors missed for ${config.selectorKey}`);
    }
  }

  static async findInScope(
    page: Page,
    config: ResolvedSelector,
    vars: Record<string, string> = {},
  ): Promise<{ found: boolean; selector?: string; scopeNotFound?: boolean; honeypotReason?: string }> {
    const applyVars = (s: string) =>
      Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), s);

    const scopeSel = config.scope ? applyVars(config.scope) : null;
    const scopeStart = scopeSel ? Date.now() : 0;
    if (scopeSel) {
      const scopeCount = await page.locator(scopeSel).first().count();
      if (scopeCount === 0) {
        await MaintenanceProbe.recordSelectorOp({
          selectorKey: config.selectorKey,
          selectorUsed: applyVars(config.primary),
          selectorSource: 'primary',
          result: 'scope_not_found',
          durationMs: Date.now() - scopeStart,
          scopeSelector: scopeSel,
        });
        return { found: false, scopeNotFound: true };
      }
    }

    const targetSel = applyVars(config.primary);
    const start = Date.now();
    const targetLocator = page.locator(targetSel).first();
    if ((await targetLocator.count()) === 0) {
      await MaintenanceProbe.recordSelectorOp({
        selectorKey: config.selectorKey,
        selectorUsed: targetSel,
        selectorSource: 'primary',
        result: 'not_found',
        durationMs: Date.now() - start,
        scopeSelector: scopeSel ?? undefined,
        scopeMatchTimeMs: scopeSel ? Date.now() - scopeStart : undefined,
      });
      return { found: false };
    }

    // 物理校验：尺寸 ≥ 15px
    const box = await targetLocator.boundingBox();
    const minSize = config.antiHoneypot?.minWidth ?? 15;
    const minH = config.antiHoneypot?.minHeight ?? 15;
    if (!box || box.width < minSize || box.height < minH) {
      await MaintenanceProbe.recordSelectorOp({
        selectorKey: config.selectorKey,
        selectorUsed: targetSel,
        selectorSource: 'primary',
        result: 'honeypot_blocked',
        durationMs: Date.now() - start,
        honeypotReason: 'too-small',
        isVisible: false,
        scopeSelector: scopeSel ?? undefined,
      });
      return { found: false, honeypotReason: 'too-small' };
    }

    // elementFromPoint 校验：坐标最顶层是否为目标
    if (config.antiHoneypot?.elementFromPoint !== false) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const topEl = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? (el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '')) : null;
        },
        [cx, cy] as any,
      ).catch(() => null);
      // 简化：若 elementFromPoint 返回 null（被覆盖/透明层）视为蜜罐
      if (!topEl) {
        await MaintenanceProbe.recordSelectorOp({
          selectorKey: config.selectorKey,
          selectorUsed: targetSel,
          selectorSource: 'primary',
          result: 'honeypot_blocked',
          durationMs: Date.now() - start,
          honeypotReason: 'obscured',
          isVisible: true,
          scopeSelector: scopeSel ?? undefined,
        });
        return { found: false, honeypotReason: 'obscured' };
      }
    }

    await MaintenanceProbe.recordSelectorOp({
      selectorKey: config.selectorKey,
      selectorUsed: targetSel,
      selectorSource: 'primary',
      result: 'found',
      durationMs: Date.now() - start,
      isVisible: true,
      scopeSelector: scopeSel ?? undefined,
      scopeMatchTimeMs: scopeSel ? Date.now() - scopeStart : undefined,
    });
    return { found: true, selector: targetSel };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/humanActionsFallback.test.ts
```
Expected: PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-core/src/humanActions.ts packages/browser-core/src/__tests__/humanActionsFallback.test.ts
git commit -m "feat(browser-core): HumanActions.clickWithFallback/findInScope with anti-honeypot + probe

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: RequestInterceptor.attachByConfig / hotReloadRules + 探针 URL 接线 + browserManager PageProxy 接入 + index 导出

**Files:**
- Modify: `packages/browser-core/src/interceptor.ts`
- Modify: `packages/browser-core/src/browserManager.ts`
- Modify: `packages/browser-core/src/index.ts`
- Test: `packages/browser-core/src/__tests__/interceptorAttach.test.ts`

> 设计：
> - `attachByConfig(page, platform, healthKeys)`：读 `apiMonitors` 配置（迁移期回退 `apiPatterns`），按 healthKey 批量 `register` + `setValidationConfig`，记录 `recordUrlIntercept({result:'no_match'})` 占位（实际匹配在 register 回调内）。
> - `hotReloadRules(rules)`：替换内存 validation 配置，不重连 CDP。
> - 在现有 `storeResponse` 成功路径调 `recordUrlIntercept({result:'matched', ...})`，validation 失败路径（`logRejection`）调 `recordUrlIntercept({result:'validation_failed', validationStep, missingFields})`，透传 `pageKey`/`commentId` 作 `videoId`/`commentCid`。
> - `browserManager.connect()` 在返回 page 前包 `createProxiedPage`（仅当探针启用时，避免性能开销）。

- [ ] **Step 1: 写失败测试**

Create: `packages/browser-core/src/__tests__/interceptorAttach.test.ts`

```typescript
import { RequestInterceptor } from '../interceptor';
import { MaintenanceProbe } from '../maintenanceProbe';

describe('RequestInterceptor.attachByConfig + hotReloadRules', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('attachByConfig registers patterns and sets validation configs', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');

    const interceptor = new RequestInterceptor();
    const registered: string[] = [];
    const validated: any[] = [];
    // spy register / setValidationConfig
    (interceptor as any).register = async (_page: any, pats: string[]) => { registered.push(...pats); return 'pid'; };
    (interceptor as any).setValidationConfig = (pat: string, cfg: any) => { validated.push({ pat, cfg }); };

    const config = {
      video_list: {
        url_patterns: ['/aweme/v1/web/aweme/post', '/aweme/v2/web/aweme/post'],
        method: 'POST',
        validation: { required_body_fields: ['data.aweme_list'] },
      },
    };
    await interceptor.attachByConfig({} as any, 'douyin', ['video_list'], config);
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();

    expect(registered).toContain('/aweme/v1/web/aweme/post');
    expect(validated).toHaveLength(2);
    expect(validated[0].cfg.requiredBodyFields).toContain('data.aweme_list');
  });

  it('hotReloadRules replaces validation configs without re-registering', () => {
    const interceptor = new RequestInterceptor();
    const calls: any[] = [];
    (interceptor as any).setValidationConfig = (pat: string, cfg: any) => calls.push({ pat, cfg });
    (interceptor as any).register = async () => 'pid';

    interceptor.hotReloadRules({
      video_list: { url_patterns: ['/new'], validation: { required_body_fields: ['x'] } },
    });
    expect(calls.some(c => c.pat === '/new')).toBe(true);
  });

  it('storeResponse success path emits matched url event with videoId from pageKey', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');

    const interceptor = new RequestInterceptor();
    // 直接调内部 storeResponse（受测方法），传 requestBody 带 lastBuff
    await (interceptor as any).storeResponse(
      'video_list', 'http://x/aweme/v1/web/aweme/post', 200,
      { data: { aweme_list: [{ aweme_id: 'a1' }], has_more: 0 } },
      { lastBuff: 'aweme-99' },
    );
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();

    const urlEvts = pushed.filter(e => e.type === 'url');
    expect(urlEvts.length).toBeGreaterThanOrEqual(1);
    const matched = urlEvts.find(e => e.payload.result === 'matched');
    expect(matched).toBeDefined();
    expect(matched.payload.videoId).toBe('aweme-99');
    expect(matched.payload.itemsFound).toBe(1);
  });

  it('validation failure path emits validation_failed with missingFields', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');

    const interceptor = new RequestInterceptor();
    (interceptor as any).logRejection(
      'video_list', 'http://x', 'http://page',
      'missing_fields' as any, 'required_body_fields: data.aweme_list',
    );
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();

    const urlEvts = pushed.filter(e => e.type === 'url' && e.payload.result === 'validation_failed');
    expect(urlEvts).toHaveLength(1);
    expect(urlEvts[0].payload.validationStep).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/interceptorAttach.test.ts
```
Expected: FAIL — `interceptor.attachByConfig is not a function`。

- [ ] **Step 3: 实现 interceptor 扩展**

在 `packages/browser-core/src/interceptor.ts` 顶部 import 区追加：

```typescript
import { MaintenanceProbe } from './maintenanceProbe';
```

在 `RequestInterceptor` 类内追加两个公开方法（放在 `register` 方法之前或之后均可）：

```typescript
  /**
   * 按配置批量注册 URL 监听 + 校验规则（维护调试收口入口）。
   * config 形如 { video_list: { url_patterns, method, validation: { required_body_fields, ... } } }
   */
  async attachByConfig(
    page: Page,
    _platform: string,
    healthKeys: string[],
    config: Record<string, {
      url_patterns: string[];
      method?: string;
      validation?: {
        required_url_params?: string[];
        required_body_fields?: string[];
        success_indicator?: { path: string; value: any };
      };
    }>,
  ): Promise<void> {
    const allPatterns: string[] = [];
    for (const key of healthKeys) {
      const entry = config[key];
      if (!entry) continue;
      for (const pat of entry.url_patterns) {
        allPatterns.push(pat);
        if (entry.validation) {
          this.setValidationConfig(pat, {
            requiredUrlParams: entry.validation.required_url_params,
            requiredBodyFields: entry.validation.required_body_fields,
            successIndicator: entry.validation.success_indicator,
          } as any);
        }
      }
    }
    if (allPatterns.length > 0) {
      await this.register(page, allPatterns);
    }
  }

  /**
   * 热更新校验规则，无需断开 CDP 重连。
   */
  hotReloadRules(
    config: Record<string, { url_patterns: string[]; validation?: any }>,
  ): void {
    for (const entry of Object.values(config)) {
      for (const pat of entry.url_patterns) {
        if (entry.validation) {
          this.setValidationConfig(pat, entry.validation);
        }
      }
    }
  }
```

在 `storeResponse` 方法内（成功存储分支，即现有 `urlSet.add(dedupKey);` 之后、`getResponses` 写入完成附近）追加探针记录。先读取 `storeResponse` 当前实现末尾确认插入点：

Run:
```bash
sed -n '413,470p' packages/browser-core/src/interceptor.ts
```

在 `storeResponse` 内、`this.responses`/存储完成后追加（使用已计算的 `pageKey`/`commentId`/`items`/`hasMore` 局部变量）：

```typescript
    // 维护调试：记录 URL 拦截成功事件，透传 pageKey/commentId
    await MaintenanceProbe.recordUrlIntercept({
      healthKey: pattern,
      urlPattern: pattern,
      actualUrl: url,
      httpStatus: status,
      result: 'matched',
      itemsFound: items.length,
      hasMore: hasMore(body),
      cursorValue: getCursor(body) ?? undefined,
      extractionValid: true,
      videoId: pageKey || undefined,
      commentCid: commentId || undefined,
      durationMs: 0,
      responseSize: JSON.stringify(body).length,
    });
```

> 注：`hasMore`/`getCursor`/`items`/`pageKey`/`commentId` 均为 `storeResponse` 内现有局部变量/函数，确认变量名与现有实现一致（见上方 sed 输出）。`items` 由 `extractItems(body)` 得到。

在 `logRejection` 方法内末尾追加 validation_failed 探针记录：

```typescript
    // 维护调试：记录 URL 校验失败事件
    await MaintenanceProbe.recordUrlIntercept({
      healthKey: pattern,
      urlPattern: pattern,
      actualUrl: requestUrl,
      httpStatus: 0,
      result: 'validation_failed',
      validationStep: reason,
      missingFields: detail,
      extractionValid: false,
      durationMs: 0,
      responseSize: 0,
    });
```

- [ ] **Step 4: browserManager 接入 PageProxy**

在 `packages/browser-core/src/browserManager.ts` import 区追加：

```typescript
import { createProxiedPage } from './pageProxy';
import { MaintenanceProbe } from './maintenanceProbe';
```

在 `connect()` 方法的每个 `return { browser, page }` / `return { browser: existingSession.browser, page: newPage }` 之前，将 `page`/`newPage` 包裹。为避免分散修改 6 处，提取一个辅助函数并在每处 return 前调用：

在 `BrowserManager` 类内追加私有辅助方法：

```typescript
  private maybeProxyPage(page: Page): Page {
    // 仅在探针启用时包代理，避免生产性能开销
    if (MaintenanceProbe.isEnabled()) {
      return createProxiedPage(page, this.currentWindowId ?? 'unknown');
    }
    return page;
  }
```

并在 `connect()` 方法签名开头记录 `this.currentWindowId = windowId;`（类内新增字段 `private currentWindowId?: string;`）。

然后修改 `connect()` 内 4 处 `return { browser: existingSession.browser, page: newPage };` 与 `return { browser, page };`，将 `page: newPage`/`page` 改为 `page: this.maybeProxyPage(newPage)`/`page: this.maybeProxyPage(page)`。

> 执行者需用 grep 定位全部 return 点：
> ```bash
> grep -nE "return \{ browser" packages/browser-core/src/browserManager.ts
> ```
> 共 4 处（行 347、370、390、496），逐处用 Edit 替换 `page: newPage` → `page: this.maybeProxyPage(newPage)`，`page` → `page: this.maybeProxyPage(page)`（行 377 是 `page: platformPage`，同样替换）。

- [ ] **Step 5: index.ts 导出新模块**

在 `packages/browser-core/src/index.ts` 追加：

```typescript
export { MaintenanceProbe } from './maintenanceProbe';
export type { ProbeContext, SelectorOp, UrlInterceptOp, RedisPusher } from './maintenanceProbe';
export { createProxiedPage, PROXY_INTERCEPT_METHODS } from './pageProxy';
export { SelectorRegistry } from './selectorRegistry';
export type { ResolvedSelector } from './selectorRegistry';
export { sanitizeSnapshot } from './snapshotSanitizer';
```

- [ ] **Step 6: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/interceptorAttach.test.ts
```
Expected: PASS（4 个用例）。若 `storeResponse` 变量名不匹配，回查 Step 3 的 sed 输出并对齐。

- [ ] **Step 7: 跑 browser-core 全量回归**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/
```
Expected: 既有 `humanActions.test.ts`/`interceptor.test.ts` 全部 PASS，新增测试 PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/browser-core/src/interceptor.ts packages/browser-core/src/browserManager.ts packages/browser-core/src/index.ts packages/browser-core/src/__tests__/interceptorAttach.test.ts
git commit -m "feat(browser-core): interceptor.attachByConfig/hotReloadRules + probe wiring + PageProxy in connect

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: MaintenanceCollector — Redis BRPOP 消费 + 批量 flush + 健康汇总

**Files:**
- Create: `apps/ts-api-gateway/src/services/maintenanceCollector.ts`
- Test: `apps/ts-api-gateway/src/services/maintenanceCollector.test.ts`
- Modify: `apps/ts-api-gateway/src/index.ts`（启动消费）

> 设计：`BRPOP probe_events 5` 阻塞消费，缓冲满 50 条或 5 秒 flush 一次到 `maintenance_*` 表。事件按 `context.taskExecutionId` 聚合，`summarizeExecution(taskExecutionId)` 在执行完成时被调用，计算步骤/选择器/URL 健康并写 `maintenance_execution`。Redis 不可用静默重连。测试用注入的 `consumeOnce(events)` 跳过真实 Redis。

- [ ] **Step 1: 写失败测试**

Create: `apps/ts-api-gateway/src/services/maintenanceCollector.test.ts`

```typescript
import { MaintenanceCollector } from './maintenanceCollector';
import { prisma } from '../lib/prisma';

// 测试用：直接注入事件，绕过 Redis BRPOP
async function ingest(collector: MaintenanceCollector, events: any[]) {
  for (const e of events) await (collector as any).ingestOne(e);
  await (collector as any).flushNow();
}

function ev(over: Partial<any> = {}) {
  return {
    type: 'selector',
    context: { flow: 'monitor', platform: 'douyin', phase: 'phase1', step: 'expandMenu', taskExecutionId: 'exec-1' },
    payload: { selectorKey: 'menu_home', selectorUsed: '#h', selectorSource: 'primary', result: 'found', durationMs: 5 },
    ts: 0,
    ...over,
  };
}

describe('MaintenanceCollector', () => {
  let collector: MaintenanceCollector;

  beforeEach(() => { collector = new MaintenanceCollector(); });
  afterAll(async () => { await prisma.maintenanceExecution.deleteMany({}); await prisma.$disconnect(); });

  it('flush persists selector events into maintenance_selector_records linked to a step', async () => {
    // 先造一个 maintenance_execution + step（模拟 startExecution 已建）
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t1', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t1' } }),
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t1' }, payload: { ...ev().payload, result: 'not_found' } }),
    ]);
    const records = await prisma.maintenanceSelectorRecord.findMany({
      include: { step: true },
    });
    const mine = records.filter(r => r.step.executionId === exec.id);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
  });

  it('summarizeExecution computes healthy/degraded/failed counts', async () => {
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t2', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t2' }, payload: { ...ev().payload, result: 'found' } }),
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t2', step: 'scroll' }, payload: { ...ev().payload, result: 'not_found' } }),
    ]);
    await collector.summarizeExecution('exec-t2');
    const summed = await prisma.maintenanceExecution.findUnique({ where: { taskExecutionId: 'exec-t2' } });
    expect(summed!.totalSelectors).toBeGreaterThanOrEqual(2);
    expect(summed!.passedSelectors).toBeGreaterThanOrEqual(1);
    expect(summed!.failedSelectors).toBeGreaterThanOrEqual(1);
    expect(['degraded', 'failed']).toContain(summed!.overallHealth);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
  });

  it('summarizeExecution is idempotent (no duplicate steps on re-summarize)', async () => {
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t3', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [ev({ context: { ...ev().context, taskExecutionId: 'exec-t3' } })]);
    await collector.summarizeExecution('exec-t3');
    await collector.summarizeExecution('exec-t3');
    const steps = await prisma.maintenanceStep.findMany({ where: { executionId: exec.id } });
    // 同一 step key 只有一条
    const keys = steps.map(s => `${s.phase}/${s.stepName}`);
    expect(new Set(keys).size).toBe(keys.length);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/services/maintenanceCollector.test.ts
```
Expected: FAIL — `Cannot find module './maintenanceCollector'`。

- [ ] **Step 3: 实现 MaintenanceCollector**

Create: `apps/ts-api-gateway/src/services/maintenanceCollector.ts`

```typescript
// @ts-api-gateway/services/maintenanceCollector.ts
// 消费 Redis probe_events → 落库 maintenance_* 表 → 健康汇总。
// BRPOP 5 秒阻塞，缓冲满 50 条或定时 flush。

import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('maintenance-collector');
const PROBE_CHANNEL = 'probe_events';
const FLUSH_BATCH = 50;
const BRPOP_TIMEOUT_SEC = 5;

interface ProbeEvent {
  type: 'selector' | 'url' | 'bypass' | 'snapshot';
  context: { flow: string; platform: string; phase: string; step: string; subStep?: string; taskExecutionId?: string };
  payload: Record<string, any>;
}

export class MaintenanceCollector {
  private buffer: ProbeEvent[] = [];
  private running = false;
  private flushTimer: NodeJS.Timeout | null = null;

  async startConsuming(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.flushTimer = setInterval(() => { void this.flushNow(); }, 5000);
    void this.consumeLoop();
    logger.info('MaintenanceCollector consuming started');
  }

  async stopConsuming(): Promise<void> {
    this.running = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushNow();
  }

  private async consumeLoop(): Promise<void> {
    const redis = getRedis();
    while (this.running) {
      try {
        const item = await redis.brpop(PROBE_CHANNEL, BRPOP_TIMEOUT_SEC);
        if (item) {
          const evt: ProbeEvent = JSON.parse(item[1]);
          await this.ingestOne(evt);
          if (this.buffer.length >= FLUSH_BATCH) await this.flushNow();
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, 'BRPOP failed, retrying in 1s');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // 测试入口：直接注入单条事件
  async ingestOne(evt: ProbeEvent): Promise<void> {
    this.buffer.push(evt);
  }

  async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    // 按 taskExecutionId + step 聚合，upsert maintenance_step
    for (const evt of events) {
      try {
        await this.persistEvent(evt);
      } catch (err: any) {
        logger.warn({ err: err.message, type: evt.type }, 'persist event failed (non-fatal)');
      }
    }
  }

  private async persistEvent(evt: ProbeEvent): Promise<void> {
    const { context, payload, type } = evt;
    if (!context.taskExecutionId) return; // 无执行关联，丢弃

    const execution = await prisma.maintenanceExecution.findUnique({
      where: { taskExecutionId: context.taskExecutionId },
    });
    if (!execution) return; // 执行未建（探针先于 startExecution），缓冲丢弃

    // upsert step by (executionId, phase, stepName, subStepName)
    const step = await prisma.maintenanceStep.upsert({
      where: {
        // 无自然唯一约束，用 findFirst + create 模式
        ...(await this.findStepWhere(execution.id, context)),
      } as any,
      create: {
        executionId: execution.id,
        phase: context.phase,
        stepName: context.step,
        subStepName: context.subStep ?? null,
        healthStatus: 'healthy',
      },
      update: {},
    }).catch(async () => {
      // upsert where 不支持组合键，回退到 findFirst + create
      return this.findOrCreateStep(execution.id, context);
    });

    if (type === 'selector' || type === 'bypass') {
      await prisma.maintenanceSelectorRecord.create({
        data: {
          stepId: step.id,
          selectorKey: payload.selectorKey ?? payload.method ?? context.step,
          selectorUsed: payload.selectorUsed ?? payload.method ?? '',
          selectorSource: payload.selectorSource ?? 'bypass_detected',
          result: payload.result ?? 'bypass_detected',
          durationMs: payload.durationMs ?? null,
          elementTag: payload.elementTag ?? null,
          elementText: payload.elementText ?? null,
          isVisible: payload.isVisible ?? null,
          isHoneypotBlocked: payload.isHoneypotBlocked ?? null,
          honeypotReason: payload.honeypotReason ?? null,
          scopeSelector: payload.scopeSelector ?? null,
          scopeMatchTimeMs: payload.scopeMatchTimeMs ?? null,
          errorMessage: payload.errorMessage ?? (payload.stack ? String(payload.stack).slice(0, 1000) : null),
        },
      });
    } else if (type === 'url') {
      await prisma.maintenanceUrlRecord.create({
        data: {
          stepId: step.id,
          healthKey: payload.healthKey ?? null,
          urlPattern: payload.urlPattern ?? '',
          actualUrl: payload.actualUrl ?? null,
          httpStatus: payload.httpStatus ?? null,
          result: payload.result ?? 'no_match',
          validationStep: payload.validationStep ?? null,
          itemsFound: payload.itemsFound ?? null,
          hasMore: payload.hasMore ?? null,
          cursorValue: payload.cursorValue ?? null,
          extractionValid: payload.extractionValid ?? null,
          missingFields: payload.missingFields ?? null,
          requestParams: payload.requestParams ? JSON.stringify(payload.requestParams) : null,
          videoId: payload.videoId ?? null,
          commentCid: payload.commentCid ?? null,
          durationMs: payload.durationMs ?? null,
          responseSize: payload.responseSize ?? null,
        },
      });
    } else if (type === 'snapshot') {
      await prisma.debugSnapshot.create({
        data: {
          stepId: step.id,
          snapshotType: payload.snapshotType,
          selectorKey: payload.selectorKey ?? null,
          urlPattern: payload.urlPattern ?? null,
          content: payload.content,
          contentSize: payload.content.length,
          mimeType: payload.mimeType ?? null,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      });
    }
  }

  private async findStepWhere(_execId: string, _ctx: ProbeEvent['context']) {
    return {}; // placeholder — 实际用 findOrCreateStep
  }

  private async findOrCreateStep(executionId: string, ctx: ProbeEvent['context']) {
    const existing = await prisma.maintenanceStep.findFirst({
      where: { executionId, phase: ctx.phase, stepName: ctx.step, subStepName: ctx.subStep ?? null },
    });
    if (existing) return existing;
    return prisma.maintenanceStep.create({
      data: {
        executionId,
        phase: ctx.phase,
        stepName: ctx.step,
        subStepName: ctx.subStep ?? null,
        healthStatus: 'healthy',
      },
    });
  }

  async summarizeExecution(taskExecutionId: string): Promise<void> {
    const execution = await prisma.maintenanceExecution.findUnique({
      where: { taskExecutionId },
      include: {
        steps: {
          include: { selectorRecords: true, urlRecords: true },
        },
      },
    });
    if (!execution) return;

    let totalSelectors = 0, passedSelectors = 0, failedSelectors = 0;
    let totalUrlChecks = 0, passedUrlChecks = 0;
    let healthySteps = 0, degradedSteps = 0, failedSteps = 0;

    for (const step of execution.steps) {
      const selFails = step.selectorRecords.filter(r => r.result !== 'found').length;
      const selTotal = step.selectorRecords.length;
      const urlFails = step.urlRecords.filter(r => r.result !== 'matched').length;
      const urlTotal = step.urlRecords.length;

      totalSelectors += selTotal;
      passedSelectors += selTotal - selFails;
      failedSelectors += selFails;
      totalUrlChecks += urlTotal;
      passedUrlChecks += urlTotal - urlFails;

      let stepHealth = 'healthy';
      if (selFails > 0 || urlFails > 0) stepHealth = selFails > 0 || urlFails === urlTotal ? 'failed' : 'degraded';
      // 有任何 failed 选择器 → failed；否则有 degraded url → degraded
      const hasFail = step.selectorRecords.some(r => ['not_found', 'timeout', 'error', 'honeypot_blocked', 'scope_not_found'].includes(r.result))
        || step.urlRecords.some(r => ['no_match', 'timeout', 'extraction_failed', 'validation_failed'].includes(r.result));
      const hasDegraded = step.urlRecords.some(r => r.result === 'validation_failed');
      stepHealth = hasFail ? 'failed' : (hasDegraded ? 'degraded' : 'healthy');

      if (stepHealth === 'healthy') healthySteps++;
      else if (stepHealth === 'degraded') degradedSteps++;
      else failedSteps++;

      await prisma.maintenanceStep.update({
        where: { id: step.id },
        data: {
          healthStatus: stepHealth,
          selectorCount: selTotal,
          selectorPassed: selTotal - selFails,
          urlCount: urlTotal,
          urlPassed: urlTotal - urlFails,
        },
      });
    }

    const overall = failedSteps > 0 ? 'failed' : (degradedSteps > 0 ? 'degraded' : 'healthy');
    await prisma.maintenanceExecution.update({
      where: { id: execution.id },
      data: {
        totalSteps: execution.steps.length,
        healthySteps, degradedSteps, failedSteps,
        totalSelectors, passedSelectors, failedSelectors,
        totalUrlChecks, passedUrlChecks,
        overallHealth: overall,
        completedAt: new Date(),
      },
    });
  }
}

export const maintenanceCollector = new MaintenanceCollector();
```

> 注：`findStepWhere`/upsert 组合键方案较脆弱，实现中以 `findOrCreateStep`（findFirst+create）为主路径，`persistEvent` 内直接调 `findOrCreateStep`。执行者应将 `persistEvent` 中的 `step = await prisma.maintenanceStep.upsert(...)` 简化为 `const step = await this.findOrCreateStep(execution.id, context);`（去掉 upsert 分支）。

- [ ] **Step 4: 简化 persistEvent（移除 upsert 分支）**

将 Step 3 实现中 `persistEvent` 的 step 获取改为：

```typescript
    const step = await this.findOrCreateStep(execution.id, context);
```

并删除 `findStepWhere` 占位方法。

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/services/maintenanceCollector.test.ts
```
Expected: PASS（3 个用例）。

- [ ] **Step 6: 在 gateway 入口启动消费**

Modify: `apps/ts-api-gateway/src/index.ts`

在 import 区（Worker import 附近，约第 40 行后）追加：

```typescript
import { maintenanceCollector } from './services/maintenanceCollector';
```

在 `app.listen` 回调内（`startCleanupScheduler();` 之后）追加：

```typescript
  // 启动维护调试数据收集器（消费 probe_events）
  void maintenanceCollector.startConsuming();
```

在进程退出处理区（`process.on('SIGTERM'`/`SIGINT` 附近，若无则在文件末尾追加）加优雅停止：

```typescript
process.on('SIGTERM', async () => {
  await maintenanceCollector.stopConsuming();
});
```

- [ ] **Step 7: Commit**

```bash
git add apps/ts-api-gateway/src/services/maintenanceCollector.ts apps/ts-api-gateway/src/services/maintenanceCollector.test.ts apps/ts-api-gateway/src/index.ts
git commit -m "feat(gateway): MaintenanceCollector — Redis BRPOP consume + flush + summarize

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: ConfigSnapshotService — 配置快照 CAS 回滚 + 导出/导入

**Files:**
- Create: `apps/ts-api-gateway/src/services/configSnapshotService.ts`
- Test: `apps/ts-api-gateway/src/services/configSnapshotService.test.ts`

> 设计：`createSnapshot`/`listSnapshots`/`rollback`（CAS 乐观锁，回滚=创建新版本+旧 active 置 inactive）/`export`/`import`。CAS 用读取时 `currentVersion` 比对，回滚时 `UPDATE ... WHERE version = $v` 原子操作（用 `prisma.updateMany` 计数判断是否被并发改）。配置数据源：现有 `selectors.json`（经 `getSelectorReader`）。

- [ ] **Step 1: 写失败测试**

Create: `apps/ts-api-gateway/src/services/configSnapshotService.test.ts`

```typescript
import { ConfigSnapshotService } from './configSnapshotService';
import { prisma } from '../lib/prisma';

describe('ConfigSnapshotService', () => {
  let svc: ConfigSnapshotService;
  beforeEach(() => { svc = new ConfigSnapshotService(); });
  afterEach(async () => {
    await prisma.configSnapshot.deleteMany({});
  });
  afterAll(async () => await prisma.$disconnect());

  it('createSnapshot stores config and marks active', async () => {
    const snap = await svc.createSnapshot({
      platform: 'douyin', configType: 'selectors',
      snapshotName: 'baseline', configData: '{"v":1}', createdBy: 'tester',
    });
    expect(snap.isActive).toBe(true);
    expect(snap.version).toBe(1);
  });

  it('creating a new active snapshot deactivates previous active', async () => {
    await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'a', configData: '{}', createdBy: 't' });
    const second = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'b', configData: '{}', createdBy: 't' });
    const actives = await prisma.configSnapshot.findMany({ where: { platform: 'douyin', configType: 'selectors', isActive: true } });
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(second.id);
  });

  it('rollback creates a new version copying target configData', async () => {
    const v1 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{"x":1}', createdBy: 't' });
    const v2 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v2', configData: '{"x":2}', createdBy: 't' });
    const rolled = await svc.rollback({ platform: 'douyin', configType: 'selectors', snapshotId: v1.id, currentVersion: v2.version });
    expect(rolled.configData).toBe('{"x":1}');
    expect(rolled.version).toBe(v2.version + 1);
    expect(rolled.isActive).toBe(true);
  });

  it('rollback throws ConflictError when currentVersion stale', async () => {
    const v1 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{}', createdBy: 't' });
    await expect(
      svc.rollback({ platform: 'douyin', configType: 'selectors', snapshotId: v1.id, currentVersion: 999 }),
    ).rejects.toThrow(/已被其他人修改|Conflict/);
  });

  it('export returns active config as JSON object', async () => {
    await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'e', configData: '{"k":"v"}', createdBy: 't' });
    const exported = await svc.exportConfig('douyin', 'selectors');
    expect(exported).toEqual({ k: 'v' });
  });

  it('import validates JSON and creates snapshot', async () => {
    const snap = await svc.importConfig({ platform: 'douyin', configType: 'selectors', configData: { a: 1 }, snapshotName: 'imp', createdBy: 't' });
    expect(snap.configData).toBe(JSON.stringify({ a: 1 }));
    await expect(svc.importConfig({ platform: 'douyin', configType: 'selectors', configData: null as any, snapshotName: 'bad', createdBy: 't' }))
      .rejects.toThrow(/invalid|格式/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/services/configSnapshotService.test.ts
```
Expected: FAIL — `Cannot find module './configSnapshotService'`。

- [ ] **Step 3: 实现 ConfigSnapshotService**

Create: `apps/ts-api-gateway/src/services/configSnapshotService.ts`

```typescript
// @ts-api-gateway/services/configSnapshotService.ts
// 配置快照：CAS 乐观锁回滚（版本链，不物理覆盖）+ 导出/导入。

import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('config-snapshot');

export class ConflictError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ConflictError'; }
}

export class ConfigSnapshotService {
  async createSnapshot(input: {
    platform: string; configType: string; snapshotName: string;
    configData: string; createdBy?: string; description?: string;
  }) {
    const active = await prisma.configSnapshot.findFirst({
      where: { platform: input.platform, configType: input.configType, isActive: true },
    });
    // 旧 active 置 inactive（事务）
    return prisma.$transaction(async (tx) => {
      if (active) {
        await tx.configSnapshot.update({ where: { id: active.id }, data: { isActive: false } });
      }
      return tx.configSnapshot.create({
        data: {
          snapshotName: input.snapshotName,
          platform: input.platform,
          configType: input.configType,
          configData: input.configData,
          version: (active?.version ?? 0) + 1,
          createdBy: input.createdBy ?? 'system',
          description: input.description ?? '',
          isActive: true,
        },
      });
    });
  }

  async listSnapshots(platform: string, configType?: string) {
    return prisma.configSnapshot.findMany({
      where: { platform, ...(configType ? { configType } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async rollback(input: {
    platform: string; configType: string; snapshotId: string; currentVersion: number;
  }) {
    const target = await prisma.configSnapshot.findUnique({ where: { id: input.snapshotId } });
    if (!target) throw new Error('snapshot not found');

    const active = await prisma.configSnapshot.findFirst({
      where: { platform: input.platform, configType: input.configType, isActive: true },
    });

    // CAS 检查：调用方持有的版本必须等于当前 active 版本
    if (active && active.version !== input.currentVersion) {
      throw new ConflictError('配置已被其他人修改，请刷新后重试');
    }

    return prisma.$transaction(async (tx) => {
      if (active) {
        // CAS 原子：仅当 version 未变才置 inactive
        const updated = await tx.configSnapshot.updateMany({
          where: { id: active.id, version: active.version },
          data: { isActive: false },
        });
        if (updated.count === 0) {
          throw new ConflictError('配置已被其他人修改，请刷新后重试');
        }
      }
      return tx.configSnapshot.create({
        data: {
          snapshotName: `回滚自 ${target.snapshotName}`,
          platform: input.platform,
          configType: input.configType,
          configData: target.configData,
          version: (active?.version ?? 0) + 1,
          createdBy: 'rollback',
          description: `回滚到快照 ${input.snapshotId}`,
          isActive: true,
        },
      });
    });
  }

  async exportConfig(platform: string, configType: string): Promise<any> {
    const active = await prisma.configSnapshot.findFirst({
      where: { platform, configType, isActive: true },
    });
    if (!active) throw new Error(`no active snapshot for ${platform}/${configType}`);
    return JSON.parse(active.configData);
  }

  async importConfig(input: {
    platform: string; configType: string; configData: any; snapshotName: string; createdBy?: string;
  }) {
    let dataStr: string;
    try {
      // 必须是可序列化对象
      dataStr = JSON.stringify(input.configData);
      JSON.parse(dataStr); // round-trip 校验
    } catch {
      throw new Error('invalid config data: 格式非法 JSON');
    }
    return this.createSnapshot({
      platform: input.platform,
      configType: input.configType,
      snapshotName: input.snapshotName,
      configData: dataStr,
      createdBy: input.createdBy ?? 'import',
      description: '导入配置',
    });
  }
}

export const configSnapshotService = new ConfigSnapshotService();
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/services/configSnapshotService.test.ts
```
Expected: PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/services/configSnapshotService.ts apps/ts-api-gateway/src/services/configSnapshotService.test.ts
git commit -m "feat(gateway): ConfigSnapshotService — CAS rollback + export/import

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: MaintenanceCollector 在 startExecution 时建 maintenance_execution 记录

**Files:**
- Modify: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`
- Test: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts`（扩展现有）

> 设计：`startExecution` 创建 `TaskExecution` 后，同步创建 `MaintenanceExecution`（1:1，`taskExecutionId` 唯一）。`finishExecution` 调 `maintenanceCollector.summarizeExecution(executionId)`。`recordSelectorTry` 改为**仅**经探针路径（不再直接写 `selectorTries`——见 Task 21 完整迁移；本 Task 仅建关联 + 汇总钩子，保留 selectorTries 写入以免破坏现有行为）。

- [ ] **Step 1: 扩展现有测试**

在 `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts` 末尾追加（保留现有用例）：

```typescript
import { prisma } from './prisma';

describe('taskExecutionRecorder → maintenance linkage', () => {
  afterAll(async () => {
    await prisma.maintenanceExecution.deleteMany({});
    await prisma.taskExecution.deleteMany({});
    await prisma.$disconnect();
  });

  it('startExecution creates a linked MaintenanceExecution', async () => {
    const id = await startExecution(
      { taskId: 'job-1', taskType: 'monitor', windowId: 'w1', platform: 'douyin', userId: 1 } as any,
      { updateProgress: async () => {} } as any,
    );
    const maint = await prisma.maintenanceExecution.findUnique({ where: { taskExecutionId: id } });
    expect(maint).not.toBeNull();
    expect(maint!.platform).toBe('douyin');
    expect(maint!.flowType).toBe('monitor');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/lib/taskExecutionRecorder.test.ts
```
Expected: FAIL — `maint` 为 null（startExecution 未建 maintenance 记录）。

- [ ] **Step 3: 在 startExecution 末尾建 maintenance 记录**

Modify: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`

顶部 import 区追加：

```typescript
import { prisma } from './prisma'; // 若已存在则跳过
```

在 `startExecution` 函数内 `logger.info(...)` 之后、`return execution.id;` 之前追加：

```typescript
  // 维护调试：1:1 关联 MaintenanceExecution
  try {
    await prisma.maintenanceExecution.create({
      data: {
        taskExecutionId: execution.id,
        platform: (task as any).platform || 'unknown',
        flowType: task.taskType,
        windowId: task.windowId,
        userId: (task as any).userId ?? null,
      },
    });
  } catch (err: any) {
    logger.warn({ executionId: execution.id, error: err.message }, 'create MaintenanceExecution failed (non-fatal)');
  }
```

在 `finishExecution` 函数内 `prisma.taskExecution.update(...)` 之后追加（汇总钩子）：

```typescript
  // 维护调试：汇总健康数据
  try {
    const { maintenanceCollector } = await import('../services/maintenanceCollector');
    await maintenanceCollector.summarizeExecution(executionId);
  } catch (err: any) {
    logger.warn({ executionId, error: err.message }, 'summarizeExecution failed (non-fatal)');
  }
```

> 注：用动态 `import` 避免循环依赖（`maintenanceCollector` import `prisma` 与本文件同模块，静态 import 安全，但动态 import 更稳妥）。若 lint 报 `@typescript-eslint/no-dynamic-import`，改为顶部静态 `import { maintenanceCollector } from '../services/maintenanceCollector';`。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/lib/taskExecutionRecorder.test.ts
```
Expected: PASS（含新用例 + 原有用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts
git commit -m "feat(recorder): link MaintenanceExecution on start + summarize on finish

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: 维护路由 — 执行健康报告 + 选择器健康 + Debug 快照

**Files:**
- Create: `apps/ts-api-gateway/src/routes/maintenance.ts`
- Test: `apps/ts-api-gateway/src/routes/maintenance.test.ts`

> 覆盖 spec 7.1/7.2/7.3：
> - `GET /executions`（筛选 platform/healthStatus/flowType/时间范围，分页）
> - `GET /executions/:id`（摘要 + steps 概览）
> - `GET /executions/:id/steps`（steps + selectorRecords + urlRecords）
> - `GET /selectors/health`（按 platform/selectorKey 聚合：总次数/成功率/主选择器率/降级率）
> - `GET /selectors/:key/history`（单选择器历史趋势）
> - `GET /snapshots/:stepId`（某步骤 debug 快照，经 `sanitizeSnapshot` 不再二次清洗——入库时已清洗）

- [ ] **Step 1: 写失败测试**

Create: `apps/ts-api-gateway/src/routes/maintenance.test.ts`

```typescript
import request from 'supertest';
import express, { Express } from 'express';
import maintenanceRouter from './maintenance';
import { prisma } from '../lib/prisma';

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/maintenance', maintenanceRouter);
  return a;
}

async function seed() {
  const exec = await prisma.maintenanceExecution.create({
    data: { taskExecutionId: 'exec-r1', platform: 'douyin', flowType: 'monitor', windowId: 'w1', overallHealth: 'degraded', userId: 1 },
  });
  const step = await prisma.maintenanceStep.create({
    data: { executionId: exec.id, phase: 'phase1', stepName: 'expandMenu', healthStatus: 'healthy' },
  });
  await prisma.maintenanceSelectorRecord.create({
    data: { stepId: step.id, selectorKey: 'menu_home', selectorUsed: '#h', selectorSource: 'primary', result: 'found', durationMs: 5 },
  });
  await prisma.maintenanceSelectorRecord.create({
    data: { stepId: step.id, selectorKey: 'menu_home', selectorUsed: '.fb', selectorSource: 'fallback_1', result: 'found', durationMs: 8 },
  });
  return { exec, step };
}

describe('maintenance routes', () => {
  afterEach(async () => {
    await prisma.maintenanceSelectorRecord.deleteMany({});
    await prisma.maintenanceUrlRecord.deleteMany({});
    await prisma.debugSnapshot.deleteMany({});
    await prisma.maintenanceStep.deleteMany({});
    await prisma.maintenanceExecution.deleteMany({});
  });
  afterAll(async () => await prisma.$disconnect());

  it('GET /executions returns list with filters', async () => {
    await seed();
    const res = await request(app()).get('/api/v1/maintenance/executions?platform=douyin&healthStatus=degraded');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].platform).toBe('douyin');
  });

  it('GET /executions/:id returns summary + steps', async () => {
    const { exec } = await seed();
    const res = await request(app()).get(`/api/v1/maintenance/executions/${exec.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.execution.id).toBe(exec.id);
    expect(res.body.data.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /executions/:id/steps returns step detail with selector/url records', async () => {
    const { exec, step } = await seed();
    const res = await request(app()).get(`/api/v1/maintenance/executions/${exec.id}/steps`);
    expect(res.status).toBe(200);
    const s = res.body.data.steps.find((x: any) => x.id === step.id);
    expect(s.selectorRecords).toHaveLength(2);
  });

  it('GET /selectors/health aggregates success/degradation rate', async () => {
    await seed();
    const res = await request(app()).get('/api/v1/maintenance/selectors/health?platform=douyin');
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.selectorKey === 'menu_home');
    expect(row.totalCount).toBe(2);
    expect(row.successRate).toBe(1); // 2/2 found
    expect(row.degradationRate).toBe(0.5); // 1 fallback / 2 total
  });

  it('GET /selectors/:key/history returns trend', async () => {
    await seed();
    const res = await request(app()).get('/api/v1/maintenance/selectors/menu_home/history?platform=douyin');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /snapshots/:stepId returns debug snapshots for step', async () => {
    const { step } = await seed();
    await prisma.debugSnapshot.create({
      data: { stepId: step.id, snapshotType: 'dom', content: '<div></div>', contentSize: 11, expiresAt: new Date(Date.now() + 86400000) },
    });
    const res = await request(app()).get(`/api/v1/maintenance/snapshots/${step.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].snapshotType).toBe('dom');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts
```
Expected: FAIL — `Cannot find module './maintenance'`。

- [ ] **Step 3: 实现路由**

Create: `apps/ts-api-gateway/src/routes/maintenance.ts`

```typescript
// @ts-api-gateway/routes/maintenance.ts - 维护调试 API

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:maintenance');

/** GET /executions — 执行历史列表 */
router.get('/executions', async (req: Request, res: Response) => {
  try {
    const { platform, healthStatus, flowType, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const where: any = {};
    if (platform) where.platform = platform;
    if (healthStatus) where.overallHealth = healthStatus;
    if (flowType) where.flowType = flowType;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(String(from));
      if (to) where.startedAt.lte = new Date(String(to));
    }
    const [items, total] = await Promise.all([
      prisma.maintenanceExecution.findMany({ where, orderBy: { startedAt: 'desc' }, take: limit, skip: offset }),
      prisma.maintenanceExecution.count({ where }),
    ]);
    res.json({ success: true, data: { items, total, limit, offset } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /executions failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /executions/:id — 单次执行详情 */
router.get('/executions/:id', async (req: Request, res: Response) => {
  try {
    const execution = await prisma.maintenanceExecution.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { createdAt: 'asc' } } },
    });
    if (!execution) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, data: { execution, steps: execution.steps } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /executions/:id failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /executions/:id/steps — 子步骤详情（含选择器/URL 记录） */
router.get('/executions/:id/steps', async (req: Request, res: Response) => {
  try {
    const steps = await prisma.maintenanceStep.findMany({
      where: { executionId: req.params.id },
      orderBy: { createdAt: 'asc' },
      include: { selectorRecords: true, urlRecords: true, snapshots: true },
    });
    res.json({ success: true, data: { steps } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /executions/:id/steps failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /selectors/health — 选择器健康聚合 */
router.get('/selectors/health', async (req: Request, res: Response) => {
  try {
    const { platform } = req.query;
    const records = await prisma.maintenanceSelectorRecord.findMany({
      where: platform ? { step: { execution: { platform: String(platform) } } } : {},
      include: { step: { include: { execution: true } } },
    });
    const agg = new Map<string, { totalCount: number; foundCount: number; primaryCount: number; fallbackCount: number }>();
    for (const r of records) {
      const a = agg.get(r.selectorKey) ?? { totalCount: 0, foundCount: 0, primaryCount: 0, fallbackCount: 0 };
      a.totalCount++;
      if (r.result === 'found') a.foundCount++;
      if (r.selectorSource === 'primary') a.primaryCount++;
      else if (r.selectorSource.startsWith('fallback')) a.fallbackCount++;
      agg.set(r.selectorKey, a);
    }
    const data = Array.from(agg.entries()).map(([selectorKey, a]) => ({
      selectorKey,
      totalCount: a.totalCount,
      successRate: a.totalCount ? a.foundCount / a.totalCount : null,
      primaryRate: a.totalCount ? a.primaryCount / a.totalCount : null,
      degradationRate: a.totalCount ? a.fallbackCount / a.totalCount : null,
    }));
    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /selectors/health failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /selectors/:key/history — 单选择器历史趋势 */
router.get('/selectors/:key/history', async (req: Request, res: Response) => {
  try {
    const { platform } = req.query;
    const records = await prisma.maintenanceSelectorRecord.findMany({
      where: {
        selectorKey: req.params.key,
        ...(platform ? { step: { execution: { platform: String(platform) } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { step: { include: { execution: true } } },
    });
    const data = records.map(r => ({
      at: r.createdAt,
      result: r.result,
      selectorSource: r.selectorSource,
      executionId: r.step.executionId,
      platform: r.step.execution.platform,
    }));
    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /selectors/:key/history failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /snapshots/:stepId — 某步骤的 debug 快照 */
router.get('/snapshots/:stepId', async (req: Request, res: Response) => {
  try {
    const snapshots = await prisma.debugSnapshot.findMany({
      where: { stepId: req.params.stepId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: snapshots });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /snapshots/:stepId failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts
```
Expected: PASS（6 个用例）。

- [ ] **Step 5: 挂载路由到 gateway 入口**

Modify: `apps/ts-api-gateway/src/index.ts`

import 区追加：

```typescript
import maintenanceRouter from './routes/maintenance';
```

路由挂载区（约第 114 行 `wecomBotRouter` 后）追加：

```typescript
app.use('/api/v1/maintenance', maintenanceRouter);            // 维护调试: 健康/快照/配置
```

- [ ] **Step 6: Commit**

```bash
git add apps/ts-api-gateway/src/routes/maintenance.ts apps/ts-api-gateway/src/routes/maintenance.test.ts apps/ts-api-gateway/src/index.ts
git commit -m "feat(gateway): maintenance routes — executions/selectors/snapshots

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 维护路由 — 配置管理（快照/回滚/导出/导入）

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/maintenance.ts`
- Modify: `apps/ts-api-gateway/src/routes/maintenance.test.ts`

> 覆盖 spec 7.4：`POST/GET /config/snapshots`、`POST /config/snapshots/:id/rollback`（CAS）、`POST /config/export`、`POST /config/import`。委托 Task 10 的 `ConfigSnapshotService`。

- [ ] **Step 1: 追加路由测试**

在 `apps/ts-api-gateway/src/routes/maintenance.test.ts` 顶部 import 区追加：

```typescript
import { configSnapshotService } from '../services/configSnapshotService';
```

在文件内 `describe('maintenance routes', ...)` 之前追加新 describe：

```typescript
describe('maintenance config routes', () => {
  afterEach(async () => { await prisma.configSnapshot.deleteMany({}); });

  it('POST /config/snapshots creates a snapshot', async () => {
    const res = await request(app()).post('/api/v1/maintenance/config/snapshots')
      .send({ platform: 'douyin', configType: 'selectors', snapshotName: 'r1', configData: '{"v":1}', createdBy: 'tester' });
    expect(res.status).toBe(201);
    expect(res.body.data.isActive).toBe(true);
  });

  it('GET /config/snapshots lists snapshots', async () => {
    await configSnapshotService.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'x', configData: '{}', createdBy: 't' });
    const res = await request(app()).get('/api/v1/maintenance/config/snapshots?platform=douyin');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /config/snapshots/:id/rollback rolls back via CAS', async () => {
    const v1 = await configSnapshotService.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{"x":1}', createdBy: 't' });
    const v2 = await configSnapshotService.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v2', configData: '{"x":2}', createdBy: 't' });
    const res = await request(app()).post(`/api/v1/maintenance/config/snapshots/${v1.id}/rollback`)
      .send({ platform: 'douyin', configType: 'selectors', currentVersion: v2.version });
    expect(res.status).toBe(200);
    expect(res.body.data.configData).toBe('{"x":1}');
  });

  it('POST /config/snapshots/:id/rollback returns 409 on stale version', async () => {
    const v1 = await configSnapshotService.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{}', createdBy: 't' });
    const res = await request(app()).post(`/api/v1/maintenance/config/snapshots/${v1.id}/rollback`)
      .send({ platform: 'douyin', configType: 'selectors', currentVersion: 999 });
    expect(res.status).toBe(409);
  });

  it('POST /config/export returns active config', async () => {
    await configSnapshotService.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'e', configData: '{"k":"v"}', createdBy: 't' });
    const res = await request(app()).post('/api/v1/maintenance/config/export').send({ platform: 'douyin', configType: 'selectors' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ k: 'v' });
  });

  it('POST /config/import creates snapshot from JSON object', async () => {
    const res = await request(app()).post('/api/v1/maintenance/config/import')
      .send({ platform: 'douyin', configType: 'selectors', snapshotName: 'imp', configData: { a: 1 }, createdBy: 't' });
    expect(res.status).toBe(201);
    expect(res.body.data.configData).toBe(JSON.stringify({ a: 1 }));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts
```
Expected: 新用例 FAIL（路由不存在，404）。

- [ ] **Step 3: 追加配置路由**

在 `apps/ts-api-gateway/src/routes/maintenance.ts` 顶部 import 区追加：

```typescript
import { configSnapshotService, ConflictError } from '../services/configSnapshotService';
```

在 `export default router;` 之前追加：

```typescript
/** POST /config/snapshots — 创建配置快照 */
router.post('/config/snapshots', async (req: Request, res: Response) => {
  try {
    const { platform, configType, snapshotName, configData, createdBy, description } = req.body;
    if (!platform || !configType || !snapshotName || configData === undefined) {
      return res.status(400).json({ success: false, error: 'platform/configType/snapshotName/configData required' });
    }
    const snap = await configSnapshotService.createSnapshot({
      platform, configType, snapshotName,
      configData: typeof configData === 'string' ? configData : JSON.stringify(configData),
      createdBy, description,
    });
    res.status(201).json({ success: true, data: snap });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'POST /config/snapshots failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /config/snapshots — 快照列表 */
router.get('/config/snapshots', async (req: Request, res: Response) => {
  try {
    const { platform, configType } = req.query;
    const data = await configSnapshotService.listSnapshots(String(platform ?? ''), configType ? String(configType) : undefined);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /config/snapshots/:id/rollback — 回滚（CAS 乐观锁） */
router.post('/config/snapshots/:id/rollback', async (req: Request, res: Response) => {
  try {
    const { platform, configType, currentVersion } = req.body;
    const rolled = await configSnapshotService.rollback({
      platform, configType, snapshotId: req.params.id, currentVersion: Number(currentVersion),
    });
    res.json({ success: true, data: rolled });
  } catch (err) {
    if (err instanceof ConflictError) return res.status(409).json({ success: false, error: err.message });
    logger.error({ err: (err as Error).message }, 'rollback failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /config/export — 导出活跃配置 */
router.post('/config/export', async (req: Request, res: Response) => {
  try {
    const { platform, configType } = req.body;
    const data = await configSnapshotService.exportConfig(platform, configType);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /config/import — 导入配置 */
router.post('/config/import', async (req: Request, res: Response) => {
  try {
    const { platform, configType, snapshotName, configData, createdBy } = req.body;
    const snap = await configSnapshotService.importConfig({ platform, configType, snapshotName, configData, createdBy });
    res.status(201).json({ success: true, data: snap });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts
```
Expected: PASS（6 + 6 = 12 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/routes/maintenance.ts apps/ts-api-gateway/src/routes/maintenance.test.ts
git commit -m "feat(gateway): maintenance config routes — snapshot/rollback/export/import

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: 维护路由 — 单点验证 & 重试

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/maintenance.ts`
- Modify: `apps/ts-api-gateway/src/routes/maintenance.test.ts`

> 覆盖 spec 7.5：`POST /verify/selector`（在指定 windowId 的页面上测试选择器是否命中，复用 `HumanActions.findInScope`）、`POST /verify/url`（测试拦截规则是否匹配——用 `RequestInterceptor.setValidationConfig` + 模拟请求 URL 比对）、`POST /retry/step`（子步骤级重跑——重新入队该子步骤对应的任务，复用 `unifiedQueue`）。
>
> 这三个端点涉及浏览器实时操作，测试以 service 层 mock 为主，路由测试验证参数校验与错误处理。

- [ ] **Step 1: 追加路由测试**

在 `apps/ts-api-gateway/src/routes/maintenance.test.ts` 追加新 describe：

```typescript
describe('maintenance verify/retry routes', () => {
  it('POST /verify/selector requires windowId + selectorKey', async () => {
    const res = await request(app()).post('/api/v1/maintenance/verify/selector').send({ platform: 'douyin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/windowId|selectorKey|required/);
  });

  it('POST /verify/url requires urlPattern + actualUrl', async () => {
    const res = await request(app()).post('/api/v1/maintenance/verify/url').send({ urlPattern: '/x' });
    expect(res.status).toBe(400);
  });

  it('POST /verify/url matches a URL against pattern and returns matched=true', async () => {
    const res = await request(app()).post('/api/v1/maintenance/verify/url')
      .send({ urlPattern: '\\/aweme\\/v1\\/web\\/aweme\\/post', actualUrl: 'https://x/aweme/v1/web/aweme/post?sec_user_id=y' });
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(true);
  });

  it('POST /verify/url returns matched=false on no match', async () => {
    const res = await request(app()).post('/api/v1/maintenance/verify/url')
      .send({ urlPattern: '\\/nope', actualUrl: 'https://x/other' });
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(false);
  });

  it('POST /retry/step requires executionId + stepId', async () => {
    const res = await request(app()).post('/api/v1/maintenance/retry/step').send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts -t "verify/retry"
```
Expected: FAIL（路由 404）。

- [ ] **Step 3: 追加 verify/retry 路由**

在 `apps/ts-api-gateway/src/routes/maintenance.ts` 顶部 import 区追加：

```typescript
import { BrowserManager, HumanActions } from '@social-media/browser-core';
import { SelectorRegistry } from '@social-media/browser-core';
import { unifiedQueue } from '../services/unifiedQueue';
```

在 `export default router;` 之前追加：

```typescript
/** POST /verify/selector — 单选择器验证（在指定窗口页面上测试命中） */
router.post('/verify/selector', async (req: Request, res: Response) => {
  try {
    const { windowId, platform, selectorPath, vars } = req.body;
    if (!windowId || !selectorPath) {
      return res.status(400).json({ success: false, error: 'windowId and selectorKey required' });
    }
    const config = SelectorRegistry.get(selectorPath);
    if (!config) return res.status(404).json({ success: false, error: 'selector not found in registry' });

    const { page } = await BrowserManager.connect(windowId, 'verify', platform ?? config.platform);
    const start = Date.now();
    try {
      const result = await HumanActions.findInScope(page as any, config, vars ?? {});
      res.json({
        success: true,
        data: { ...result, durationMs: Date.now() - start, selectorUsed: config.primary },
      });
    } finally {
      // 不主动 disconnect，保持会话复用
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'verify/selector failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /verify/url — 单 URL 验证（测试拦截规则是否匹配） */
router.post('/verify/url', async (req: Request, res: Response) => {
  try {
    const { urlPattern, actualUrl } = req.body;
    if (!urlPattern || !actualUrl) {
      return res.status(400).json({ success: false, error: 'urlPattern and actualUrl required' });
    }
    // glob → regex 简化：直接当 regex 试，失败则按 includes
    let matched = false;
    try {
      matched = new RegExp(urlPattern).test(actualUrl);
    } catch {
      matched = actualUrl.includes(urlPattern);
    }
    res.json({ success: true, data: { matched, urlPattern, actualUrl } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /retry/step — 子步骤级重试（重新入队任务） */
router.post('/retry/step', async (req: Request, res: Response) => {
  try {
    const { executionId, stepId } = req.body;
    if (!executionId || !stepId) {
      return res.status(400).json({ success: false, error: 'executionId and stepId required' });
    }
    const exec = await prisma.taskExecution.findUnique({ where: { id: executionId } });
    if (!exec) return res.status(404).json({ success: false, error: 'execution not found' });

    // 重新入队同类型任务（子步骤级精确重跑需流程引擎支持，当前以整任务重试为兜底）
    const job = await unifiedQueue.add(`${exec.platform}:${exec.taskType}:retry`, {
      taskId: `${exec.taskId}:retry:${Date.now()}`,
      taskType: exec.taskType,
      platform: exec.platform,
      userId: exec.userId ?? undefined,
      windowId: exec.windowId,
      retryFromStepId: stepId,
    });
    res.json({ success: true, data: { jobId: job.id, executionId } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'retry/step failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

> 注：`unifiedQueue.add` 的具体签名以 `apps/ts-api-gateway/src/services/unifiedQueue.ts` 为准。执行者需 `grep -nE "export.*unifiedQueue|\.add\(" apps/ts-api-gateway/src/services/unifiedQueue.ts` 确认队列名与 job 数据结构，对齐 `PlatformTask` 类型。若 `retryFromStepId` 不被现有 worker 识别，本端点退化为"整任务重试 + 标记"，并在响应中注明。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/routes/maintenance.test.ts
```
Expected: PASS（全部用例）。`verify/selector` 因需真实浏览器，测试未覆盖其成功路径——路由测试仅校验参数；端到端在 Task 22 验证。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/routes/maintenance.ts apps/ts-api-gateway/src/routes/maintenance.test.ts
git commit -m "feat(gateway): maintenance verify/retry routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: admin-dashboard — 维护 API hooks + 主页面骨架 + 执行健康/详情 Tab

**Files:**
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts`（追加 maintenance hooks）
- Create: `apps/admin-dashboard/src/app/maintenance/page.tsx`
- Create: `apps/admin-dashboard/src/app/maintenance/ExecutionHealthTab.tsx`
- Create: `apps/admin-dashboard/src/app/maintenance/ExecutionDetailTab.tsx`
- Create: `apps/admin-dashboard/src/app/maintenance/components.tsx`

> 设计：主页面是 Tab 容器（执行健康/执行详情/选择器健康/配置管理）。`ExecutionHealthTab` 列表 + 筛选（platform/healthStatus/flowType/时间），点击行进入 `ExecutionDetailTab`（树形展开 phase→step→selector/url 记录，含健康徽章）。复用 `BentoCard`/`StatusPill`/`MaterialIcon`。UI 不写自动化测试（与现有页面一致，靠手动验证），但需 `pnpm --filter admin-dashboard build` 通过。

- [ ] **Step 1: 追加 maintenance hooks**

在 `apps/admin-dashboard/src/hooks/useApi.ts` 末尾追加：

```typescript
// ============================================================
// 维护调试 API
// ============================================================

export type MaintenanceHealth = 'healthy' | 'degraded' | 'failed';

export interface MaintenanceExecution {
  id: string;
  taskExecutionId: string;
  platform: string;
  flowType: string;
  windowId: string;
  overallHealth: MaintenanceHealth;
  totalSteps: number;
  healthySteps: number;
  degradedSteps: number;
  failedSteps: number;
  totalSelectors: number;
  passedSelectors: number;
  failedSelectors: number;
  totalUrlChecks: number;
  passedUrlChecks: number;
  startedAt: string;
  completedAt: string | null;
}

export function useMaintenanceExecutions(params: {
  platform?: string; healthStatus?: MaintenanceHealth; flowType?: string; limit?: number; offset?: number;
}) {
  const qs = new URLSearchParams();
  if (params.platform) qs.set('platform', params.platform);
  if (params.healthStatus) qs.set('healthStatus', params.healthStatus);
  if (params.flowType) qs.set('flowType', params.flowType);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  return useQuery({
    queryKey: ['maintenance', 'executions', params],
    queryFn: () => api.get(`/maintenance/executions?${qs.toString()}`).then(r => r.data),
  });
}

export function useMaintenanceExecutionDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['maintenance', 'execution', id],
    queryFn: () => api.get(`/maintenance/executions/${id}`).then(r => r.data),
  });
}

export function useMaintenanceSteps(executionId: string | null) {
  return useQuery({
    enabled: !!executionId,
    queryKey: ['maintenance', 'steps', executionId],
    queryFn: () => api.get(`/maintenance/executions/${executionId}/steps`).then(r => r.data),
  });
}

export function useSelectorHealth(platform?: string) {
  const qs = platform ? `?platform=${platform}` : '';
  return useQuery({
    queryKey: ['maintenance', 'selectors', 'health', platform],
    queryFn: () => api.get(`/maintenance/selectors/health${qs}`).then(r => r.data),
  });
}

export function useRetryStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { executionId: string; stepId: string }) =>
      api.post('/maintenance/retry/step', body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });
}
```

- [ ] **Step 2: 创建共享组件**

Create: `apps/admin-dashboard/src/app/maintenance/components.tsx`

```tsx
'use client';

import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { cn } from '@/lib/utils';
import type { MaintenanceHealth } from '@/hooks/useApi';

const HEALTH_META: Record<MaintenanceHealth, { label: string; icon: string; cls: string }> = {
  healthy: { label: '健康', icon: 'check_circle', cls: 'bg-emerald-500/15 text-emerald-300' },
  degraded: { label: '降级', icon: 'warning', cls: 'bg-amber-500/15 text-amber-300' },
  failed: { label: '失败', icon: 'error', cls: 'bg-rose-500/15 text-rose-300' },
};

export function HealthBadge({ health }: { health: MaintenanceHealth }) {
  const m = HEALTH_META[health] ?? HEALTH_META.healthy;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', m.cls)}>
      <MaterialIcon icon={m.icon} className="text-sm" />
      {m.label}
    </span>
  );
}

export function SelectorResultBadge({ result }: { result: string }) {
  const cls = result === 'found' ? 'text-emerald-300'
    : result === 'honeypot_blocked' || result === 'scope_not_found' ? 'text-amber-300'
    : 'text-rose-300';
  const icon = result === 'found' ? 'check' : result === 'bypass_detected' ? 'visibility' : 'close';
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', cls)}>
      <MaterialIcon icon={icon} className="text-sm" />
      {result}
    </span>
  );
}

const FLOW_LABEL: Record<string, string> = { monitor: '监控', publish: '发布', reply: '评论回复' };
export function FlowLabel({ flow }: { flow: string }) {
  return <>{FLOW_LABEL[flow] ?? flow}</>;
}
```

- [ ] **Step 3: 创建执行健康 Tab**

Create: `apps/admin-dashboard/src/app/maintenance/ExecutionHealthTab.tsx`

```tsx
'use client';

import { useState } from 'react';
import { useMaintenanceExecutions, type MaintenanceHealth } from '@/hooks/useApi';
import { BentoCard } from '@/components/ui/Bento';
import { HealthBadge, FlowLabel } from './components';

const PLATFORMS = ['', 'douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const HEALTHS: ('' | MaintenanceHealth)[] = ['', 'healthy', 'degraded', 'failed'];
const FLOWS = ['', 'monitor', 'publish', 'reply'];

export default function ExecutionHealthTab({ onPick }: { onPick: (id: string) => void }) {
  const [platform, setPlatform] = useState('');
  const [health, setHealth] = useState<'' | MaintenanceHealth>('');
  const [flow, setFlow] = useState('');
  const { data, isLoading } = useMaintenanceExecutions({ platform, healthStatus: health, flowType: flow, limit: 50 });

  return (
    <BentoCard className="p-4">
      <div className="mb-4 flex flex-wrap gap-3">
        <select value={platform} onChange={e => setPlatform(e.target.value)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
          <option value="">全部平台</option>
          {PLATFORMS.slice(1).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={health} onChange={e => setHealth(e.target.value as any)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
          <option value="">全部状态</option>
          {HEALTHS.slice(1).map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <select value={flow} onChange={e => setFlow(e.target.value)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
          <option value="">全部类型</option>
          {FLOWS.slice(1).map(f => <option key={f} value={f}><FlowLabel flow={f} /></option>)}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="px-2 py-1 text-left">时间</th>
              <th className="px-2 py-1 text-left">平台</th>
              <th className="px-2 py-1 text-left">类型</th>
              <th className="px-2 py-1 text-left">健康</th>
              <th className="px-2 py-1 text-left">步骤</th>
              <th className="px-2 py-1 text-left">选择器</th>
              <th className="px-2 py-1 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-2 py-4 text-center text-neutral-500">加载中…</td></tr>}
            {data?.items?.map((e: any) => (
              <tr key={e.id} className="border-t border-neutral-800 hover:bg-neutral-800/40">
                <td className="px-2 py-1">{new Date(e.startedAt).toLocaleString()}</td>
                <td className="px-2 py-1">{e.platform}</td>
                <td className="px-2 py-1"><FlowLabel flow={e.flowType} /></td>
                <td className="px-2 py-1"><HealthBadge health={e.overallHealth} /></td>
                <td className="px-2 py-1">{e.healthySteps}/{e.totalSteps}</td>
                <td className="px-2 py-1">{e.passedSelectors}/{e.totalSelectors}</td>
                <td className="px-2 py-1">
                  <button onClick={() => onPick(e.id)} className="text-sky-400 hover:underline">详情</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BentoCard>
  );
}
```

- [ ] **Step 4: 创建执行详情 Tab**

Create: `apps/admin-dashboard/src/app/maintenance/ExecutionDetailTab.tsx`

```tsx
'use client';

import { useMaintenanceExecutionDetail, useMaintenanceSteps, useRetryStep } from '@/hooks/useApi';
import { BentoCard } from '@/components/ui/Bento';
import { HealthBadge, FlowLabel, SelectorResultBadge } from './components';

export default function ExecutionDetailTab({ executionId, onBack }: { executionId: string; onBack: () => void }) {
  const { data: detail } = useMaintenanceExecutionDetail(executionId);
  const { data: stepsData } = useMaintenanceSteps(executionId);
  const retry = useRetryStep();
  const exec = detail?.execution;

  return (
    <BentoCard className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-neutral-400 hover:text-neutral-200">← 返回</button>
        {exec && (
          <span className="text-sm text-neutral-300">
            执行 #{exec.id.slice(-6)} — {exec.platform} — <FlowLabel flow={exec.flowType} /> — {new Date(exec.startedAt).toLocaleString()} — <HealthBadge health={exec.overallHealth} />
          </span>
        )}
      </div>

      <div className="space-y-3">
        {stepsData?.steps?.map((step: any) => (
          <div key={step.id} className="rounded-lg border border-neutral-800 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <HealthBadge health={step.healthStatus} />
              <span className="text-neutral-300">{step.phase} / {step.stepName}</span>
              {step.durationMs != null && <span className="text-neutral-500">({step.durationMs}ms)</span>}
            </div>
            <div className="ml-4 space-y-1 text-xs">
              {step.selectorRecords?.map((r: any) => (
                <div key={r.id} className="flex items-center gap-2">
                  <SelectorResultBadge result={r.result} />
                  <span className="text-neutral-400">{r.selectorKey}</span>
                  <span className="text-neutral-600">[{r.selectorSource}]</span>
                  <span className="text-neutral-500 truncate">{r.selectorUsed}</span>
                </div>
              ))}
              {step.urlRecords?.map((r: any) => (
                <div key={r.id} className="flex items-center gap-2">
                  <SelectorResultBadge result={r.result} />
                  <span className="text-neutral-400">{r.healthKey ?? r.urlPattern}</span>
                  {r.itemsFound != null && <span className="text-neutral-500">{r.itemsFound} 条</span>}
                  {r.result === 'validation_failed' && <span className="text-amber-400">失败步骤: {r.validationStep}</span>}
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => retry.mutate({ executionId, stepId: step.id })}
                  className="rounded bg-neutral-800 px-2 py-0.5 text-xs hover:bg-neutral-700"
                >重试</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </BentoCard>
  );
}
```

- [ ] **Step 5: 创建主页面 Tab 容器**

Create: `apps/admin-dashboard/src/app/maintenance/page.tsx`

```tsx
'use client';

import { useState } from 'react';
import ExecutionHealthTab from './ExecutionHealthTab';
import ExecutionDetailTab from './ExecutionDetailTab';
import SelectorHealthTab from './SelectorHealthTab';
import ConfigSnapshotTab from './ConfigSnapshotTab';

type Tab = 'health' | 'selector' | 'config';

export default function MaintenancePage() {
  const [tab, setTab] = useState<Tab>('health');
  const [pickedExec, setPickedExec] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-neutral-100">流程节点监控与维护调试</h1>

      {pickedExec ? (
        <ExecutionDetailTab executionId={pickedExec} onBack={() => setPickedExec(null)} />
      ) : (
        <>
          <div className="flex gap-2">
            {([['health', '执行健康'], ['selector', '选择器健康'], ['config', '配置管理']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-neutral-100 text-neutral-900' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
              >{label}</button>
            ))}
          </div>
          {tab === 'health' && <ExecutionHealthTab onPick={setPickedExec} />}
          {tab === 'selector' && <SelectorHealthTab />}
          {tab === 'config' && <ConfigSnapshotTab />}
        </>
      )}
    </div>
  );
}
```

> 注：`SelectorHealthTab`/`ConfigSnapshotTab` 在 Task 16/17 创建。本 Task 先创建占位文件使 build 通过：

Create: `apps/admin-dashboard/src/app/maintenance/SelectorHealthTab.tsx`（占位，Task 16 替换）

```tsx
'use client';
export default function SelectorHealthTab() { return <div className="text-neutral-500">选择器健康（待实现）</div>; }
```

Create: `apps/admin-dashboard/src/app/maintenance/ConfigSnapshotTab.tsx`（占位，Task 17 替换）

```tsx
'use client';
export default function ConfigSnapshotTab() { return <div className="text-neutral-500">配置管理（待实现）</div>; }
```

- [ ] **Step 6: 构建验证**

Run:
```bash
pnpm --filter admin-dashboard build
```
Expected: 构建成功，无类型错误。若 `MaterialIcon` 的 `icon` prop 类型不符，回查 `components/ui/MaterialIcon.tsx` 调整传值。

- [ ] **Step 7: Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts apps/admin-dashboard/src/app/maintenance/
git commit -m "feat(dashboard): maintenance page — hooks + execution health/detail tabs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: admin-dashboard — 选择器健康 Tab

**Files:**
- Modify: `apps/admin-dashboard/src/app/maintenance/SelectorHealthTab.tsx`（替换占位）
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts`（追加 selector history hook + 降级建议）

> 覆盖 spec 8.3：选择器健康概览表（总次数/成功率/主选择器率/降级率/操作），降级率超阈值标红 + "建议提升 fallback" 提示，bypass 行显示"待收口盲区"。

- [ ] **Step 1: 追加 hook**

在 `apps/admin-dashboard/src/hooks/useApi.ts` maintenance 区追加：

```typescript
export function useSelectorHistory(key: string, platform?: string) {
  const qs = platform ? `?platform=${platform}` : '';
  return useQuery({
    enabled: !!key,
    queryKey: ['maintenance', 'selector', 'history', key, platform],
    queryFn: () => api.get(`/maintenance/selectors/${encodeURIComponent(key)}/history${qs}`).then(r => r.data),
  });
}
```

- [ ] **Step 2: 实现选择器健康 Tab**

Replace `apps/admin-dashboard/src/app/maintenance/SelectorHealthTab.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { useSelectorHealth } from '@/hooks/useApi';
import { BentoCard } from '@/components/ui/Bento';
import { cn } from '@/lib/utils';

const PLATFORMS = ['', 'douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const DEGRADE_WARN = 0.1; // 降级率 > 10% 标红

export default function SelectorHealthTab() {
  const [platform, setPlatform] = useState('');
  const { data, isLoading } = useSelectorHealth(platform || undefined);

  return (
    <BentoCard className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <select value={platform} onChange={e => setPlatform(e.target.value)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
          <option value="">全部平台</option>
          {PLATFORMS.slice(1).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="text-xs text-neutral-500">降级率 &gt; {(DEGRADE_WARN * 100).toFixed(0)}% 标红，提示提升 fallback</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="px-2 py-1 text-left">选择器键</th>
              <th className="px-2 py-1 text-right">总次数</th>
              <th className="px-2 py-1 text-right">成功率</th>
              <th className="px-2 py-1 text-right">主选择器率</th>
              <th className="px-2 py-1 text-right">降级率</th>
              <th className="px-2 py-1 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={6} className="px-2 py-4 text-center text-neutral-500">加载中…</td></tr>}
            {data?.map((row: any) => {
              const isBypass = row.selectorKey === 'evaluate' || row.selectorKey === '$' || row.selectorKey === '$$';
              const degradeHigh = (row.degradationRate ?? 0) > DEGRADE_WARN;
              return (
                <tr key={row.selectorKey} className="border-t border-neutral-800">
                  <td className="px-2 py-1 font-mono text-xs">{row.selectorKey}</td>
                  <td className="px-2 py-1 text-right">{row.totalCount}</td>
                  <td className="px-2 py-1 text-right">{row.successRate != null ? `${(row.successRate * 100).toFixed(0)}%` : 'N/A'}</td>
                  <td className="px-2 py-1 text-right">{row.primaryRate != null ? `${(row.primaryRate * 100).toFixed(0)}%` : 'N/A'}</td>
                  <td className={cn('px-2 py-1 text-right', degradeHigh && 'text-rose-400 font-semibold')}>
                    {row.degradationRate != null ? `${(row.degradationRate * 100).toFixed(0)}%` : 'N/A'}
                  </td>
                  <td className="px-2 py-1">
                    {isBypass ? (
                      <span className="text-amber-400 text-xs">⚠️ 待收口盲区</span>
                    ) : degradeHigh ? (
                      <span className="text-amber-400 text-xs">建议提升 fallback</span>
                    ) : (
                      <span className="text-neutral-600 text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </BentoCard>
  );
}
```

- [ ] **Step 3: 构建验证**

Run:
```bash
pnpm --filter admin-dashboard build
```
Expected: 构建成功。

- [ ] **Step 4: Commit**

```bash
git add apps/admin-dashboard/src/app/maintenance/SelectorHealthTab.tsx apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat(dashboard): selector health tab with degradation warnings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 17: admin-dashboard — 配置管理 Tab

**Files:**
- Modify: `apps/admin-dashboard/src/app/maintenance/ConfigSnapshotTab.tsx`（替换占位）
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts`（追加配置快照 hooks）

> 覆盖 spec 8.4：快照列表（名称/平台/类型/版本/创建时间/状态/操作）+ 创建快照 + 回滚（带 currentVersion CAS）+ 导出/导入。

- [ ] **Step 1: 追加配置 hooks**

在 `apps/admin-dashboard/src/hooks/useApi.ts` maintenance 区追加：

```typescript
export function useConfigSnapshots(platform?: string) {
  const qs = platform ? `?platform=${platform}` : '';
  return useQuery({
    queryKey: ['maintenance', 'config', 'snapshots', platform],
    queryFn: () => api.get(`/maintenance/config/snapshots${qs}`).then(r => r.data),
  });
}

export function useCreateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { platform: string; configType: string; snapshotName: string; configData: any; createdBy?: string }) =>
      api.post('/maintenance/config/snapshots', body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance', 'config'] }),
  });
}

export function useRollbackSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { id: string; platform: string; configType: string; currentVersion: number }) =>
      api.post(`/maintenance/config/snapshots/${body.id}/rollback`, {
        platform: body.platform, configType: body.configType, currentVersion: body.currentVersion,
      }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance', 'config'] }),
  });
}

export function useExportConfig() {
  return useMutation({
    mutationFn: (body: { platform: string; configType: string }) =>
      api.post('/maintenance/config/export', body).then(r => r.data),
  });
}

export function useImportConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { platform: string; configType: string; snapshotName: string; configData: any; createdBy?: string }) =>
      api.post('/maintenance/config/import', body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance', 'config'] }),
  });
}
```

- [ ] **Step 2: 实现配置管理 Tab**

Replace `apps/admin-dashboard/src/app/maintenance/ConfigSnapshotTab.tsx`：

```tsx
'use client';

import { useState } from 'react';
import {
  useConfigSnapshots, useCreateSnapshot, useRollbackSnapshot, useExportConfig, useImportConfig,
} from '@/hooks/useApi';
import { BentoCard } from '@/components/ui/Bento';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const TYPES = ['selectors', 'url_monitors', 'flow_rules'] as const;

export default function ConfigSnapshotTab() {
  const [platform, setPlatform] = useState<string>('douyin');
  const [configType, setConfigType] = useState<string>('selectors');
  const [snapshotName, setSnapshotName] = useState('');
  const [configData, setConfigData] = useState('{}');
  const [importData, setImportData] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  const { data: snapshots, refetch } = useConfigSnapshots(platform);
  const createMut = useCreateSnapshot();
  const rollbackMut = useRollbackSnapshot();
  const exportMut = useExportConfig();
  const importMut = useImportConfig();

  const handleCreate = async () => {
    setError(null);
    try {
      await createMut.mutateAsync({ platform, configType, snapshotName: snapshotName || `手动-${Date.now()}`, configData });
      setSnapshotName('');
    } catch (e: any) { setError(e.response?.data?.error ?? e.message); }
  };

  const handleRollback = async (id: string, currentVersion: number) => {
    setError(null);
    try {
      await rollbackMut.mutateAsync({ id, platform, configType, currentVersion });
    } catch (e: any) { setError(e.response?.data?.error ?? '回滚冲突：配置已被修改，请刷新'); }
  };

  const handleExport = async () => {
    setError(null);
    try {
      const data = await exportMut.mutateAsync({ platform, configType });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${platform}-${configType}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.response?.data?.error ?? e.message); }
  };

  const handleImport = async () => {
    setError(null);
    try {
      await importMut.mutateAsync({
        platform, configType,
        snapshotName: `导入-${Date.now()}`,
        configData: JSON.parse(importData),
      });
      setImportData('{}');
    } catch (e: any) { setError(e.response?.data?.error ?? '导入失败：JSON 格式非法'); }
  };

  return (
    <div className="space-y-4">
      <BentoCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={platform} onChange={e => setPlatform(e.target.value)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
            {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={configType} onChange={e => setConfigType(e.target.value)} className="rounded bg-neutral-800 px-2 py-1 text-sm">
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={handleExport} className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600">📥 导出</button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-neutral-300">创建快照</h3>
            <input value={snapshotName} onChange={e => setSnapshotName(e.target.value)} placeholder="快照名称"
              className="w-full rounded bg-neutral-800 px-2 py-1 text-sm" />
            <textarea value={configData} onChange={e => setConfigData(e.target.value)} rows={4}
              className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs" />
            <button onClick={handleCreate} className="rounded bg-sky-600 px-3 py-1 text-sm hover:bg-sky-500">📸 创建快照</button>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-neutral-300">导入配置</h3>
            <textarea value={importData} onChange={e => setImportData(e.target.value)} rows={4}
              className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs" placeholder='{"selectors":{...}}' />
            <button onClick={handleImport} className="rounded bg-emerald-600 px-3 py-1 text-sm hover:bg-emerald-500">📤 导入</button>
          </div>
        </div>
        {error && <div className="mt-2 text-sm text-rose-400">{error}</div>}
      </BentoCard>

      <BentoCard className="p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">快照历史</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-neutral-400">
              <tr>
                <th className="px-2 py-1 text-left">名称</th>
                <th className="px-2 py-1 text-left">类型</th>
                <th className="px-2 py-1 text-right">版本</th>
                <th className="px-2 py-1 text-left">创建时间</th>
                <th className="px-2 py-1 text-left">状态</th>
                <th className="px-2 py-1 text-left">操作</th>
              </tr>
            </thead>
            <tbody>
              {snapshots?.filter((s: any) => s.platform === platform).map((s: any) => (
                <tr key={s.id} className="border-t border-neutral-800">
                  <td className="px-2 py-1">{s.snapshotName}</td>
                  <td className="px-2 py-1">{s.configType}</td>
                  <td className="px-2 py-1 text-right">v{s.version}</td>
                  <td className="px-2 py-1">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-1">{s.isActive ? <span className="text-emerald-400">生效中</span> : <span className="text-neutral-500">历史</span>}</td>
                  <td className="px-2 py-1">
                    {!s.isActive && (
                      <button onClick={() => handleRollback(s.id, s.version)} className="text-sky-400 hover:underline">回滚</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </BentoCard>
    </div>
  );
}
```

- [ ] **Step 3: 构建验证**

Run:
```bash
pnpm --filter admin-dashboard build
```
Expected: 构建成功。

- [ ] **Step 4: Commit**

```bash
git add apps/admin-dashboard/src/app/maintenance/ConfigSnapshotTab.tsx apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat(dashboard): config snapshot tab — create/rollback/export/import

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 18: 探针启用 + Redis pusher 注入到爬虫 worker

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（启动入口）
- Test: `apps/ts-api-gateway/src/crawlers/probeBootstrap.test.ts`

> 设计：爬虫执行任务时，按 `TaskExecution.isDebugMode` 决定是否 `MaintenanceProbe.setEnabled(true)`，并注入 Redis pusher（经 `getRedis()`）。任务结束时 `flush()` + `setEnabled(false)`。这层注入是所有爬虫共用的样板，先在抖音落地，快手/小红书/视频号按同模式跟进（不在本计划范围内，仅 PageProxy 兜底）。

- [ ] **Step 1: 写失败测试**

Create: `apps/ts-api-gateway/src/crawlers/probeBootstrap.test.ts`

```typescript
import { MaintenanceProbe } from '@social-media/browser-core';
import { bootstrapProbe, teardownProbe } from './probeBootstrap';

describe('probe bootstrap', () => {
  afterEach(() => MaintenanceProbe.reset());

  it('setEnabled(true) and wires redis pusher when debug mode', async () => {
    await bootstrapProbe({ isDebugMode: true });
    expect(MaintenanceProbe.isEnabled()).toBe(true);
  });

  it('setEnabled(false) when not debug mode', async () => {
    await bootstrapProbe({ isDebugMode: false });
    expect(MaintenanceProbe.isEnabled()).toBe(false);
  });

  it('teardownProbe flushes and disables', async () => {
    await bootstrapProbe({ isDebugMode: true });
    await teardownProbe();
    expect(MaintenanceProbe.isEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/crawlers/probeBootstrap.test.ts
```
Expected: FAIL — `Cannot find module './probeBootstrap'`。

- [ ] **Step 3: 实现 probeBootstrap**

Create: `apps/ts-api-gateway/src/crawlers/probeBootstrap.ts`

```typescript
// @ts-api-gateway/crawlers/probeBootstrap.ts
// 探针启用/卸载样板：按任务 isDebugMode 启用探针 + 注入 Redis pusher。

import { MaintenanceProbe, PROBE_CHANNEL } from '@social-media/browser-core';
import { getRedis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('probe-bootstrap');

export async function bootstrapProbe(opts: { isDebugMode: boolean; taskExecutionId?: string }): Promise<void> {
  MaintenanceProbe.setEnabled(opts.isDebugMode);
  if (!opts.isDebugMode) return;

  try {
    const redis = getRedis();
    MaintenanceProbe.setRedisPusher(async (_channel, payload) => {
      // channel 固定 PROBE_CHANNEL，payload 为 JSON 字符串
      await redis.lpush(PROBE_CHANNEL, payload);
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'redis pusher wiring failed, probe will silently drop');
    MaintenanceProbe.setRedisPusher(null);
  }
}

export async function teardownProbe(): Promise<void> {
  try {
    await MaintenanceProbe.flush();
  } catch (err: any) {
    logger.warn({ err: err.message }, 'probe flush on teardown failed');
  }
  MaintenanceProbe.setEnabled(false);
  MaintenanceProbe.setRedisPusher(null);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/crawlers/probeBootstrap.test.ts
```
Expected: PASS（3 个用例）。注意：`getRedis()` 会尝试真实连接，测试环境若 REDIS_URL 不可用会触发 catch 分支——测试断言 `isEnabled()` 即可，pusher 注入失败不影响。

- [ ] **Step 5: 在抖音爬虫执行入口接入**

Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

import 区追加：

```typescript
import { MaintenanceProbe } from '@social-media/browser-core';
import { bootstrapProbe, teardownProbe } from './probeBootstrap';
```

在任务执行主方法开头（`startExecution` 拿到 `executionId` 之后，业务流程之前）插入：

```typescript
    // 维护调试：按任务 debug 模式启用探针
    const exec = executionId ? await prisma.taskExecution.findUnique({ where: { id: executionId }, select: { isDebugMode: true } }) : null;
    await bootstrapProbe({ isDebugMode: exec?.isDebugMode ?? false, taskExecutionId: executionId ?? undefined });
```

> 注：`executionId` 与 `prisma` 在该文件已可用（见现有 `recordSelectorTry(executionId, ...)` 调用）。若 `prisma` 未 import，追加 `import { prisma } from '../lib/prisma';`。执行者用 `grep -nE "import.*prisma|executionId" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts | head` 确认。

在任务执行主方法的 `finally` 块（或 `finishExecution` 调用附近）插入：

```typescript
    await teardownProbe();
```

- [ ] **Step 6: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/probeBootstrap.ts apps/ts-api-gateway/src/crawlers/probeBootstrap.test.ts apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): probe bootstrap/teardown wired into crawler execution

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 19: 抖音爬虫代表性子步骤接入探针（菜单/视频列表/评论列表）

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

> 设计：在三个代表性 phase 的关键子步骤入口加 `MaintenanceProbe.enterStep(flow, platform, phase, step, subStep, executionId)`，选择器调用从直接 `HumanActions.click`/`page.locator` 迁移到 `HumanActions.clickWithFallback`（经 `SelectorRegistry` 取配置），子步骤结束 `exitStep`。这是样板，其余子步骤按同模式跟进（不在本计划强制范围，避免 4000 行文件全量改造不可控）。
>
> **范围声明**：本 Task 仅接入 3 个代表性子步骤作为可验证样板。完整覆盖所有子步骤列为后续工作（spec 11.1 样板语义）。Task 21 端到端验证针对这 3 个子步骤。

- [ ] **Step 1: 定位三个子步骤的现有代码**

Run:
```bash
grep -nE "menu_home|menu_work_manage|expandMenu|展开菜单|作品列表|video_list|comment.*list|评论列表" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts | head -20
```

记录三个子步骤的行号区间，作为 `enterStep`/`exitStep` 插入点。

- [ ] **Step 2: 在菜单展开子步骤接入**

在菜单展开逻辑前插入：

```typescript
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'expandMenu', 'menu_home', executionId);
    try {
      // 原菜单展开逻辑，选择器调用迁移为：
      const menuConfig = SelectorRegistry.get('douyin.monitor.menu_home');
      if (menuConfig) {
        await HumanActions.clickWithFallback(page, menuConfig, {
          onFallbackTriggered: (failed, success, key) => logger.warn({ key, failed, success }, 'selector degraded'),
        });
      } else {
        // 回退到原有逻辑（迁移期兼容）
        await HumanActions.click(page, /* 原选择器 */);
      }
    } finally {
      MaintenanceProbe.exitStep();
    }
```

> 注：原菜单展开逻辑的选择器字符串需从现有代码提取。执行者读取该子步骤现有实现，将 `HumanActions.click(page, '<原sel>')` 替换为上述 `clickWithFallback` 块。`SelectorRegistry` 需 import：`import { SelectorRegistry } from '@social-media/browser-core';`，并在文件启动处注入 reader（见 Step 5）。

- [ ] **Step 3: 在视频列表子步骤接入**

在视频列表滚动/提取逻辑前插入：

```typescript
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'scrollVideoList', undefined, executionId);
    try {
      // 原滚动 + interceptor.waitForResponse 逻辑保留
      // interceptor 已在 attachByConfig 接入处自动 recordUrlIntercept（见 Task 8）
    } finally {
      MaintenanceProbe.exitStep();
    }
```

- [ ] **Step 4: 在评论列表子步骤接入**

```typescript
    MaintenanceProbe.enterStep('reply', 'douyin', 'commentPhase', 'loadComments', undefined, executionId);
    try {
      // 原评论加载逻辑
    } finally {
      MaintenanceProbe.exitStep();
    }
```

- [ ] **Step 5: 注入 SelectorReader 到 SelectorRegistry**

在 `douyinCrawler.ts` 初始化区（构造函数或模块顶部，`getSelectorReader` 调用附近）追加：

```typescript
    // 维护调试：注册 SelectorReader 到 SelectorRegistry
    SelectorRegistry.setReader(getSelectorReader());
```

> 注：`getSelectorReader` 来自 `'../lib/selectorStore'`（见现有 import 第 4 行）。确认其返回 `SelectorReader` 实例。

- [ ] **Step 6: 类型检查 + 构建**

Run:
```bash
pnpm --filter ts-api-gateway build
```
Expected: 构建成功。若 `SelectorRegistry` 未从 `@social-media/browser-core` 导出，回查 Task 8 Step 5 是否已添加导出。

- [ ] **Step 7: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): probe enterStep/exitStep + clickWithFallback on 3 sample substeps

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 20: selectorTries 迁移收口 — recordSelectorTry 改为探针路径

**Files:**
- Modify: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`
- Modify: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts`
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（`snap()` 闭包）

> 设计（v1.2 定调：替代 selectorTries）：`recordSelectorTry` 不再直接写 `TaskExecutionStep.selectorTries`，改为经 `MaintenanceProbe.recordSelectorOp` 推送（探针在 debug 模式启用时才记录，保留原"非 debug 不写明细"语义）。`TaskExecutionStep.selectorTries` 字段停止写入（保留字段兼容期）。`snap()` 闭包的 `selectors` 数组转为 `recordSelectorOp` 调用。

- [ ] **Step 1: 更新现有测试预期**

在 `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts` 中，找到断言 `selectorTries` 被写入的用例（约第 65 行 `selectorTries: [...]`），改为断言**不再写 selectorTries**：

```typescript
  it('recordSelectorTry no longer writes selectorTries (migrated to probe)', async () => {
    // 探针经 MaintenanceProbe.recordSelectorOp 路径，TaskExecutionStep.selectorTries 停止写入
    const { MaintenanceProbe } = await import('@social-media/browser-core');
    MaintenanceProbe.reset();
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => pushed.push(JSON.parse(p)));

    await startExecution(
      { taskId: 'job-mig', taskType: 'monitor', windowId: 'w1', platform: 'douyin', userId: 1 } as any,
      { updateProgress: async () => {} } as any,
    );
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, /* executionId 需传入 */);
    await recordSelectorTry('<exec-id>', 'label', {
      phase: 'p',
      selectors: [{ selector: '.primary', hit: false, isPrimary: true }, { selector: '.fb', hit: true, isPrimary: false }],
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();

    // 探针收到 selector 事件
    expect(pushed.filter(e => e.type === 'selector').length).toBeGreaterThanOrEqual(1);
    // TaskExecutionStep 不再写 selectorTries（仅当仍需 step 记录时由 maintenance_step 承载）
    const steps = await prisma.taskExecutionStep.findMany({ where: { execution: { taskId: 'job-mig' } } });
    expect(steps.every(s => s.selectorTries == null || (s.selectorTries as any) === '[]')).toBe(true);

    await prisma.maintenanceSelectorRecord.deleteMany({});
    await prisma.maintenanceStep.deleteMany({});
    await prisma.maintenanceExecution.deleteMany({});
    await prisma.taskExecutionStep.deleteMany({});
    await prisma.taskExecution.deleteMany({});
  });
```

> 注：`<exec-id>` 需用 `startExecution` 返回值。执行者调整测试使其先捕获 `const execId = await startExecution(...)`。

- [ ] **Step 2: 重构 recordSelectorTry 为探针路径**

Modify: `apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts`

将 `recordSelectorTry` 函数体替换为：

```typescript
export async function recordSelectorTry(
  executionId: string,
  label: string,
  data: {
    phase: string;
    selectors: Array<{ selector: string; hit: boolean; isPrimary: boolean }>;
    mouseAction?: string;
    extra?: Record<string, any>;
  },
): Promise<void> {
  try {
    // v1.2 迁移：选择器明细经 MaintenanceProbe 探针路径，替代直接写 TaskExecutionStep.selectorTries
    const { MaintenanceProbe } = await import('@social-media/browser-core');
    if (!MaintenanceProbe.isEnabled()) return; // 保留"非 debug 不写明细"语义

    for (const sel of data.selectors) {
      const source = sel.isPrimary ? 'primary' : 'fallback_1';
      await MaintenanceProbe.recordSelectorOp({
        selectorKey: label,
        selectorUsed: sel.selector,
        selectorSource: source as any,
        result: sel.hit ? 'found' : 'not_found',
        durationMs: 0,
      });
    }
    // 不再创建 TaskExecutionStep（由 MaintenanceCollector 聚合为 maintenance_step）
  } catch (err: any) {
    logger.warn({ executionId, label, error: err.message }, 'recordSelectorTry failed (non-fatal)');
  }
}
```

- [ ] **Step 3: 抖音 snap() 闭包无需改动（仍调 recordSelectorTry）**

`douyinCrawler.ts` 的 `snap()` 闭包仍调用 `recordSelectorTry`，该函数内部已迁移为探针路径——调用方透明。**无需修改**，但需确认 `snap()` 在 debug 模式下被调用时探针已启用（Task 18 已保证）。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/lib/taskExecutionRecorder.test.ts
```
Expected: PASS。若 `MaintenanceProbe.isEnabled()` 在测试中为 false（因 reset），需在测试内显式 `setEnabled(true)`（Step 1 已含）。

- [ ] **Step 5: 跑爬虫相关回归**

Run:
```bash
pnpm --filter ts-api-gateway test -- src/lib/taskExecutionRecorder.test.ts src/crawlers/probeBootstrap.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts
git commit -m "refactor(recorder): migrate recordSelectorTry to MaintenanceProbe path (replace selectorTries)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 21: 端到端验证 + 全量回归 + 文档收尾

**Files:**
- 无新代码（验证 + 文档）

- [ ] **Step 1: 全量测试回归**

Run:
```bash
pnpm --filter ts-api-gateway test
```
Expected: 全部 PASS。若有既有测试因 `selectorTries` 不再写入而失败，按 Task 20 模式更新预期。

- [ ] **Step 2: browser-core 全量回归**

Run:
```bash
pnpm --filter ts-api-gateway test -- packages/browser-core/src/__tests__/
```
Expected: 全部 PASS（含新增 6 个测试文件 + 既有 humanActions/interceptor）。

- [ ] **Step 3: admin-dashboard 构建**

Run:
```bash
pnpm --filter admin-dashboard build
```
Expected: 构建成功。

- [ ] **Step 4: Prisma 迁移状态确认**

Run:
```bash
pnpm prisma:migrate status
```
Expected: 无待应用迁移，6 张表已建。

- [ ] **Step 5: 端到端手动验证清单**

启动服务后逐项验证（在 `docs/superpowers/plans/2026-06-26-maintenance-debug-system.md` 末尾记录结果）：

```bash
pnpm docker:up   # 起 Postgres + Redis
pnpm dev         # 起 gateway + dashboard
```

1. **开启 debug 模式**：`PUT /api/v1/system/debug-mode` body `{"enabled":true}` → 返回 success
2. **触发一次抖音监控任务**：经矩阵页或 `POST /api/v1/matrix/...` 触发，等待完成
3. **验证 maintenance_execution 已建**：`GET /api/v1/maintenance/executions?platform=douyin` → 返回 1 条记录
4. **验证子步骤明细**：`GET /api/v1/maintenance/executions/:id/steps` → 含 selectorRecords（来自 3 个样板子步骤）
5. **验证 URL 拦截记录**：steps 内 urlRecords 含 `video_list` 的 matched 记录，`videoId` 非空
6. **验证选择器健康聚合**：`GET /api/v1/maintenance/selectors/health?platform=douyin` → 返回聚合行
7. **验证 UI**：访问 `/maintenance`，执行健康 Tab 显示该执行，点击详情看到树形展开 + 健康徽章
8. **验证旁路报警**（快手/小红书任务）：触发一个未收口平台任务，选择器健康 Tab 出现 `evaluate`/`$` 的 bypass 行
9. **验证配置快照**：配置管理 Tab 创建快照 → 回滚 → 验证版本号递增
10. **验证 CAS 冲突**：用两个并发回滚请求（stale version）→ 第二个返回 409

- [ ] **Step 6: 记录验证结果**

在计划文件末尾追加：

```markdown
## 端到端验证结果

| 验证项 | 结果 | 备注 |
|--------|------|------|
| debug 开关 | ✅/❌ | |
| maintenance_execution 创建 | ✅/❌ | |
| 子步骤 selectorRecords | ✅/❌ | |
| URL 拦截 videoId | ✅/❌ | |
| 选择器健康聚合 | ✅/❌ | |
| UI 执行健康/详情 | ✅/❌ | |
| 旁路报警（未收口平台） | ✅/❌ | |
| 配置快照/回滚 | ✅/❌ | |
| CAS 409 冲突 | ✅/❌ | |
```

- [ ] **Step 7: 更新 spec 状态 + 提交收尾**

将 `docs/superpowers/specs/2026-06-26-maintenance-debug-system-design.md` 顶部状态从"已复核，待审批"改为"已实现 v1.2"。

```bash
git add docs/superpowers/specs/2026-06-26-maintenance-debug-system-design.md docs/superpowers/plans/2026-06-26-maintenance-debug-system.md
git commit -m "docs(maintenance): mark spec v1.2 implemented + E2E verification results

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 后续工作（不在本计划范围）

- **其他平台完整探针接入**：快手/小红书/视频号按抖音样板（Task 19 模式）逐步接入 `enterStep`/`clickWithFallback`，当前仅 PageProxy 旁路兜底。
- **方案B 声明式工作流引擎**：spec 1.3，下一阶段重构。
- **实时追踪**：spec 11.2，当前仅事后查看。
- **Debug 快照 pg_cron 清理**：spec 5.8，需配置 PostgreSQL pg_cron 扩展定期清理 `expires_at` 过期记录（当前靠应用层 `startCleanupScheduler` 兜底）。
- **`TaskExecutionStep.selectorTries` 字段移除**：v1.2 兼容期保留，下个大版本迁移后从 schema 删除。








