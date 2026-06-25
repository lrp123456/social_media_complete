import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BATCH_SIZE = 1000;

// ============================================================
// Phase 0: Preflight Checks (read-only)
// ============================================================
async function phase0_preflight(): Promise<boolean> {
  console.log('=== Phase 0: Preflight Checks ===');
  let passed = true;

  // 1. Check duplicate wechatUserId
  const duplicateWechat = await prisma.$queryRaw<{wechat_user_id: string, cnt: bigint}[]>`
    SELECT wechat_user_id, count(*)::int as cnt FROM operators
    GROUP BY wechat_user_id HAVING count(*) > 1
  `;
  if (duplicateWechat.length > 0) {
    console.error('FAIL: Duplicate wechatUserId in operators:', duplicateWechat);
    passed = false;
  } else {
    console.log('OK: No duplicate wechatUserId');
  }

  // 2. Check OperatorPlatform conflicts (multiple operators on same window+platform)
  const opConflicts = await prisma.$queryRaw<{external_id: string, platform: string, cnt: bigint}[]>`
    SELECT bw.external_id, op.platform, count(*)::int as cnt
    FROM operator_platforms op
    JOIN operators o ON o.id = op.operator_id
    JOIN browser_windows bw ON bw.bound_operator_id = o.id
    GROUP BY bw.external_id, op.platform
    HAVING count(*) > 1
  `;
  if (opConflicts.length > 0) {
    console.error('FAIL: Multiple operators share same (window, platform):', opConflicts);
    passed = false;
  } else {
    console.log('OK: No operator-platform conflicts');
  }

  // 3. Check video ID collisions
  const videoCollisions = await prisma.$queryRaw<{id: string, cnt: bigint}[]>`
    SELECT id, count(DISTINCT user_id)::int as cnt FROM videos
    GROUP BY id HAVING count(DISTINCT user_id) > 1
  `;
  if (videoCollisions.length > 0) {
    console.error('FAIL: Video ID collisions:', videoCollisions);
    passed = false;
  } else {
    console.log('OK: No video ID collisions');
  }

  // 4. Check orphan users (fingerprint_window_id not in browser_windows)
  const orphanUsers = await prisma.$queryRaw<{id: number, fingerprint_window_id: string}[]>`
    SELECT u.id, u.fingerprint_window_id FROM users u
    LEFT JOIN browser_windows bw ON bw.external_id = u.fingerprint_window_id
    WHERE bw.id IS NULL
  `;
  if (orphanUsers.length > 0) {
    console.warn('WARNING: Orphan users (no matching browser_window):', orphanUsers.length);
    orphanUsers.forEach(u => console.warn(`  - user ${u.id}: window ${u.fingerprint_window_id}`));
  } else {
    console.log('OK: No orphan users');
  }

  // 5. Check dangling task_executions.user_id
  const danglingTasks = await prisma.$queryRaw<{user_id: number}[]>`
    SELECT user_id FROM task_executions
    WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)
  `;
  if (danglingTasks.length > 0) {
    console.warn('WARNING: Dangling task_executions.user_id:', danglingTasks.length);
  } else {
    console.log('OK: No dangling task_executions');
  }

  // 6. Record baseline stats
  const userCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*)::int as cnt FROM users`;
  const authorCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*)::int as cnt FROM users WHERE platform_author_id IS NOT NULL`;
  console.log(`Baseline: ${userCount[0].cnt} users, ${authorCount[0].cnt} with platformAuthorId`);

  return passed;
}

// ============================================================
// Phase 1: Create table + Migrate data (batched)
// ============================================================
async function phase1_migrate(): Promise<void> {
  console.log('=== Phase 1: Create table + Migrate data ===');

  // 1. Create platform_accounts table
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

  // 2. Batch migrate users data
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
    console.log(`  Migrated batch: ${batch.length} rows (total: ${totalMigrated}, lastId: ${lastId})`);
  }
  console.log(`Total migrated: ${totalMigrated} rows`);

  // 3. Migrate OperatorPlatform loginStatus/lastVerifiedAt
  const loginMigrated = await prisma.$executeRawUnsafe(`
    UPDATE platform_accounts pa
    SET login_status = op.login_status,
        last_verified_at = op.last_verified_at
    FROM operator_platforms op
    JOIN operators o ON o.id = op.operator_id
    JOIN browser_windows bw ON bw.bound_operator_id = o.id
    WHERE pa.window_id = bw.id AND pa.platform = op.platform
  `);
  console.log(`Migrated loginStatus for ${loginMigrated} rows`);

  // 4. Set sequence
  await prisma.$executeRawUnsafe(`
    SELECT setval('platform_accounts_id_seq', (SELECT COALESCE(max(id), 1) FROM platform_accounts));
  `);
  console.log('Set platform_accounts_id_seq');
}

// ============================================================
// Phase 2: FK Remapping (DDL statements)
// ============================================================
async function phase2_remap(): Promise<void> {
  console.log('=== Phase 2: FK Remapping ===');

  // 1. Video.userId FK remapping
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'videos_user_id_fkey') THEN
        ALTER TABLE videos DROP CONSTRAINT videos_user_id_fkey;
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE videos ADD CONSTRAINT videos_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES platform_accounts(id) ON DELETE CASCADE;
  `);
  console.log('Remapped videos.user_id FK');

  // 2. Video composite unique index
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_user_id_unique
      ON videos(user_id, id);
  `);
  console.log('Created videos(user_id, id) unique index');

  // 3. TaskExecution.userId FK (new)
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_executions_user_id_fkey') THEN
        ALTER TABLE task_executions ADD CONSTRAINT task_executions_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES platform_accounts(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  console.log('Added task_executions.user_id FK');

  // 4. LoginVerification: operatorId → windowId
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'login_verifications' AND column_name = 'operator_id') THEN
        ALTER TABLE login_verifications ADD COLUMN window_id INTEGER;
        
        UPDATE login_verifications lv
        SET window_id = bw.id
        FROM operators o
        JOIN browser_windows bw ON bw.bound_operator_id = o.id
        WHERE lv.operator_id = o.id;
        
        ALTER TABLE login_verifications ALTER COLUMN window_id SET NOT NULL;
        ALTER TABLE login_verifications ADD CONSTRAINT login_verifications_window_id_fkey
          FOREIGN KEY (window_id) REFERENCES browser_windows(id) ON DELETE CASCADE;
        
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_verification_operator_platform') THEN
          DROP INDEX idx_verification_operator_platform;
        END IF;
        CREATE INDEX IF NOT EXISTS idx_verification_window_platform ON login_verifications(window_id, platform);
        
        ALTER TABLE login_verifications DROP COLUMN operator_id;
      END IF;
    END $$;
  `);
  console.log('Migrated login_verifications: operatorId → windowId');

  // 5. platform_accounts.window_id FK
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_accounts_window_id_fkey') THEN
        ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_window_id_fkey
          FOREIGN KEY (window_id) REFERENCES browser_windows(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  console.log('Added platform_accounts.window_id FK');

  // 6. Drop old tables
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS operator_platforms CASCADE;`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS users CASCADE;`);
  console.log('Dropped operator_platforms and users tables');
}

// ============================================================
// Phase 3: Post-Migration Verification (read-only)
// ============================================================
async function phase3_verify(): Promise<boolean> {
  console.log('=== Phase 3: Post-Migration Verification ===');
  let passed = true;

  // 1. Row count
  const paCount = await prisma.$queryRaw<{cnt: bigint}[]>`SELECT count(*)::int as cnt FROM platform_accounts`;
  console.log(`platform_accounts rows: ${paCount[0].cnt}`);

  // 2. videos.user_id 0 dangling
  const danglingVideos = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*)::int as cnt FROM videos WHERE user_id NOT IN (SELECT id FROM platform_accounts)
  `;
  if (Number(danglingVideos[0].cnt) > 0) {
    console.error(`FAIL: ${danglingVideos[0].cnt} dangling videos.user_id`);
    passed = false;
  } else {
    console.log('OK: videos.user_id - 0 dangling');
  }

  // 3. task_executions.user_id 0 dangling
  const danglingTasks = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*)::int as cnt FROM task_executions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM platform_accounts)
  `;
  if (Number(danglingTasks[0].cnt) > 0) {
    console.error(`FAIL: ${danglingTasks[0].cnt} dangling task_executions.user_id`);
    passed = false;
  } else {
    console.log('OK: task_executions.user_id - 0 dangling');
  }

  // 4. LoginVerification all mapped
  const unmappedLv = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*)::int as cnt FROM login_verifications WHERE window_id IS NULL
  `;
  if (Number(unmappedLv[0].cnt) > 0) {
    console.error(`FAIL: ${unmappedLv[0].cnt} unmapped login_verifications`);
    passed = false;
  } else {
    console.log('OK: login_verifications - all mapped');
  }

  // 5. platformAuthorId non-null rate
  const authorCount = await prisma.$queryRaw<{cnt: bigint}[]>`
    SELECT count(*)::int as cnt FROM platform_accounts WHERE platform_author_id IS NOT NULL
  `;
  console.log(`platformAuthorId non-null: ${authorCount[0].cnt} / ${paCount[0].cnt}`);

  if (passed) console.log('All post-migration checks PASSED');
  return passed;
}

// ============================================================
// Main
// ============================================================
async function main() {
  const command = process.argv[2] || 'all';
  try {
    if (command === 'preflight' || command === 'all') {
      const ok = await phase0_preflight();
      if (!ok && command === 'all') {
        console.error('Preflight FAILED. Fix issues before proceeding.');
        process.exit(1);
      }
    }
    if (command === 'migrate' || command === 'all') {
      await phase1_migrate();
      await phase2_remap();
    }
    if (command === 'verify' || command === 'all') {
      const ok = await phase3_verify();
      if (!ok) {
        console.error('Verification FAILED.');
        process.exit(1);
      }
    }
    console.log('\nDone.');
  } finally {
    await prisma.$disconnect();
  }
}

main();
