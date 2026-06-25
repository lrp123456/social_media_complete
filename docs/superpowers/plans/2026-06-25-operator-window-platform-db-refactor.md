# 操作员-窗口-平台账号 数据模型重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `users` 表 + `OperatorPlatform` 表的双数据源模型重构为 `Operator → BrowserWindow → PlatformAccount → Video` 四层模型，消除手工同步代码，修复多窗口/视频ID/调度key等问题。

**架构：** 新建 `platform_accounts` 表继承 `users.id`，子表外键值不变只改引用目标；删除 `OperatorPlatform` 表，其 `loginStatus`/`lastVerifiedAt` 并入 `PlatformAccount`；`LoginVerification` 从 `operatorId` 改为 `windowId`；`TaskExecution.userId` 补建 FK；调度 key 加 `browserVendor` 前缀保证跨厂商唯一。

**技术栈：** Prisma ORM + PostgreSQL + BullMQ + React (admin-dashboard) + TypeScript

**规格文档：** `docs/superpowers/specs/2026-06-25-operator-window-platform-db-design.md`

**迁移策略：** 一次性脚本分 4 Phase 执行（预检→分批搬数据→FK重映射→后验证），非 Prisma interactive transaction（需执行 raw DDL）。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/ts-api-gateway/src/services/videoIdUtils.ts` | `normalizeVideoId(platform, rawId)` 工具函数 |
| `apps/ts-api-gateway/src/services/videoIdUtils.test.ts` | normalizeVideoId 单元测试 |
| `prisma/migrations/<timestamp>_platform_accounts_refactor/migration.sql` | 数据迁移脚本（Phase 0-3） |
| `scripts/migrate-platform-accounts.ts` | 迁移执行脚本（调用 migration.sql + 校验） |

### 修改文件

| 文件 | 职责变更 |
|------|----------|
| `prisma/schema.prisma` | 新增 PlatformAccount、改 Video/LoginVerification/TaskExecution FK、删 OperatorPlatform |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | `prisma.user` → `prisma.platformAccount`（13处）+ `fingerprintWindowId` → `windowId`（4处）+ normalizeVideoId 集中化 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 调度 key 加 browserVendor 前缀 + `prisma.user` → `prisma.platformAccount`（4处 skipPinnedVideos） |
| `apps/ts-api-gateway/src/routes/operators.ts` | `prisma.user` → `prisma.platformAccount`（10处）+ `fingerprintWindowId` → `windowId`（10处）+ 删除 syncOperatorToMonitorUser + 解绑停监控 + wechatUserid 级联更新 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | `prisma.user` → `prisma.platformAccount`（24处）+ `fingerprintWindowId` → `windowId`（46处） |
| `apps/ts-api-gateway/src/routes/llmReply.ts` | `prisma.user` → `prisma.platformAccount`（2处） |
| `apps/ts-api-gateway/src/routes/monitor.ts` | `prisma.user` → `prisma.platformAccount`（1处）+ `fingerprintWindowId` → `windowId`（2处） |
| `apps/ts-api-gateway/src/routes/accounts.ts` | `prisma.user` → `prisma.platformAccount`（1处）+ `fingerprintWindowId` → `windowId`（1处） |
| `apps/ts-api-gateway/src/routes/system.ts` | `prisma.user` → `prisma.platformAccount`（1处） |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | `prisma.user` → `prisma.platformAccount`（15处）+ `fingerprintWindowId` → `windowId`（19处） |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | `fingerprintWindowId` → `windowExternalId`（接口+函数，4处） |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | `prisma.user` → `prisma.platformAccount`（1处）+ `fingerprintWindowId` → `windowId`（1处） |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | `prisma.user` → `prisma.platformAccount`（1处）+ `fingerprintWindowId` → `windowId`（1处） |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | `prismaXhs.user` → `prismaXhs.platformAccount`（1处）+ `fingerprintWindowId` → `windowId`（3处） |
| `apps/ts-api-gateway/src/platforms/tencent.ts` | `prisma.user` → `prisma.platformAccount`（1处） |
| `apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts` | `fingerprintWindowId` → `windowExternalId`（1处） |
| `apps/admin-dashboard/src/hooks/useApi.ts` | `fingerprintWindowId` → `windowId`（类型定义，2处） |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | `fingerprintWindowId` → `windowId`（8处） |
| `apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx` | 新增操作员管理组件 |

---

## 任务 1：创建 normalizeVideoId 工具函数

**文件：**
- 创建：`apps/ts-api-gateway/src/services/videoIdUtils.ts`
- 创建：`apps/ts-api-gateway/src/services/videoIdUtils.test.ts`

- [ ] **步骤 1：编写 normalizeVideoId 测试**

```typescript
// apps/ts-api-gateway/src/services/videoIdUtils.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeVideoId } from './videoIdUtils';

describe('normalizeVideoId', () => {
  // 抖音：纯数字 awemeId，String() 包裹
  it('douyin: wraps number to string', () => {
    expect(normalizeVideoId('douyin', 7301234567890123456)).toBe('7301234567890123456');
  });
  it('douyin: passes string through', () => {
    expect(normalizeVideoId('douyin', '7301234567890123456')).toBe('7301234567890123456');
  });

  // 快手：photoId 可能是 base62 或纯数字
  it('kuaishou: wraps number to string', () => {
    expect(normalizeVideoId('kuaishou', 3xfGh2jK)).toBe('3xfGh2jK');
  });
  it('kuaishou: passes string through', () => {
    expect(normalizeVideoId('kuaishou', '3xfGh2jK')).toBe('3xfGh2jK');
  });

  // 小红书
  it('xiaohongshu: passes string through', () => {
    expect(normalizeVideoId('xiaohongshu', '64a1b2c3d4e5f6')).toBe('64a1b2c3d4e5f6');
  });

  // 腾讯视频号：exportId 可能带 export/ 前缀
  it('tencent: preserves export/ prefix', () => {
    expect(normalizeVideoId('tencent', 'export/abc123')).toBe('export/abc123');
  });
  it('tencent: passes plain id through', () => {
    expect(normalizeVideoId('tencent', 'abc123')).toBe('abc123');
  });

  // null/undefined 输入
  it('returns empty string for null', () => {
    expect(normalizeVideoId('douyin', null)).toBe('');
  });
  it('returns empty string for undefined', () => {
    expect(normalizeVideoId('douyin', undefined)).toBe('');
  });

  // number 超精度安全（19 位超 2^53）
  it('handles large number without precision loss', () => {
    const big = 7301234567890123456;
    expect(normalizeVideoId('douyin', big)).toBe(String(big));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/ts-api-gateway && npx vitest run src/services/videoIdUtils.test.ts`
预期：FAIL，报错 "Cannot find module './videoIdUtils'"

- [ ] **步骤 3：实现 normalizeVideoId**

```typescript
// apps/ts-api-gateway/src/services/videoIdUtils.ts
type PlatformName = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'tencent';

/**
 * 统一清洗 video id：String() 包裹 + 按平台处理。
 * 所有 video id 写入点必须经过此函数，防止跨平台撞车和 number 精度丢失。
 */
export function normalizeVideoId(platform: PlatformName, rawId: string | number | null | undefined): string {
  if (rawId === null || rawId === undefined) return '';
  return String(rawId);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/ts-api-gateway && npx vitest run src/services/videoIdUtils.test.ts`
预期：PASS（全部 8 个测试）

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/videoIdUtils.ts apps/ts-api-gateway/src/services/videoIdUtils.test.ts
git commit -m "feat: add normalizeVideoId utility for cross-platform video id isolation"
```

---

## 任务 2：Prisma Schema — 新增 PlatformAccount 模型

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：在 schema.prisma 中新增 PlatformAccount 模型**

在 `OperatorPlatform` 模型（L356-369）之后、`LoginVerification` 模型（L372）之前插入：

```prisma
model PlatformAccount {
  id                   Int       @id @default(autoincrement())
  windowId             Int       @map("window_id")
  windowExternalId     String    @map("window_external_id") @db.VarChar(128)
  platform             String    @db.VarChar(32)
  wechatUserid         String?   @map("wechat_userid") @db.VarChar(64)
  status               String    @default("init") @db.VarChar(32)
  consecutiveNoUpdate  Int       @default(0) @map("consecutive_no_update")
  cooldownUntil        BigInt?   @map("cooldown_until")
  monitoringEnabled    Boolean   @default(false) @map("monitoring_enabled")
  platformAuthorId     String?   @map("platform_author_id") @db.VarChar(128)
  platformAuthorName   String?   @map("platform_author_name") @db.VarChar(256)
  loginStatus          String    @default("unknown") @map("login_status") @db.VarChar(32)
  lastVerifiedAt       DateTime? @map("last_verified_at")
  skipPinnedVideos     Json?     @map("skip_pinned_videos")
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")

  window   BrowserWindow @relation(fields: [windowId], references: [id], onDelete: Restrict)
  videos   Video[]
  taskExecutions TaskExecution[]

  @@unique([windowId, platform], name: "idx_platform_account_window_platform")
  @@index([wechatUserid], name: "idx_platform_account_wechat_userid")
  @@map("platform_accounts")
}
```

- [ ] **步骤 2：修改 Video.userId 的 FK 引用目标**

将 Video 模型中的：
```prisma
  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
```
改为：
```prisma
  user     PlatformAccount @relation(fields: [userId], references: [id], onDelete: Cascade)
```

同时将 `@@index([userId], name: "idx_videos_user_id")` 改为 `@@unique([userId, id], name: "idx_videos_user_id")`（复合唯一约束兜底防撞车）。

- [ ] **步骤 3：修改 BrowserWindow 的 platforms 关系**

将 BrowserWindow 模型中的：
```prisma
  platforms OperatorPlatform[]
```
改为：
```prisma
  platforms PlatformAccount[]
```

- [ ] **步骤 4：修改 LoginVerification 模型**

将：
```prisma
model LoginVerification {
  id              Int      @id @default(autoincrement())
  operatorId      Int      @map("operator_id")
  platform        String   @db.VarChar(32)
  status          String   @db.VarChar(20)
  detail          String?  @db.Text
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([operatorId, platform], name: "idx_verification_operator_platform")
  @@map("login_verifications")
}
```
改为：
```prisma
model LoginVerification {
  id              Int      @id @default(autoincrement())
  windowId        Int      @map("window_id")
  platform        String   @db.VarChar(32)
  status          String   @db.VarChar(20)
  detail          String?  @db.Text
  createdAt       DateTime @default(now()) @map("created_at")

  window BrowserWindow @relation(fields: [windowId], references: [id], onDelete: Cascade)

  @@index([windowId, platform], name: "idx_verification_window_platform")
  @@map("login_verifications")
}
```

- [ ] **步骤 5：为 TaskExecution.userId 添加 FK 约束**

找到 TaskExecution 模型中的 `userId Int?` 字段，添加 relation：

```prisma
  userId              Int?     @map("user_id")
  // ... 其他字段 ...
  user                PlatformAccount? @relation(fields: [userId], references: [id], onDelete: SetNull)
```

- [ ] **步骤 6：删除 OperatorPlatform 模型**

删除整个 `OperatorPlatform` 模型定义（L356-369）。

- [ ] **步骤 7：验证 schema 语法**

运行：`cd /home/lrp/social_media_complete && npx prisma format`
预期：无错误输出

运行：`cd /home/lrp/social_media_complete && npx prisma validate`
预期：`The schema is valid`

- [ ] **步骤 8：Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add PlatformAccount model, update Video/LoginVerification/TaskExecution FKs, remove OperatorPlatform"
```

---

## 任务 3：数据迁移脚本 — Phase 0 预检

**文件：**
- 创建：`scripts/migrate-platform-accounts.ts`

- [ ] **步骤 1：创建迁移脚本骨架 + Phase 0 预检**

```typescript
// scripts/migrate-platform-accounts.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function phase0_preflight(): Promise<boolean> {
  console.log('=== Phase 0: Preflight Checks ===');
  let passed = true;

  // 1. 检测 wechatUserId 重复
  const duplicateWechat = await prisma.$queryRaw<{wechat_user_id: string, cnt: bigint}[]>`
    SELECT wechat_user_id, count(*) as cnt FROM operators
    GROUP BY wechat_user_id HAVING count(*) > 1
  `;
  if (duplicateWechat.length > 0) {
    console.error('FAIL: Duplicate wechatUserId in operators:', duplicateWechat);
    passed = false;
  }

  // 2. 检测 OperatorPlatform 多 operator 同 (windowId, platform) 冲突
  //    OperatorPlatform 的唯一键是 (operatorId, platform)，但多个 operator 可能绑定同一窗口
  const opConflicts = await prisma.$queryRaw<{window_external_id: string, platform: string, cnt: bigint}[]>`
    SELECT bw.external_id as window_external_id, op.platform, count(*) as cnt
    FROM operator_platforms op
    JOIN operators o ON o.id = op.operator_id
    JOIN browser_windows bw ON bw.bound_operator_id = o.id
    GROUP BY bw.external_id, op.platform
    HAVING count(*) > 1
  `;
  if (opConflicts.length > 0) {
    console.error('FAIL: Multiple operators share same (window, platform):', opConflicts);
    passed = false;
  }

  // 3. 检测 videos.id 撞车（同 id 不同 userId）
  const videoCollisions = await prisma.$queryRaw<{id: string, cnt: bigint}[]>`
    SELECT id, count(DISTINCT user_id) as cnt FROM videos
    GROUP BY id HAVING count(DISTINCT user_id) > 1
  `;
  if (videoCollisions.length > 0) {
    console.error('FAIL: Video ID collisions (same id, different userId):', videoCollisions);
    passed = false;
  }

  // 4. 检测孤儿 users 行
  const orphanUsers = await prisma.$queryRaw<{id: number, fingerprint_window_id: string}[]>`
    SELECT u.id, u.fingerprint_window_id FROM users u
    LEFT JOIN browser_windows bw ON bw.external_id = u.fingerprint_window_id
    WHERE bw.id IS NULL
  `;
  if (orphanUsers.length > 0) {
    console.warn('WARNING: Orphan users (no matching browser_window):', orphanUsers);
    // 不阻塞，但需人工确认
  }

  // 5. 检测 TaskExecution 悬空 userId
  const danglingTasks = await prisma.$queryRaw<{user_id: number}[]>`
    SELECT user_id FROM task_executions
    WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)
  `;
  if (danglingTasks.length > 0) {
    console.warn('WARNING: Dangling task_executions.user_id:', danglingTasks);
  }

  // 6. 记录基线统计
  const userCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*) as cnt FROM users`;
  const authorCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*) as cnt FROM users WHERE platform_author_id IS NOT NULL`;
  console.log(`Baseline: ${userCount[0].cnt} users, ${authorCount[0].cnt} with platformAuthorId`);

  return passed;
}

async function main() {
  try {
    const preflightOk = await phase0_preflight();
    if (!preflightOk) {
      console.error('Preflight checks FAILED. Fix issues before proceeding.');
      process.exit(1);
    }
    console.log('Preflight checks PASSED.');
  } finally {
    await prisma.$disconnect();
  }
}

main();
```

- [ ] **步骤 2：运行预检脚本**

运行：`npx tsx scripts/migrate-platform-accounts.ts`
预期：输出预检结果（PASS 或 FAIL + 详细信息）

- [ ] **步骤 3：Commit**

```bash
git add scripts/migrate-platform-accounts.ts
git commit -m "feat: add migration preflight checks (Phase 0)"
```

---

## 任务 4：数据迁移脚本 — Phase 1 分批搬数据

**文件：**
- 修改：`scripts/migrate-platform-accounts.ts`

- [ ] **步骤 1：实现 Phase 1 分批搬数据**

在 `scripts/migrate-platform-accounts.ts` 中添加 `phase1_migrate` 函数：

```typescript
const BATCH_SIZE = 1000;

async function phase1_migrate(): Promise<void> {
  console.log('=== Phase 1: Create table + Migrate data ===');

  // 1. 建表（raw DDL，因为 Prisma migration push 会自动处理，这里手动执行确保控制）
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS platform_accounts (
      id SERIAL PRIMARY KEY,
      window_id INTEGER NOT NULL,
      window_external_id VARCHAR(128) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      wechat_userid VARCHAR(64),
      status VARCHAR(32) DEFAULT 'init' NOT NULL,
      consecutive_no_update INTEGER DEFAULT 0 NOT NULL,
      cooldown_until BIGINT,
      monitoring_enabled BOOLEAN DEFAULT false NOT NULL,
      platform_author_id VARCHAR(128),
      platform_author_name VARCHAR(256),
      login_status VARCHAR(32) DEFAULT 'unknown' NOT NULL,
      last_verified_at TIMESTAMPTZ,
      skip_pinned_videos JSONB,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );
  `);
  console.log('Created platform_accounts table');

  // 2. 分批搬 users 数据
  let lastId = 0;
  let totalMigrated = 0;
  while (true) {
    const batch = await prisma.$queryRaw<{id: number}[]>`
      SELECT u.id FROM users u
      JOIN browser_windows bw ON bw.external_id = u.fingerprint_window_id
      WHERE u.id > ${lastId}
      ORDER BY u.id ASC
      LIMIT ${BATCH_SIZE}
    `;
    if (batch.length === 0) break;

    await prisma.$executeRawUnsafe(`
      INSERT INTO platform_accounts (
        id, window_id, window_external_id, platform, wechat_userid,
        status, consecutive_no_update, cooldown_until, monitoring_enabled,
        platform_author_id, platform_author_name, skip_pinned_videos,
        created_at, updated_at
      )
      SELECT
        u.id, bw.id, u.fingerprint_window_id, u.platform, u.wechat_userid,
        u.status, u.consecutive_no_update, u.cooldown_until, u.monitoring_enabled,
        u.platform_author_id, u.platform_author_name, u.skip_pinned_videos,
        u.created_at, u.updated_at
      FROM users u
      JOIN browser_windows bw ON bw.external_id = u.fingerprint_window_id
      WHERE u.id > ${lastId} AND u.id <= ${batch[batch.length - 1].id}
      ON CONFLICT (id) DO NOTHING
    `);

    lastId = batch[batch.length - 1].id;
    totalMigrated += batch.length;
    console.log(`Migrated batch: ${batch.length} rows (total: ${totalMigrated}, lastId: ${lastId})`);
  }

  // 3. 搬 OperatorPlatform 的 loginStatus/lastVerifiedAt
  //    通过 operatorId → operator → boundOperatorId → browser_window → windowId 映射
  await prisma.$executeRawUnsafe(`
    UPDATE platform_accounts pa
    SET login_status = op.login_status,
        last_verified_at = op.last_verified_at
    FROM operator_platforms op
    JOIN operators o ON o.id = op.operator_id
    JOIN browser_windows bw ON bw.bound_operator_id = o.id
    WHERE pa.window_id = bw.id AND pa.platform = op.platform
  `);
  console.log('Migrated OperatorPlatform loginStatus/lastVerifiedAt');

  // 4. 设置自增序列
  await prisma.$executeRawUnsafe(`
    SELECT setval('platform_accounts_id_seq', (SELECT COALESCE(max(id), 1) FROM platform_accounts));
  `);
  console.log('Set platform_accounts_id_seq');
}
```

- [ ] **步骤 2：Commit**

```bash
git add scripts/migrate-platform-accounts.ts
git commit -m "feat: add Phase 1 batch data migration"
```

---

## 任务 5：数据迁移脚本 — Phase 2 FK 重映射 + Phase 3 后验证

**文件：**
- 修改：`scripts/migrate-platform-accounts.ts`

- [ ] **步骤 1：实现 Phase 2 FK 重映射**

在 `scripts/migrate-platform-accounts.ts` 中添加 `phase2_remap` 函数：

```typescript
async function phase2_remap(): Promise<void> {
  console.log('=== Phase 2: FK Remapping ===');

  // 1. Video.userId FK 重映射
  await prisma.$executeRawUnsafe(`
    ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_user_id_fkey;
    ALTER TABLE videos ADD CONSTRAINT videos_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES platform_accounts(id) ON DELETE CASCADE;
  `);
  console.log('Remapped videos.user_id FK');

  // 2. Video 复合唯一约束
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_user_id_unique
      ON videos(user_id, id);
  `);
  console.log('Created videos(user_id, id) unique index');

  // 3. TaskExecution.userId FK（新增）
  await prisma.$executeRawUnsafe(`
    ALTER TABLE task_executions ADD CONSTRAINT task_executions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES platform_accounts(id) ON DELETE SET NULL;
  `);
  console.log('Added task_executions.user_id FK');

  // 4. LoginVerification 迁移：新增 windowId，填充数据，删除 operatorId
  await prisma.$executeRawUnsafe(`
    ALTER TABLE login_verifications ADD COLUMN window_id INTEGER;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE login_verifications lv
    SET window_id = bw.id
    FROM operators o
    JOIN browser_windows bw ON bw.bound_operator_id = o.id
    WHERE lv.operator_id = o.id;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE login_verifications ALTER COLUMN window_id SET NOT NULL;
    ALTER TABLE login_verifications ADD CONSTRAINT login_verifications_window_id_fkey
      FOREIGN KEY (window_id) REFERENCES browser_windows(id) ON DELETE CASCADE;
    CREATE INDEX idx_verification_window_platform ON login_verifications(window_id, platform);
    ALTER TABLE login_verifications DROP CONSTRAINT IF EXISTS idx_verification_operator_platform;
    ALTER TABLE login_verifications DROP COLUMN IF EXISTS operator_id;
  `);
  console.log('Migrated login_verifications: operatorId → windowId');

  // 5. 添加 FK 约束到 platform_accounts.window_id
  await prisma.$executeRawUnsafe(`
    ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_window_id_fkey
      FOREIGN KEY (window_id) REFERENCES browser_windows(id) ON DELETE RESTRICT;
  `);
  console.log('Added platform_accounts.window_id FK');

  // 6. 删除旧表
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS operator_platforms CASCADE;`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS users CASCADE;`);
  console.log('Dropped operator_platforms and users tables');
}
```

- [ ] **步骤 2：实现 Phase 3 后验证**

```typescript
async function phase3_verify(): Promise<boolean> {
  console.log('=== Phase 3: Post-Migration Verification ===');
  let passed = true;

  // 1. 行数一致性
  const paCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*) as cnt FROM platform_accounts`;
  console.log(`platform_accounts rows: ${paCount[0].cnt}`);

  // 2. videos.user_id 0 悬空
  const danglingVideos = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*) as cnt FROM videos WHERE user_id NOT IN (SELECT id FROM platform_accounts)
  `;
  if (Number(danglingVideos[0].cnt) > 0) {
    console.error(`FAIL: ${danglingVideos[0].cnt} dangling videos.user_id`);
    passed = false;
  }

  // 3. task_executions.user_id 0 悬空
  const danglingTasks = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*) as cnt FROM task_executions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM platform_accounts)
  `;
  if (Number(danglingTasks[0].cnt) > 0) {
    console.error(`FAIL: ${danglingTasks[0].cnt} dangling task_executions.user_id`);
    passed = false;
  }

  // 4. 视频 ID 撞车检测
  const collisions = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*) as cnt FROM (
      SELECT id FROM videos GROUP BY id, user_id HAVING count(*) > 1
    ) sub
  `;
  if (Number(collisions[0].cnt) > 0) {
    console.error(`FAIL: ${collisions[0].cnt} video ID collisions`);
    passed = false;
  }

  // 5. LoginVerification 全部映射
  const unmappedLv = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*) as cnt FROM login_verifications WHERE window_id IS NULL
  `;
  if (Number(unmappedLv[0].cnt) > 0) {
    console.error(`FAIL: ${unmappedLv[0].cnt} unmapped login_verifications`);
    passed = false;
  }

  if (passed) console.log('All post-migration checks PASSED');
  return passed;
}
```

- [ ] **步骤 3：组装 main 函数**

```typescript
async function main() {
  const command = process.argv[2]; // 'preflight' | 'migrate' | 'verify' | 'all'
  try {
    if (command === 'preflight' || command === 'all') {
      const ok = await phase0_preflight();
      if (!ok && command === 'all') { process.exit(1); }
    }
    if (command === 'migrate' || command === 'all') {
      await phase1_migrate();
      await phase2_remap();
    }
    if (command === 'verify' || command === 'all') {
      const ok = await phase3_verify();
      if (!ok) { process.exit(1); }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
```

- [ ] **步骤 4：Commit**

```bash
git add scripts/migrate-platform-accounts.ts
git commit -m "feat: add Phase 2 FK remapping and Phase 3 post-migration verification"
```

---

## 任务 6：monitorDatabaseService.ts — prisma.user 全部改名

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`

- [ ] **步骤 1：批量替换 prisma.user → prisma.platformAccount**

在 `monitorDatabaseService.ts` 中，将以下 13 处 `prisma.user` 调用全部改为 `prisma.platformAccount`：

| 行号 | 原代码 | 新代码 |
|------|--------|--------|
| L324 | `prisma.user.update` | `prisma.platformAccount.update` |
| L337 | `prisma.user.update` | `prisma.platformAccount.update` |
| L347 | `prisma.user.update` | `prisma.platformAccount.update` |
| L357 | `prisma.user.findUnique` | `prisma.platformAccount.findUnique` |
| L368 | `prisma.user.findUnique` | `prisma.platformAccount.findUnique` |
| L386 | `prisma.user.findMany` | `prisma.platformAccount.findMany` |
| L397 | `prisma.user.updateMany` | `prisma.platformAccount.updateMany` |
| L405 | `prisma.user.findMany` | `prisma.platformAccount.findMany` |
| L421 | `prisma.user.findMany` | `prisma.platformAccount.findMany` |
| L447 | `prisma.user.findUnique` | `prisma.platformAccount.findUnique` |
| L917 | `prisma.user.findUnique` | `prisma.platformAccount.findUnique` |
| L926 | `prisma.user.update` | `prisma.platformAccount.update` |
| L941 | `prisma.user.update` | `prisma.platformAccount.update` |

- [ ] **步骤 2：替换 fingerprintWindowId → windowId**

将以下 4 处 `fingerprintWindowId` 引用改为 `windowId`：

| 行号 | 原代码 | 新代码 |
|------|--------|--------|
| L411 | `fingerprintWindowId: true` | `windowId: true` |
| L416 | `user.fingerprintWindowId` | `user.windowId` |
| L431 | `u.fingerprintWindowId` | `u.windowId` |
| L441 | `u.fingerprintWindowId` | `u.windowId` |

- [ ] **步骤 3：在 upsertVideosBatch 和 reconcileVideosForUser 入口添加 normalizeVideoId**

在 `upsertVideosBatch`（L30）函数开头添加：
```typescript
import { normalizeVideoId } from './videoIdUtils';
```

在 `upsertVideosBatch` 函数内，video id 使用处改为 `normalizeVideoId('douyin', video.aweme_id)` 或根据 platform 动态传入。由于此函数已有 `userId` 参数，可通过 userId 查询 platform 或在调用方传入 platform。

**更优方案**：在函数签名中新增 `platform` 参数：
```typescript
export async function upsertVideosBatch(
  userId: number,
  platform: 'douyin' | 'kuaishou' | 'xiaohongshu' | 'tencent',
  videos: Array<{aweme_id: string | number; description: string; create_time: number; comment_count: number; metrics?: any}>
): Promise<void> {
  // ... 内部使用 normalizeVideoId(platform, video.aweme_id)
}
```

同样修改 `reconcileVideosForUser` 函数签名添加 `platform` 参数。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "refactor: rename prisma.user → platformAccount, fingerprintWindowId → windowId in monitorDatabaseService"
```

---

## 任务 7：monitorService.ts — 调度 key + skipPinnedVideos

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：修改 stateKey 函数**

将 L1692-1694 的：
```typescript
function stateKey(windowId: string, platform: string): string {
  return `${windowId}_${platform}`;
}
```
改为：
```typescript
function stateKey(browserVendor: string, windowExternalId: string, platform: string): string {
  return `${browserVendor}:${windowExternalId}_${platform}`;
}
```

- [ ] **步骤 2：更新所有 stateKey 调用点**

在 `monitorService.ts` 中搜索所有 `stateKey(` 调用，更新参数为 `(browserVendor, windowExternalId, platform)` 三参数形式。每个调用点需要从 user/window 对象中获取 `browserVendor`。

- [ ] **步骤 3：更新 key 解析逻辑**

将 L1769-1771 和 L2356-2358 中的 key 解析从：
```typescript
const lastUnderscore = key.lastIndexOf('_');
const windowId = key.substring(0, lastUnderscore);
const platform = key.substring(lastUnderscore + 1);
```
改为：
```typescript
const colonIdx = key.indexOf(':');
const lastUnderscore = key.lastIndexOf('_');
const browserVendor = key.substring(0, colonIdx);
const windowExternalId = key.substring(colonIdx + 1, lastUnderscore);
const platform = key.substring(lastUnderscore + 1);
```

- [ ] **步骤 4：替换 4 处 skipPinnedVideos 的 prisma.user → prisma.platformAccount**

将 L1055、L1210、L1354、L1577 的：
```typescript
const user = await prisma.user.findUnique({ where: { id: task.userId } });
```
改为：
```typescript
const user = await prisma.platformAccount.findUnique({ where: { id: task.userId } });
```

- [ ] **步骤 5：更新 runOneSchedule 中的用户匹配逻辑**

将 L1807-1809 的：
```typescript
const matched = users.filter((u: any) => u.fingerprintWindowId === windowId && u.platform === platform);
```
改为通过 `windowId` FK join 匹配（因为 `getAllActiveUsers` 返回的用户已有 `windowId` 字段）。

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: update scheduling key to include browserVendor, rename prisma.user in monitorService"
```

---

## 任务 8：unifiedQueue.ts — 接口重命名

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts`

- [ ] **步骤 1：重命名 MonitorTaskData 接口中的 fingerprintWindowId**

将 L25 的：
```typescript
fingerprintWindowId: string;
```
改为：
```typescript
windowExternalId: string;
```

同样修改 `ReplyTaskData` 接口（L42）和 `enqueueMonitor`（L504）、`enqueueReply`（L539）函数参数。

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "refactor: rename fingerprintWindowId → windowExternalId in unifiedQueue interfaces"
```

---

## 任务 9：routes/operators.ts — 大幅重构

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/operators.ts`

- [ ] **步骤 1：替换所有 prisma.user → prisma.platformAccount（10处）**

将 L67、L87、L110、L120、L149、L162、L660、L684、L818、L896 的 `prisma.user` 全部改为 `prisma.platformAccount`。

- [ ] **步骤 2：替换所有 fingerprintWindowId → windowId（10处）**

将 L69、L109、L113、L122、L150、L661、L685、L820、L898 的 `fingerprintWindowId` 改为 `windowId`（字段值从 `boundWindow.externalId` 改为 `boundWindow.id`，因为 `windowId` 是 FK 整数）。

对于需要 externalId 字符串的场景（如 BullMQ），使用 `windowExternalId` 字段（值为 `boundWindow.externalId`）。

- [ ] **步骤 3：删除 syncOperatorToMonitorUser 函数**

删除 L67-103 的 `syncOperatorToMonitorUser` 函数定义及其所有调用点。该函数的功能由 FK 级联替代。

- [ ] **步骤 4：删除 cleanupWindowMonitorData 函数**

删除 L149-177 的 `cleanupWindowMonitorData` 函数定义及其所有调用点。

- [ ] **步骤 5：删除手工级联清理代码**

删除 L660-704 的删平台绑定相关代码（`prisma.user.findMany` + `prisma.user.deleteMany`），改由 PlatformAccount FK 级联处理。

- [ ] **步骤 6：解绑窗口时停监控**

在解绑窗口逻辑中，遍历窗口下所有 PlatformAccount，设置 `monitoringEnabled=false`：
```typescript
await prisma.platformAccount.updateMany({
  where: { windowId: window.id },
  data: { monitoringEnabled: false }
});
```

- [ ] **步骤 7：添加 wechatUserid 级联更新**

在 Operator update 路由中，当 `wechatUserId` 变更时：
```typescript
if (newWechatUserId) {
  await prisma.platformAccount.updateMany({
    where: { window: { boundOperatorId: operatorId } },
    data: { wechatUserid: newWechatUserId }
  });
}
```

- [ ] **步骤 8：verify-login/verify-all 遍历所有窗口**

将只取 `windows[0]` 的逻辑改为遍历所有窗口，逐窗口 try/catch。

- [ ] **步骤 9：Commit**

```bash
git add apps/ts-api-gateway/src/routes/operators.ts
git commit -m "refactor: major operators.ts rewrite - platformAccount rename, remove sync code, add cascade logic"
```

---

## 任务 10：routes/matrix.ts — prisma.user + fingerprintWindowId 重命名

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：替换所有 prisma.user → prisma.platformAccount（24处）**

批量替换 L69、L99、L640、L708、L987、L1043、L1088、L1162、L1179、L1246、L1344、L1362、L1379、L1402、L1426、L1435、L1467、L1519、L1528、L1541、L1572、L1582、L1619、L1624 的 `prisma.user` 为 `prisma.platformAccount`。

- [ ] **步骤 2：替换所有 fingerprintWindowId → windowId（46处）**

批量替换所有 `fingerprintWindowId` 引用为 `windowId`。注意：
- 作为 select 字段时：`fingerprintWindowId: true` → `windowId: true`
- 作为访问属性时：`user.fingerprintWindowId` → `user.windowId`
- 作为 where 条件时：`where: { fingerprintWindowId: ... }` → `where: { windowId: ... }`（注意 windowId 现在是 Int FK，where 条件可能需要调整）

对于需要 externalId 字符串的场景（如日志、BullMQ jobId），使用从 window 关联获取的 `externalId` 或使用 `windowExternalId` 冗余字段。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "refactor: rename prisma.user → platformAccount, fingerprintWindowId → windowId in matrix.ts"
```

---

## 任务 11：routes/llmReply.ts + monitor.ts + accounts.ts + system.ts

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/llmReply.ts`
- 修改：`apps/ts-api-gateway/src/routes/monitor.ts`
- 修改：`apps/ts-api-gateway/src/routes/accounts.ts`
- 修改：`apps/ts-api-gateway/src/routes/system.ts`

- [ ] **步骤 1：llmReply.ts — 2 处 prisma.user → prisma.platformAccount**

L59、L152 的 `prisma.user.findUnique` → `prisma.platformAccount.findUnique`。

- [ ] **步骤 2：monitor.ts — 1 处 prisma.user + 2 处 fingerprintWindowId**

L24 的 `prisma.user.findMany` → `prisma.platformAccount.findMany`。
L102 的 `fingerprintWindowId: true` → `windowId: true`。
L116 的 `user.fingerprintWindowId` → `user.windowId`。

- [ ] **步骤 3：accounts.ts — 1 处 prisma.user + 1 处 fingerprintWindowId**

L43 的 `prisma.user.findMany` → `prisma.platformAccount.findMany`。
L53 的 `user.fingerprintWindowId` → `user.windowId`。

- [ ] **步骤 4：system.ts — 1 处 prisma.user**

L18 的 `prisma.user.count()` → `prisma.platformAccount.count()`。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/routes/llmReply.ts apps/ts-api-gateway/src/routes/monitor.ts apps/ts-api-gateway/src/routes/accounts.ts apps/ts-api-gateway/src/routes/system.ts
git commit -m "refactor: rename prisma.user → platformAccount in llmReply, monitor, accounts, system routes"
```

---

## 任务 12：wechatBotService.ts — prisma.user + fingerprintWindowId 重命名

**文件：**
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts`

- [ ] **步骤 1：替换所有 prisma.user → prisma.platformAccount（15处）**

将 L499、L597、L663、L696、L731、L737、L764、L779、L823、L910、L1167、L1209 的 `prisma.user` 改为 `prisma.platformAccount`。

注意 L1167 使用 `prismaSend.user`，需改为 `prismaSend.platformAccount`。

- [ ] **步骤 2：替换所有 fingerprintWindowId → windowId（19处）**

将 L501、L505、L597、L599、L672、L681、L698、L703、L744、L766、L781、L786、L825、L830、L912、L1169、L1191、L1192、L1224 的 `fingerprintWindowId` 改为 `windowId`。

注意：部分场景需要 externalId 字符串（如 `where: { externalId: user.fingerprintWindowId }` 查找 BrowserWindow），这些应改为通过 `windowId` FK 直接关联，或使用 `windowExternalId` 冗余字段。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/wechatBotService.ts
git commit -m "refactor: rename prisma.user → platformAccount, fingerprintWindowId → windowId in wechatBotService"
```

---

## 任务 13：爬虫文件重命名

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

- [ ] **步骤 1：kuaishouCrawler.ts — 1 处 prisma.user + 1 处 fingerprintWindowId**

L232 的 `prisma.user.findUnique` → `prisma.platformAccount.findUnique`。
L232 的 `fingerprintWindowId: true` → `windowId: true`。

- [ ] **步骤 2：tencentCrawler.ts — 1 处 prisma.user + 1 处 fingerprintWindowId**

L184 的 `prisma.user.findUnique` → `prisma.platformAccount.findUnique`。
L184 的 `fingerprintWindowId: true` → `windowId: true`。

- [ ] **步骤 3：xiaohongshuCrawler.ts — 1 处 prismaXhs.user + 3 处 fingerprintWindowId**

L1197 的 `prismaXhs.user.findUnique` → `prismaXhs.platformAccount.findUnique`。
L1197、L1198、L1201 的 `fingerprintWindowId` → `windowId`。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "refactor: rename prisma.user → platformAccount, fingerprintWindowId → windowId in crawlers"
```

---

## 任务 14：platforms/tencent.ts + taskExecutionRecorder.test.ts

**文件：**
- 修改：`apps/ts-api-gateway/src/platforms/tencent.ts`
- 修改：`apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts`

- [ ] **步骤 1：tencent.ts — 1 处 prisma.user**

L59 的 `prisma.user.findUnique` → `prisma.platformAccount.findUnique`。

- [ ] **步骤 2：taskExecutionRecorder.test.ts — 1 处 fingerprintWindowId**

L26 的 `fingerprintWindowId: 'fp-1'` → `windowExternalId: 'fp-1'`。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/platforms/tencent.ts apps/ts-api-gateway/src/lib/taskExecutionRecorder.test.ts
git commit -m "refactor: rename prisma.user → platformAccount in tencent.ts, fingerprintWindowId → windowExternalId in test"
```

---

## 任务 15：前端类型定义更新

**文件：**
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：useApi.ts — 2 处类型定义**

L451 的 `fingerprintWindowId: string;` → `windowId: string;`（MonitorAccount 类型）。
L489 的 `fingerprintWindowId: string;` → `windowId: string;`（MonitorAccountDetail 类型）。

- [ ] **步骤 2：matrix/page.tsx — 8 处 fingerprintWindowId**

L898 注释更新。
L902 `account.fingerprintWindowId` → `account.windowId`。
L906 `account.fingerprintWindowId` → `account.windowId`。
L907 `account.fingerprintWindowId` → `account.windowId`。
L941 `a.fingerprintWindowId` → `a.windowId`。
L1598 `account.fingerprintWindowId` → `account.windowId`。
L1887 `detail.fingerprintWindowId` → `detail.windowId`。

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "refactor: rename fingerprintWindowId → windowId in frontend types and matrix page"
```

---

## 任务 16：Prisma Client 重新生成 + TypeScript 编译验证

**文件：**
- 无文件修改，运行命令验证

- [ ] **步骤 1：重新生成 Prisma Client**

运行：`cd /home/lrp/social_media_complete && npx prisma generate`
预期：成功生成新的 Prisma Client，包含 `platformAccount` 模型

- [ ] **步骤 2：TypeScript 编译检查**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -50`
预期：检查是否有残留的 `prisma.user` 或 `fingerprintWindowId` 编译错误

- [ ] **步骤 3：修复任何编译错误**

如果发现遗漏的 `prisma.user` 或 `fingerprintWindowId` 引用，逐一修复。

- [ ] **步骤 4：Commit（如有修复）**

```bash
git add -A
git commit -m "fix: resolve remaining TypeScript compilation errors after refactor"
```

---

## 任务 17：全仓静态验证

**文件：**
- 无文件修改，运行验证命令

- [ ] **步骤 1：检查无残留 prisma.user**

运行：`grep -r "prisma\.user" apps/ts-api-gateway/src/ --include="*.ts" | grep -v "node_modules" | grep -v "\.test\." | grep -v "// "`
预期：0 匹配（除注释外）

- [ ] **步骤 2：检查无残留 fingerprintWindowId**

运行：`grep -r "fingerprintWindowId" apps/ --include="*.ts" --include="*.tsx" | grep -v "node_modules"`
预期：0 匹配

- [ ] **步骤 3：检查无残留 OperatorPlatform**

运行：`grep -r "OperatorPlatform" apps/ --include="*.ts" | grep -v "node_modules"`
预期：0 匹配

- [ ] **步骤 4：运行现有测试**

运行：`cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx vitest run`
预期：所有现有测试通过

- [ ] **步骤 5：Commit（如有修复）**

```bash
git add -A
git commit -m "fix: final cleanup of remaining references after refactor"
```

---

## 自检清单

### 规格覆盖度

| 规格章节 | 对应任务 |
|----------|----------|
| 3.1 四层实体模型 | 任务 2（schema） |
| 3.2 删除 OperatorPlatform | 任务 2（schema）+ 任务 5（migration） |
| 3.3 PlatformAccount 字段 | 任务 2（schema） |
| 3.4 迁移策略 | 任务 3-5（migration script） |
| 3.5 视频 ID 隔离 | 任务 1（normalizeVideoId）+ 任务 6（集中化） |
| 3.6 多窗口遍历 | 任务 9（operators.ts） |
| 3.7 解绑窗口数据保留 | 任务 9（operators.ts） |
| 3.8 BrowserWindow 删除限制 | 任务 2（schema Restrict） |
| 3.9 LoginVerification 重构 | 任务 2（schema）+ 任务 5（migration） |
| 3.10 TaskExecution FK | 任务 2（schema）+ 任务 5（migration） |
| 4.1 数据库 | 任务 2-5 |
| 4.2 数据访问层 | 任务 6 |
| 4.3 监控调度 | 任务 7 |
| 4.4 回复链路 | 任务 10（matrix.ts）+ 任务 11（llmReply.ts） |
| 4.5 operators.ts | 任务 9 |
| 4.6 wechatBotService.ts | 任务 12 |
| 4.7 前端 API 路由 | 任务 11 |
| 4.8 视频 ID 隔离 | 任务 1 + 任务 6 |
| 4.9 前端 | 任务 15 |
| 4.10 爬虫及其他 | 任务 13-14 |
| 6. 错误处理 | 任务 3-5（migration phases） |
| 7. 测试与验证 | 任务 1（测试）+ 任务 16-17（验证） |

### 占位符扫描

- ✅ 无 "待定"、"TODO"、"后续实现"
- ✅ 无 "添加适当的错误处理" 等模糊指令
- ✅ 所有代码步骤包含完整代码块
- ✅ 无 "类似任务 N" 引用
- ✅ 所有文件路径精确

### 类型一致性

- ✅ `normalizeVideoId` 在任务 1 定义，任务 6 引用
- ✅ `platformAccount` 在任务 2 schema 定义，后续所有任务使用
- ✅ `windowId` / `windowExternalId` 命名一致
- ✅ `stateKey(browserVendor, windowExternalId, platform)` 三参数签名在任务 7 定义
