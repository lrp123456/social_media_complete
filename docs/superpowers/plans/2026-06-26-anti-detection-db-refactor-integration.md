# 反检测收口与数据库重构融合落地实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐反检测收口与 DB 重构两设计合并 master 后未真正生效的缺口——删 users 孤儿表/模型、operators.ts 平台操作迁移到 PlatformAccount、douyinCrawler.ts 编译清零、前端主从面板（一操作员多窗口、每窗口独立管平台）——使两设计真正可用。

**Architecture:** 后端核心契约已真实落地，缺口在"schema 收尾 + 后端未迁移调用方 + 前端可见层"。按依赖顺序：先删 User 模型重生成 Prisma Client → 迁移 operators.ts 的 operatorPlatform 调用到 platformAccount → 清零 douyinCrawler.ts 类型错误 → 清理 GET / 扁平化 + 前端类型 → 重构前端主从面板 → 端到端验证。

**Tech Stack:** TypeScript + Prisma 6 + Next.js 14 + React Query + Patchright + BullMQ

**对应 spec:** `docs/superpowers/specs/2026-06-26-anti-detection-db-refactor-integration-design.md`

**范围约束:** tsc 清零仅限 `operators.ts` + `douyinCrawler.ts`（共 71 错误）。tencentCrawler/kuaishouCrawler/oss/test 的预存错误（103 个，与本次两设计无关）不动。

---

## 文件结构

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `prisma/schema.prisma` | 数据模型定义 | 删 `model User`（第 17-34 行） |
| `apps/ts-api-gateway/src/routes/operators.ts` | 操作员/窗口/平台/登录验证路由 | 7 处 operatorPlatform→platformAccount、loginVerification 用 windowId、verify-all 重构、删 monitorQueue 残留导入、删 GET / 扁平化 platforms |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音评论采集 | 58 处类型断言修复 |
| `apps/admin-dashboard/src/hooks/useApi.ts` | API hooks 与类型 | Operator.windows 补 platforms 嵌套、删顶层扁平 platforms |
| `apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx` | 用户管理页 | 改主从面板：左操作员列表 + 右详情（多窗口、每窗口独立管平台） |

---

## Task 1: 删除 User 模型并重生成 Prisma Client

**Files:**
- Modify: `prisma/schema.prisma` (第 17-34 行)

- [ ] **Step 1: 删除 User 模型定义**

删除 `prisma/schema.prisma` 中第 17-34 行整段：

```prisma
model User {
  id                  Int      @id @default(autoincrement())
  fingerprintWindowId String   @map("fingerprint_window_id")
  wechatUserid        String   @map("wechat_userid")
  platform            String   @default("douyin")
  status              String   @default("init") // init | active | blocked | cooldown
  consecutiveNoUpdate Int      @default(0) @map("consecutive_no_update")
  cooldownUntil       BigInt   @default(0) @map("cooldown_until")
  monitoringEnabled   Boolean  @default(true) @map("monitoring_enabled")
  platformAuthorId    String?  @map("platform_author_id") // 抖音uid / 快手userId
  platformAuthorName  String?  @map("platform_author_name") // 作者昵称
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  skipPinnedVideos    Json?    @map("skip_pinned_videos")

  @@unique([fingerprintWindowId, platform], name: "idx_users_window_platform")
  @@map("users")
}
```

同时删除其上方注释行 `// 一、核心业务表（来自 my_folder TS 项目）` 下紧邻 User 模型的部分（保留章节注释标题）。

- [ ] **Step 2: 重生成 Prisma Client**

Run:
```bash
cd /home/lrp/social_media_complete && npx prisma generate
```
Expected: 输出 `✔ Generated Prisma Client`，无错误。

- [ ] **Step 3: 验证业务代码无 prisma.user 类型残留**

Run:
```bash
grep -rn "prisma\.user\b" apps/ packages/ --include="*.ts" | grep -v node_modules | grep -v "\.test\."
```
Expected: 无输出（0 命中）。

- [ ] **Step 4: 删除物理 users 表**

Run:
```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "DROP TABLE IF EXISTS users;"
```
Expected: 输出 `DROP TABLE`。

- [ ] **Step 5: 验证 users 表已删除**

Run:
```bash
docker exec sm-postgres psql -U sm_admin -d social_media -t -c "SELECT to_regclass('users');"
```
Expected: 空输出（表不存在）。

- [ ] **Step 6: Commit**

```bash
cd /home/lrp/social_media_complete
git add prisma/schema.prisma
git commit -m "refactor(db): 删除 User 模型与 users 孤儿表

DB 重构 spec 4.1 收尾：User 模型完全孤立（无 @relation 引用）、
users 表 0 数据、外键已指向 platform_accounts。删除模型 + 物理表，
prisma generate 后业务代码无 prisma.user 残留。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 修复 operators.ts 残留导入（monitorQueue）

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 8 行, 第 527-538 行)

`monitorQueue` 在整个代码库已不存在（DB 重构删除），但 operators.ts 仍导入并使用它清理 BullMQ 任务。需移除导入，BullMQ 清理改用现有可用的队列引用或直接跳过（platform_accounts 删除时由调度器自然重试）。

- [ ] **Step 1: 查看当前导入与使用**

第 8 行：
```typescript
import { monitorQueue, resetSchedulerTimer } from '../services/monitorService';
```

第 527-538 行（在 DELETE platform 路由内）：
```typescript
      // 清理 BullMQ 中该用户的待处理监控任务
      const staleJobs = await monitorQueue.getJobs(['waiting', 'delayed']);
      let removedJobs = 0;
      for (const job of staleJobs) {
        if (accountIds.includes(job.data.userId)) {
          await job.remove().catch(() => {});
          removedJobs++;
        }
      }
      if (removedJobs > 0) {
        logger.info({ operatorId: id, platform, removedJobs }, '已清理 BullMQ 残留任务');
      }
```

- [ ] **Step 2: 修改导入行（移除 monitorQueue）**

将第 8 行改为：
```typescript
import { resetSchedulerTimer } from '../services/monitorService';
```

- [ ] **Step 3: 移除 BullMQ 清理代码块**

删除第 527-538 行整段（`// 清理 BullMQ 中该用户的待处理监控任务` 到 `}`），替换为注释说明。删除后该段应为：

```typescript
      logger.info({ operatorId: id, platform, deletedCount: accountIds.length }, '已清理对应的监控用户记录');
      // 注：BullMQ 残留任务由调度器在下次轮询时按 platform_accounts 自然重试，无需主动清理
```

- [ ] **Step 4: 验证 monitorQueue 引用清零**

Run:
```bash
cd /home/lrp/social_media_complete && grep -n "monitorQueue" apps/ts-api-gateway/src/routes/operators.ts
```
Expected: 无输出。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "fix(operators): 移除已不存在的 monitorQueue 残留导入

DB 重构删除 monitorService 队列导出后，operators.ts 仍导入 monitorQueue
导致编译错误。BullMQ 残留任务改由调度器自然重试。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 迁移"添加平台"接口到 PlatformAccount

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 465-496 行, POST `/:id/platforms`)

旧逻辑在已删除的 OperatorPlatform 上建绑定。新语义：平台账号属窗口，需遍历操作员绑定窗口为每个窗口 upsert PlatformAccount。无绑定窗口则提示先绑窗口。

- [ ] **Step 1: 替换 POST /:id/platforms 整个路由处理体**

将第 465-496 行替换为：

```typescript
/** POST /api/v1/operators/:id/platforms — 为操作员添加平台（在所有绑定窗口下创建 PlatformAccount） */
router.post('/:id/platforms', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const bodySchema = z.object({
      platform: z.enum(['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok']),
    });

    const { id } = paramsSchema.parse(req.params);
    const { platform } = bodySchema.parse(req.body);

    // 平台账号属于窗口：获取操作员所有绑定窗口
    const operator = await prisma.operator.findUnique({
      where: { id },
      include: { windows: { where: { status: 'bound' } } },
    });

    if (!operator) {
      return res.status(404).json({ success: false, error: '操作员不存在' });
    }
    if (operator.windows.length === 0) {
      return res.status(400).json({ success: false, error: '请先绑定窗口再加平台账号' });
    }

    // 为每个绑定窗口 upsert PlatformAccount（唯一键 windowId+platform）
    const created: any[] = [];
    for (const window of operator.windows) {
      const account = await prisma.platformAccount.upsert({
        where: { idx_platform_account_window_platform: { windowId: window.id, platform } },
        update: { loginStatus: 'unknown' },
        create: {
          windowId: window.id,
          windowExternalId: window.externalId,
          platform,
          wechatUserid: operator.wechatUserId,
          loginStatus: 'unknown',
          monitoringEnabled: false,
        },
      });
      created.push(account);
    }

    res.status(201).json({ success: true, data: { platform, accounts: created } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '添加平台失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 2: 验证编译无 operatorPlatform 错误（此接口）**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "operators.ts(47[6-9]\|operators.ts(48[0-9]"
```
Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor(operators): 添加平台接口迁移到 PlatformAccount

平台账号属于窗口（DB spec 3.2）。旧逻辑在已删的 OperatorPlatform 建绑定，
改为遍历操作员绑定窗口 upsert PlatformAccount(windowId+platform)。
无绑定窗口时提示先绑窗口。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 迁移"删除平台"接口到 PlatformAccount

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 498-549 行, DELETE `/:id/platforms/:platform`)

旧逻辑先删 operatorPlatform 再删 platformAccount（重复）。新逻辑直接删 platformAccount，FK 级联处理 Video/Comment。

- [ ] **Step 1: 替换 DELETE /:id/platforms/:platform 路由处理体**

将第 498-549 行替换为：

```typescript
/** DELETE /api/v1/operators/:id/platforms/:platform — 移除操作员所有窗口下的该平台账号 */
router.delete('/:id/platforms/:platform', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      id: z.coerce.number().int().positive(),
      platform: z.string().min(1),
    });

    const { id, platform } = schema.parse(req.params);

    // 查出操作员所有绑定窗口下的该平台账号 ID
    const accountsToDelete = await prisma.platformAccount.findMany({
      where: { window: { boundOperatorId: id }, platform },
      select: { id: true },
    });
    const accountIds = accountsToDelete.map((a) => a.id);

    // 删除 PlatformAccount — FK 级联会处理 Video/Comment 等子表
    if (accountIds.length > 0) {
      await prisma.platformAccount.deleteMany({
        where: { id: { in: accountIds } },
      });
      logger.info({ operatorId: id, platform, deletedCount: accountIds.length }, '已清理对应的平台账号');
      // 注：BullMQ 残留任务由调度器在下次轮询时按 platform_accounts 自然重试，无需主动清理
    }

    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '移除平台失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 2: 验证编译无 operatorPlatform 错误（此接口）**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "operators.ts(51[0-9]"
```
Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor(operators): 删除平台接口迁移到 PlatformAccount

移除对已删 OperatorPlatform 的 delete 调用，直接删 PlatformAccount，
FK 级联处理子表。去重重复删除逻辑。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 迁移 verify-login 到 PlatformAccount + LoginVerification

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 555-691 行)

旧逻辑用 operatorPlatform 更新 loginStatus/lastVerifiedAt、loginVerification 传 operatorId。新逻辑：loginStatus 写入各窗口的 PlatformAccount，LoginVerification 用 windowId+platform 写入实际验证窗口。

- [ ] **Step 1: 替换 verify-login 路由内的状态更新与日志记录**

定位第 580-583 行（`// 更新状态为检查中`），替换：
```typescript
    // 更新状态为检查中
    await prisma.operatorPlatform.update({
      where: { idx_operator_platform: { operatorId: id, platform } },
      data: { loginStatus: 'checking' },
    });
```
为：
```typescript
    // 更新状态为检查中（所有绑定窗口的该平台账号）
    await prisma.platformAccount.updateMany({
      where: { window: { boundOperatorId: id }, platform },
      data: { loginStatus: 'checking' },
    });
```

- [ ] **Step 2: 替换"获取上次登录状态"段**

定位第 633-637 行，替换：
```typescript
    // 获取之前的登录状态，用于检测状态变化
    const previousPlatform = await prisma.operatorPlatform.findUnique({
      where: { idx_operator_platform: { operatorId: id, platform } },
      select: { loginStatus: true },
    });
    const previousStatus = previousPlatform?.loginStatus || 'unknown';
```
为：
```typescript
    // 获取之前的登录状态（取任一窗口的该平台账号），用于检测状态变化
    const previousAccount = await prisma.platformAccount.findFirst({
      where: { window: { boundOperatorId: id }, platform },
      select: { loginStatus: true },
    });
    const previousStatus = previousAccount?.loginStatus || 'unknown';
```

- [ ] **Step 3: 替换"更新平台登录状态"段**

定位第 640-643 行，替换：
```typescript
    // 更新平台登录状态（即使验证失败也会执行）
    await prisma.operatorPlatform.update({
      where: { idx_operator_platform: { operatorId: id, platform } },
      data: { loginStatus, lastVerifiedAt: new Date() },
    });
```
为：
```typescript
    // 更新平台登录状态到所有绑定窗口的该平台账号（即使验证失败也会执行）
    await prisma.platformAccount.updateMany({
      where: { window: { boundOperatorId: id }, platform },
      data: { loginStatus, lastVerifiedAt: new Date() },
    });
```

- [ ] **Step 4: 替换 LoginVerification 记录段**

定位第 665-673 行，替换：
```typescript
    // 记录验证日志
    await prisma.loginVerification.create({
      data: {
        operatorId: id,
        platform,
        status: loginStatus,
        detail: JSON.stringify({ detail: bestResult.detail }),
      },
    });
```
为（按最佳结果所在窗口记录；若无从 bestWindowExternalId 反查则用首个窗口）：
```typescript
    // 记录验证日志（LoginVerification 以 windowId+platform 为单元，DB spec 3.9）
    const verifyWindow = operator.windows.find((w) => w.externalId === bestWindowExternalId) || operator.windows[0];
    if (verifyWindow) {
      await prisma.loginVerification.create({
        data: {
          windowId: verifyWindow.id,
          platform,
          status: loginStatus,
          detail: JSON.stringify({ detail: bestResult.detail }),
        },
      });
    }
```

- [ ] **Step 5: 验证编译无 operatorPlatform/loginVerification 错误（verify-login）**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "operators.ts(5[78][0-9]\|operators.ts(6[0-9][0-9])"
```
Expected: 无 operatorPlatform / operatorId 相关错误。

- [ ] **Step 6: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor(operators): verify-login 迁移到 PlatformAccount + LoginVerification(windowId)

loginStatus 写入各窗口 PlatformAccount（updateMany），LoginVerification
改用 windowId+platform（DB spec 3.9），移除 operatorId。移除对已删
OperatorPlatform 的全部调用。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 重构 verify-all 到窗口级 PlatformAccount

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 693-762 行)

旧逻辑 `include: { platforms: true }`（Operator 已无 platforms 关系）并遍历 `op.platforms`。新逻辑：平台归属窗口，遍历每个窗口的 `window.platforms`（PlatformAccount），按窗口更新。

- [ ] **Step 1: 替换 verify-all 路由处理体**

将第 693-762 行替换为：

```typescript
/** POST /api/v1/operators/verify-all — 批量验证所有操作员的所有平台（按窗口） */
router.post('/verify-all', async (_req: Request, res: Response) => {
  try {
    const operators = await prisma.operator.findMany({
      where: { enabled: true },
      include: {
        windows: {
          where: { status: 'bound' },
          include: { platforms: true },
        },
      },
    });

    const results: Array<{ operatorId: number; platform: string; status: string }> = [];
    // 跟踪登录状态变化的 (externalId, platform) 对
    const changedPairs = new Set<string>();

    for (const op of operators) {
      if (op.windows.length === 0) continue;

      // 遍历所有窗口，逐窗口 try/catch；平台账号归属窗口
      for (const window of op.windows) {
        for (const account of window.platforms) {
          try {
            const result = await checkPlatformLogin(
              window.browserVendor as BrowserVendor,
              window.externalId,
              account.platform,
            );
            const loginStatus = result.loggedIn ? 'logged_in' : 'not_logged_in';

            // 检查状态变化
            const previousStatus = account.loginStatus || 'unknown';
            const statusChangedToLoggedIn = previousStatus !== 'logged_in' && loginStatus === 'logged_in';
            if (statusChangedToLoggedIn) {
              changedPairs.add(`${window.externalId}_${account.platform}`);
              logger.info({ operatorId: op.id, platform: account.platform, previousStatus, windowId: window.id }, '批量验证：登录状态变化为已登录');

              // 同时将 PlatformAccount.status 从 'login_required' 恢复为 'active'
              await prisma.platformAccount.updateMany({
                where: {
                  windowId: window.id,
                  platform: account.platform,
                  status: { in: ['login_required', 'risk_control'] },
                },
                data: { status: 'active' },
              }).catch(() => {});
            }

            // 更新该窗口该平台账号的登录状态
            await prisma.platformAccount.updateMany({
              where: { windowId: window.id, platform: account.platform },
              data: { loginStatus, lastVerifiedAt: new Date() },
            });

            results.push({ operatorId: op.id, platform: account.platform, status: loginStatus });
          } catch (err) {
            results.push({ operatorId: op.id, platform: account.platform, status: 'error' });
          }
        }
      }
    }

    // 如果有平台状态变化为已登录，重置对应 (externalId, platform) 的调度器
    for (const pairKey of changedPairs) {
      const lastUnderscore = pairKey.lastIndexOf('_');
      const externalId = pairKey.substring(0, lastUnderscore);
      const platform = pairKey.substring(lastUnderscore + 1);
      logger.info({ externalId, platform }, '批量验证：重置调度器');
      resetSchedulerTimer(externalId, platform);
    }

    res.json({ success: true, data: results });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '批量验证失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 2: 验证 operators.ts 全部编译错误清零**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "operators.ts"
```
Expected: 无输出（0 错误）。

- [ ] **Step 3: 验证 operatorPlatform 引用清零**

Run:
```bash
cd /home/lrp/social_media_complete && grep -n "operatorPlatform" apps/ts-api-gateway/src/routes/operators.ts
```
Expected: 无输出。

- [ ] **Step 4: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor(operators): verify-all 重构为窗口级 PlatformAccount

Operator 已无 platforms 关系（平台归属窗口）。改为 include windows.platforms，
遍历每个窗口的 PlatformAccount 验证并按窗口更新 loginStatus。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 修复 douyinCrawler.ts NodeList 迭代错误

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

TS2488 错误：NodeList 需 `Array.from()` 包裹才能迭代。

- [ ] **Step 1: 定位所有 TS2488 错误行**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts.*TS2488"
```
记录所有行号。

- [ ] **Step 2: 逐处修复 NodeList 迭代**

对每个报错行，按模式修复：

`for (const el of all)` → `for (const el of Array.from(all))`

`containers.forEach((c: Element) => {...})` → `Array.from(containers).forEach((c: Element) => {...})`

`for (const child of el.children)` → `for (const child of Array.from(el.children))`

逐行用 Edit 工具修改，每处保留原缩进与逻辑。

- [ ] **Step 3: 验证 TS2488 清零**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts.*TS2488" || echo "ok"
```
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyinCrawler): NodeList 迭代用 Array.from 包裹

TS2488：tsconfig target 不支持 NodeList 原生迭代，统一 Array.from 包裹。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 修复 douyinCrawler.ts safeEvaluate 返回类型断言

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

`safeEvaluate` 返回 `unknown`，调用方需 `as Type` 断言。涉及 TS2322/TS2339/TS18046/TS2698 等。

- [ ] **Step 1: 定位 safeEvaluate 调用导致类型错误的行**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts" | grep -E "TS2322|TS18046|TS2698|TS2345"
```
记录行号与期望类型。

- [ ] **Step 2: 逐处添加类型断言**

对每个报错行，在 `safeEvaluate(...)` 调用末尾 `opts)` 后补 `as ExpectedType`。模式：

```typescript
// 原
const rootCid = await HumanActions.safeEvaluate(page, fn, opts);
// 改
const rootCid = await HumanActions.safeEvaluate(page, fn, opts) as string;
```

常见期望类型（按上下文判断）：
- 返回字符串 → `as string`
- 返回布尔 → `as boolean`
- 返回数组 → `as SomeType[]`
- 返回坐标对象 → `as { x: number; y: number } | null`
- 返回诊断对象 → `as { length: number } | {}`（并在使用前加 `'length' in obj` 守卫）

对 spread 错误（TS2698）：`{ ...verifyResult }` → `{ ...(verifyResult as Record<string, unknown>) }`

逐行用 Edit 工具修改。

- [ ] **Step 3: 验证类型断言错误减少**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts" | grep -E "TS2322|TS18046|TS2698|TS2345" | wc -l
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyinCrawler): safeEvaluate 返回 unknown 补类型断言

safeEvaluate 返回 unknown，调用方按上下文补 as Type 断言（string/boolean/
对象|null 等），spread 用 Record 断言。仅类型修改不改运行时逻辑。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 修复 douyinCrawler.ts 空对象与 innerText 错误

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

TS2339：`{}` 类型属性访问、`Element` 无 `innerText`。

- [ ] **Step 1: 定位剩余 TS2339 错误**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts.*TS2339"
```
记录行号。

- [ ] **Step 2: 修复空对象属性访问**

对返回 `{}` 的 safeEvaluate，在函数表达式加返回类型注解 + 调用处 `as Type`，使用前加类型守卫。模式：

```typescript
// 原
const btnDiagnostic = await HumanActions.safeEvaluate(page, () => {
  return btn ? { length: btn.textContent?.length || 0 } : {};
});
btnDiagnostic.length  // 错误
// 改
const btnDiagnostic = await HumanActions.safeEvaluate(page, (): { length: number } | {} => {
  return btn ? { length: btn.textContent?.length || 0 } : {};
}, { reason: '...' }) as { length: number } | {};
if ('length' in btnDiagnostic) {
  // 使用 btnDiagnostic.length
}
```

对返回坐标 `{ x, y }` 的，注解为 `as { x: number; y: number } | null`，使用前判空。

- [ ] **Step 3: 修复 Element.innerText**

对 `el.innerText` 报错（el 为 `Element`），改为 `(el as HTMLElement).innerText`。

- [ ] **Step 4: 验证 douyinCrawler.ts 全部错误清零**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler.ts" || echo "ok"
```
Expected: `ok`

- [ ] **Step 5: 运行测试验证功能不回归**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest 2>&1 | tail -20
```
Expected: 全部测试通过。

- [ ] **Step 6: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyinCrawler): 空对象属性访问与 Element.innerText 类型修复

safeEvaluate 返回空对象补返回类型注解+断言+类型守卫；Element 转
HTMLElement 访问 innerText。仅类型修改。douyinCrawler.ts 编译零错误。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: 后端清理 GET / 操作员列表的扁平化 platforms 字段

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/operators.ts` (第 42-66 行)

`GET /` 行 55-59 的"扁平化 `operator.platforms`"是 OperatorPlatform 时代遗留（Operator 已无 platforms 关系）。主从面板统一用 `op.windows[].platforms` 三级嵌套，删除扁平化避免误导。

- [ ] **Step 1: 替换 GET / 路由处理体**

将第 42-66 行替换为（去掉扁平化，直接返回三级嵌套）：

```typescript
router.get('/', async (_req: Request, res: Response) => {
  try {
    const operators = await prisma.operator.findMany({
      include: {
        windows: {
          include: {
            platforms: { select: { id: true, platform: true, loginStatus: true, lastVerifiedAt: true, monitoringEnabled: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: operators });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取操作员列表失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 2: 验证 operators.ts 编译无错**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "operators.ts" || echo "ok"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor(operators): GET / 删除遗留扁平化 platforms，返回三级嵌套

Operator 已无 platforms 关系（DB 重构后平台归属窗口）。
删除 operator.platforms 扁平化，前端主从面板统一用
op.windows[].platforms 三级嵌套。platforms select 补 id/monitoringEnabled。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: 前端类型更新——Operator.windows 补 platforms 嵌套

**Files:**
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts` (第 1412-1422 行)

`Operator` 类型 `windows` 当前缺 `platforms` 嵌套字段，且顶层 `platforms` 扁平字段应删（对齐后端 Task 10）。

- [ ] **Step 1: 更新 Operator 类型定义**

将第 1412-1422 行替换为：

```typescript
export type Operator = {
  id: number;
  wechatUserId: string;
  displayName: string;
  phone?: string;
  role: 'admin' | 'operator';
  enabled: boolean;
  windows: Array<{
    id: number;
    externalId: string;
    browserVendor: string;
    windowName: string;
    platforms: Array<{ id: number; platform: string; loginStatus: string; lastVerifiedAt?: string; monitoringEnabled: boolean }>;
  }>;
  createdAt: string;
};
```

- [ ] **Step 2: 排查顶层 platforms 扁平字段的其他引用**

Run:
```bash
cd /home/lrp/social_media_complete && grep -rn "\.platforms" apps/admin-dashboard/src/ --include="*.tsx" --include="*.ts" | grep -v "windows\." | grep -v "useApi.ts"
```
Expected: 无输出或仅注释。若有组件仍读 `operator.platforms`，需改为 `operator.windows.flatMap(w => w.platforms)` 或在对应窗口上下文内读 `window.platforms`。

- [ ] **Step 3: 验证前端类型构建**

Run:
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && pnpm build 2>&1 | grep -iE "error|platforms" | head
```
Expected: 无类型错误（Task 12 改组件前可能有遗留引用，记录但本步仅确认类型定义本身正确）。

- [ ] **Step 4: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "refactor(admin): Operator 类型补 windows[].platforms 嵌套，删顶层扁平字段

对齐后端三级嵌套返回。Operator.windows.platforms 含
id/platform/loginStatus/lastVerifiedAt/monitoringEnabled。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: 前端主从面板重构——左操作员列表 + 右详情

**Files:**
- Modify: `apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx`

把单一混合组件改为主从面板：左栏操作员列表（含独立新增入口），右栏选中操作员的窗口+平台账号详情。解决"只能 1:1 绑定"——一个操作员可绑多个窗口，每窗口独立管平台。

- [ ] **Step 1: 读取当前组件结构**

读取 `OperatorManagement.tsx` 全文，确认现有状态（formWechatId/formDisplayName/formPhone/formWindowId/editingId/showAddForm）与现有窗口网格渲染逻辑，本任务将整体重构。

- [ ] **Step 2: 引入主从面板布局与状态**

在组件顶部新增选中操作员状态，解构所需 hooks：

```typescript
const { data: operators = [] } = useOperators();
const { data: windowsData } = useBrowserWindows('all');
const windows = windowsData?.windows ?? [];
const bindWindow = useBindWindow();
const unbindWindow = useUnbindWindow();
const addPlatform = useAddPlatform();
const removePlatform = useRemovePlatform();
const verifyLogin = useVerifyLogin();
const [selectedOperatorId, setSelectedOperatorId] = useState<number | null>(null);
const selectedOperator = operators.find((o) => o.id === selectedOperatorId) || null;
const unboundWindows = windows.filter((w) => w.status === 'available');
const [addWindowForOp, setAddWindowForOp] = useState<number | null>(null);
const [addPlatformForWindow, setAddPlatformForWindow] = useState<number | null>(null);
const [newPlatformKey, setNewPlatformKey] = useState('');
```

- [ ] **Step 3: 操作员表单移除窗口字段**

删除"添加/编辑表单"内"绑定窗口（可选）"`<select>` 块。操作员表单仅保留：企微ID（含获取ID按钮）、显示名称、手机号。`handleCreate` 移除 `formWindowId` 分支：

```typescript
  const handleCreate = () => {
    if (!formWechatId.trim() || !formDisplayName.trim()) return;
    createOperator.mutate(
      { wechatUserId: formWechatId.trim(), displayName: formDisplayName.trim(), phone: formPhone.trim() || undefined },
      {
        onSuccess: () => { resetForm(); },
        onError: (err: any) => {
          alert(`创建操作员失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };
```

删除 `formWindowId` 状态声明及 `resetForm` 中对应行。

- [ ] **Step 4: 重构主体为主从面板布局**

替换主体渲染为左右两栏（响应式：md 以下单列堆叠）：

```tsx
return (
  <div className="space-y-4">
    {/* Header */}
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-headline-md text-on-surface">操作员管理</h2>
        <p className="text-body-sm text-on-surface-variant mt-1">
          每个操作员对应一个企业微信用户，可绑定多个窗口，每个窗口独立管理平台账号。
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => syncWindows.mutate(selectedVendor)} disabled={syncWindows.isPending} className="btn-ghost flex items-center gap-1.5 text-sm">
          <MaterialIcon icon="sync" size="sm" className={syncWindows.isPending ? 'animate-spin-slow' : ''} />
          {syncWindows.isPending ? '同步中…' : '同步窗口'}
        </button>
        <button onClick={() => { setShowAddForm(true); setEditingId(null); setFormWechatId(''); setFormDisplayName(''); setFormPhone(''); }} className="btn-primary flex items-center gap-1.5">
          <MaterialIcon icon="add" size="sm" />
          新增操作员
        </button>
      </div>
    </div>

    {/* 主从面板 */}
    <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
      {/* 左栏：操作员列表 */}
      <div className="space-y-2">
        {operators.length === 0 && <p className="text-body-sm text-on-surface-variant p-3">暂无操作员，点击"新增操作员"创建。</p>}
        {operators.map((op) => (
          <button
            key={op.id}
            onClick={() => setSelectedOperatorId(op.id)}
            className={cn(
              'w-full text-left p-3 rounded-xl border transition-colors',
              selectedOperatorId === op.id ? 'border-primary bg-primary/5' : 'border-outline-variant hover:border-primary/30 bg-surface',
            )}
          >
            <p className="text-body-sm font-medium text-on-surface truncate">{op.displayName}</p>
            <p className="text-xs text-on-surface-variant truncate">{op.wechatUserId}</p>
            <p className="text-xs text-on-surface-variant mt-1">{op.windows.length} 个窗口</p>
          </button>
        ))}
      </div>

      {/* 右栏：操作员详情 */}
      <div>
        {selectedOperator ? <OperatorDetail /> : (
          <div className="p-8 text-center text-body-sm text-on-surface-variant border border-dashed border-outline-variant rounded-xl">
            请从左侧选择一个操作员查看详情
          </div>
        )}
      </div>
    </div>

    {/* 未绑定窗口池 */}
    {unboundWindows.length > 0 && (
      <div className="p-3 bg-surface-container rounded-xl border border-outline-variant">
        <h4 className="text-label-md text-on-surface-variant mb-2">未绑定窗口池 ({unboundWindows.length})</h4>
        <div className="flex flex-wrap gap-2">
          {unboundWindows.map((w) => (
            <span key={w.id} className="text-xs px-2 py-1 rounded-lg border border-outline-variant bg-surface text-on-surface-variant">
              {w.windowName || w.externalId} ({w.browserVendor})
            </span>
          ))}
        </div>
      </div>
    )}

    {/* 操作员表单（新增/编辑）—— 保留原有 showAddForm 逻辑 */}
  </div>
);
```

- [ ] **Step 5: 实现 OperatorDetail 子组件（窗口+平台账号）**

在 `OperatorManagement` 内或同级定义 `OperatorDetail`，渲染选中操作员的窗口列表与每窗口的平台账号：

```tsx
function OperatorDetail({ operator, unboundWindows, bindWindow, unbindWindow, addPlatform, removePlatform, verifyLogin }: any) {
  const [addWindowOpen, setAddWindowOpen] = useState(false);
  const [pickWindowId, setPickWindowId] = useState<number | null>(null);
  const [addPlatformForWindow, setAddPlatformForWindow] = useState<number | null>(null);
  const [newPlatformKey, setNewPlatformKey] = useState('');

  const handleBind = () => {
    if (!pickWindowId) return;
    bindWindow.mutate({ windowId: pickWindowId, operatorId: operator.id }, { onSuccess: () => { setAddWindowOpen(false); setPickWindowId(null); } });
  };

  const handleAddPlatform = (windowId: number) => {
    if (!newPlatformKey) return;
    addPlatform.mutate({ operatorId: operator.id, platform: newPlatformKey }, { onSuccess: () => { setAddPlatformForWindow(null); setNewPlatformKey(''); } });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-title-md text-on-surface">{operator.displayName}</h3>
          <p className="text-xs text-on-surface-variant">企微ID: {operator.wechatUserId} · {operator.windows.length} 个绑定窗口</p>
        </div>
        <button onClick={() => setAddWindowOpen(!addWindowOpen)} className="btn-ghost text-xs flex items-center gap-1">
          <MaterialIcon icon="add" size="xs" />
          添加窗口
        </button>
      </div>

      {/* 添加窗口下拉：从未绑定窗口池选一个 */}
      {addWindowOpen && (
        <div className="p-3 bg-surface-container-lowest rounded-xl border border-primary/30">
          <div className="flex gap-2">
            <select className="form-input flex-1" value={pickWindowId ?? ''} onChange={(e) => setPickWindowId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">选择未绑定窗口…</option>
              {unboundWindows.map((w: any) => (
                <option key={w.id} value={w.id}>{w.windowName || w.externalId} ({w.browserVendor})</option>
              ))}
            </select>
            <button className="btn-primary text-xs" onClick={handleBind} disabled={!pickWindowId || bindWindow.isPending}>绑定</button>
            <button className="btn-ghost text-xs" onClick={() => { setAddWindowOpen(false); setPickWindowId(null); }}>取消</button>
          </div>
        </div>
      )}

      {/* 每个绑定窗口：独立管理平台账号 */}
      {operator.windows.length === 0 && <p className="text-body-sm text-on-surface-variant p-4 border border-dashed border-outline-variant rounded-xl">该操作员尚未绑定窗口，点击"添加窗口"开始。</p>}
      {operator.windows.map((w: any) => (
        <div key={w.id} className="p-3 rounded-xl border border-outline-variant bg-surface">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <MaterialIcon icon="open_in_new" size="sm" className="text-primary" />
              <span className="text-body-sm font-medium text-on-surface">{w.windowName || w.externalId}</span>
              <span className="text-xs text-on-surface-variant">({w.browserVendor})</span>
            </div>
            <button onClick={() => unbindWindow.mutate(w.id)} disabled={unbindWindow.isPending} className="text-xs text-on-surface-variant hover:text-error flex items-center gap-1">
              <MaterialIcon icon="link_off" size="xs" />
              解绑
            </button>
          </div>

          {/* 该窗口的平台账号（各自独立） */}
          <div className="space-y-1.5">
            {(w.platforms || []).map((p: any) => (
              <PlatformRow
                key={p.id || p.platform}
                platform={p.platform}
                loginStatus={p.loginStatus}
                onVerify={() => verifyLogin.mutate({ operatorId: operator.id, platform: p.platform })}
                onRemove={() => removePlatform.mutate({ operatorId: operator.id, platform: p.platform })}
                verifying={verifyLogin.isPending}
              />
            ))}
            {(w.platforms || []).length === 0 && <p className="text-xs text-on-surface-variant pl-7">该窗口暂无平台账号</p>}
          </div>

          {/* 添加平台（针对该窗口） */}
          {addPlatformForWindow === w.id ? (
            <div className="mt-2 flex gap-2">
              <select className="form-input flex-1 text-xs" value={newPlatformKey} onChange={(e) => setNewPlatformKey(e.target.value)}>
                <option value="">选择平台…</option>
                {PLATFORM_OPTIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <button className="btn-primary text-xs" onClick={() => handleAddPlatform(w.id)} disabled={!newPlatformKey || addPlatform.isPending}>添加</button>
              <button className="btn-ghost text-xs" onClick={() => { setAddPlatformForWindow(null); setNewPlatformKey(''); }}>取消</button>
            </div>
          ) : (
            <button onClick={() => setAddPlatformForWindow(w.id)} className="mt-2 text-xs text-primary hover:underline flex items-center gap-1">
              <MaterialIcon icon="add" size="xs" />
              添加平台
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

将 `OperatorDetail` 渲染到右栏（传入 operator、unboundWindows、各 mutation）。

- [ ] **Step 6: 移除旧的窗口网格（BitBrowser/RoxyBrowser 分组）**

删除原"查看可用窗口"折叠区与 BitBrowser/RoxyBrowser 分组网格（被主从面板的窗口列表+未绑定窗口池替代）。同步窗口按钮与"添加窗口"创建窗口表单（showCreateWindow）保留。

- [ ] **Step 7: 验证前端构建**

Run:
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && pnpm build 2>&1 | tail -20
```
Expected: 构建成功，无类型错误。

- [ ] **Step 8: Commit**

```bash
cd /home/lrp/social_media_complete
git add apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx
git commit -m "refactor(admin): 操作员主从面板——一操作员多窗口，每窗口独立管平台

DB spec 4.9 方案C：左操作员列表 + 右操作员详情。一个操作员可绑多个
窗口（添加窗口从未绑定池选），每个窗口下独立管理平台账号（添加平台/
验证登录/移除）。解决原 UI 只能 1:1 绑定的约束。后端 1:N:N 本就支持。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 端到端验证

**Files:**
- Verify: 全链路

- [ ] **Step 1: 重新构建并重启容器**

Run:
```bash
cd /home/lrp/social_media_complete && docker compose up -d --build sm-ts-api sm-admin-dashboard
```
Expected: 两个容器重建并启动。

- [ ] **Step 2: 验证后端启动正常（db push 不报错）**

Run:
```bash
docker logs sm-ts-api --tail 30 2>&1 | grep -iE "error|listening|ready|started" | tail -10
```
Expected: 看到 listening/started，无 users 表相关错误。

- [ ] **Step 3: 验证 users 表未重建**

Run:
```bash
docker exec sm-postgres psql -U sm_admin -d social_media -t -c "SELECT to_regclass('users');"
```
Expected: 空输出。

- [ ] **Step 4: 验证涉及文件编译零错误**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -E "operators.ts|douyinCrawler.ts" || echo "ok"
```
Expected: `ok`

- [ ] **Step 5: 验证前端主从面板渲染**

打开浏览器访问 admin-dashboard，进入"用户管理"tab：
- 左栏「操作员列表」，"新增操作员"按钮，表单无窗口字段。
- 选中操作员后右栏显示其绑定窗口列表。
- "添加窗口"下拉列出未绑定窗口，选定后该窗口加入操作员（可重复添加多个窗口）。
- 每个窗口卡片内显示该窗口平台账号 + "添加平台" + "验证登录"。
- 底部"未绑定窗口池"列出未绑定操作员的窗口。

- [ ] **Step 6: 端到端流程验证（一操作员多窗口）**

1. 「新增操作员」→ 填企微ID+名称 → 创建成功，左栏出现。
2. 选中该操作员 → 右栏"添加窗口" → 从未绑定池选窗口A绑定 → 窗口A出现在详情。
3. 再次"添加窗口" → 选窗口B绑定 → 同一操作员现绑 2 个窗口（验证 1:N）。
4. 在窗口A卡片"添加平台" → 选抖音 → platform_accounts 写入窗口A的记录：
```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "SELECT id, window_id, platform, login_status FROM platform_accounts;"
```
Expected: window_id 对应窗口A。
5. 在窗口B卡片"添加平台" → 选快手 → 验证窗口B有独立快手账号，与窗口A的抖音互不影响。
6. verify-login → platform_accounts.loginStatus 更新、login_verifications 写入 windowId+platform：
```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "SELECT window_id, platform, status FROM login_verifications;"
```
Expected: 无 operatorId 列，含 window_id。

- [ ] **Step 7: 运行测试套件**

Run:
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest 2>&1 | tail -10
```
Expected: 全部通过。

- [ ] **Step 8: 最终 Commit（如有验证中的小修）**

```bash
git add -A
git commit -m "test: 端到端验证通过——两设计融合落地

删 users 孤儿、operators.ts 迁移 PlatformAccount、douyinCrawler 编译清零、
前端主从面板（一操作员多窗口、每窗口独立管平台）。链路通畅。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 自校验

**1. Spec 覆盖：**

| spec 改动域 | 对应 Task |
|---|---|
| 改动域2 删 users 孤儿 | Task 1 |
| 改动域5 operators.ts 迁移（monitorQueue/operatorPlatform/loginVerification/verify-all） | Task 2,3,4,5,6 |
| 改动域3 编译清零（douyinCrawler） | Task 7,8,9 |
| 改动域1 前端主从面板 + GET/ 扁平化清理 + 类型 | Task 10,11,12 |
| 改动域1 前端双区块 | Task 10,11 |
| 端到端验证 | Task 12 |
| 改动域4 多窗口遍历 | 已核查落地，无 Task |

覆盖完整。

**2. 占位符扫描：** 无 TBD/TODO，每个代码步骤含完整代码。

**3. 类型一致性：**
- PlatformAccount 唯一键名 `idx_platform_account_window_platform`（Task 3/5/6 一致，来自 schema 第 378 行）
- `bindWindow({ windowId, operatorId })`（Task 12 与 hooks 第 1500 行一致）
- LoginVerification 字段 `windowId/platform/status/detail`（Task 5 与 schema 第 384-396 行一致）
- `Operator.windows[].platforms` 嵌套（Task 11 类型 与 Task 10 后端 select 与 Task 12 消费一致，含 id/platform/loginStatus/lastVerifiedAt/monitoringEnabled）
- `useAddPlatform({ operatorId, platform })`（Task 12 与 hooks 第 1524 行一致）
- `useVerifyLogin` 入参（Task 12 与 hooks 第 1539 行一致，调用前确认签名）

---

## 成功标准

1. `User` 模型删除、`users` 物理表删除、重启不重建（Task 1, 13-Step3）。
2. `operators.ts` 无 `prisma.operatorPlatform` / `monitorQueue` 残留，平台操作走 `platformAccount`，`loginVerification` 用 windowId+platform，GET / 无扁平化 platforms（Task 2-6, 10, 13-Step4）。
3. `operators.ts` 与 `douyinCrawler.ts` tsc 零错误（Task 6-Step2, 9-Step4, 13-Step4）。
4. 前端主从面板：左操作员列表（独立新增入口）+ 右详情（一操作员可绑多窗口、每窗口独立管平台）（Task 10-12, 13-Step5）。
5. 端到端：建操作员→绑多窗口→各窗口加平台→验证登录，platform_accounts/login_verifications 写入正确、一操作员多窗口生效（Task 13-Step6）。
6. `npx jest` 全绿（Task 9-Step5, 13-Step7）。

---

## 附录：抖音 v2 反检测收口现状（2026-06-26）

> 参考 spec: `docs/superpowers/specs/2026-06-25-anti-detection-douyin-pilot-design.md`
> 双路径架构：`isAntiDetectionV2()` 控制 `v2（HumanActions.safeEvaluate）` / `legacy（page.evaluate）` 分支切换。参见 spec 第 9.7 条回滚策略。

### 收口完成度概览

| 文件 | v2 分支数 | 状态 | 说明 |
|------|----------|------|------|
| `douyinCrawler.ts` | 44 处 `isAntiDetectionV2()` | ✅ ~95% | `page.evaluate()` → `HumanActions.safeEvaluate()` / `HumanActions.exists()` / `HumanActions.readAll()` |
| `platforms/douyin.ts` | 5 处 `isAntiDetectionV2()` | ✅ 发布路径全覆盖 | 填写(click/fill)→点击发布→结果检查 全部走 v2 |
| `services/loginFlowHelpers.ts` | 4 处 `isAntiDetectionV2()` | ✅ 登录流程全覆盖 | 登录态检查/二维码扫码/SMS 验证码入口 全部走 v2 |

### douyinCrawler.ts 已收口项（44 处分支）

| 类别 | v2 路径 | 覆盖场景 |
|------|---------|---------|
| `page.evaluate()` → `HumanActions.safeEvaluate()` | `safeEvaluate(page, fn, { reason, world, args })` | 抖音视频列表解析、评论树提取、回复按钮定位、根评论 cid 读取、展开按钮查找、抽屉内容提取等 |
| 元素查找/可见性 | `HumanActions.cdpIsElementVisible()` + `HumanActions.exists()` | 侧边栏、子菜单、视频列表、选择器可见性 |
| 点击操作 | `HumanActions.cdpClick()` / `HumanActions.cdpClickByText()` / `HumanActions.cdpClickNode()` | 视频行点击、按钮点击、节点点击 |
| 滚动操作 | `HumanActions.cdpSmartScroll()` + `HumanActions.humanScroll()` | 评论区滚动、抽屉滚动、视口滚动 |
| 键盘输入 | `HumanActions.cdpKeyboard()` | 搜索输入、评论回复输入 |

### ❌ 剩余盲区（5 处，无 v2 分支）

| 位置 | 操作 | 风险等级 | 说明 |
|------|------|---------|------|
| `submitVerifyCode()` (~行1033-1086) | `page.$$` + `input.fill()` + `btn.click()` × 6 处 | 🟡 中 | SMS 验证码提交流程，触发频率低（仅需重登录时） |
| `expandRepliesForRoot()` (~行1268) | `page.$$eval` × 1 处 | 🟢 低 | 子回复 DOM 展开查询，纯读取操作 |
| `captureRiskScene()` (~行1493) | `page.screenshot()` × 1 处 | 🟢 低 | 风控现场截图，仅调试/审计用 |
| `warmUp()` (~行167) | `page.goto()` × 1 处 | 🟢 低 | 预热阶段导航到抖音首页，非业务路径 |
| `navigateToCreatorHome()` (~行204) | `page.goto()` × 1 处 | 🟢 低 | 导航回退路径，仅创作者中心跳转失败时用 |

### 非盲区但需关注的裸调用

以下调用在 legacy 分支中正常运行，v2 模式下已走 HumanActions，但本身无 v2 分支守卫（属基础设施层，不宜加业务分支）：

| 位置 | 操作 | 说明 |
|------|------|------|
| `douyin.ts:37,87,298` | `page.goto()` × 3 处 | 发布页导航，属于页面跳转基础操作，HumanActions 暂无 goto 封装 |
| `loginFlowHelpers.ts` | `page.$()` × 8 处 | 元素查询（含 v2 分支内），HumanActions 无 $ 原生替代 |

### 架构说明

```
            isAntiDetectionV2() ?
           /                    \
    v2 路径                       legacy 路径
    ┌─────────────────┐          ┌──────────────┐
    │ HumanActions     │          │ page.evaluate │
    │ .safeEvaluate()  │          │ page.$$       │
    │ .cdpClick()      │          │ page.$$eval   │
    │ .cdpSmartScroll()│          │ page.goto     │
    │ .exists()        │          │ page.screenshot│
    └─────────────────┘          └──────────────┘
            │                           │
            └───────────┬───────────────┘
                        │
              共享层（两路径共用）
              HumanActions.cdpClickByText / humanScroll / wait
```

**关键文件**：`apps/ts-api-gateway/src/lib/antiDetectionMode.ts` 暴露 `isAntiDetectionV2()`，内部读 `ANTI_DETECTION_MODE` 环境变量。标准操作流程：`legacy` 默认 → 验证期 `v2` → 全量切换后移除 legacy 分支。

### 成功判定（与 spec 第 11 节对齐）

1. **静态零直接调用**：抖音范围文件 `page.evaluate`/`page.$eval`/`page.$$eval` 直接调用数 → 仅限上述 5 处盲区 + legacy 分支内
2. **运行时指标埋点**：`TaskExecutionStep.extra.antiDetection.actionPath` 中 `safeEvaluate-isolated` 占绝大多数（v2 模式）
3. **功能不回归**：抖音三功能（发布/监控/回复）端到端走通
4. **双路径共存**：`ANTI_DETECTION_MODE=legacy|v2` 可切换，回滚无需代码变更
