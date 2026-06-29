/**
 * PR2 迁移验证脚本。
 * 检查 HotVideoCandidate 表的新列已创建。
 *
 * 用法: ts-node --compiler-options '{"module":"commonjs"}' scripts/verify-pr2-migration.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== PR2 迁移验证 ===\n');

  // 1. 检查新列是否存在（通过 raw query 检查 information_schema）
  const columns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string }>>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'hot_video_candidates'
      AND column_name IN ('like_count', 'comment_count', 'rating', 'storage_path', 'storage_status', 'accepted_at', 'fail_reason')
    ORDER BY column_name
  `;

  console.log(`新列数: ${columns.length}/7\n`);
  for (const col of columns) {
    console.log(`  ✅ ${col.column_name} (${col.data_type}, nullable=${col.is_nullable})`);
  }

  const expected = new Set(['like_count', 'comment_count', 'rating', 'storage_path', 'storage_status', 'accepted_at', 'fail_reason']);
  const actual = new Set(columns.map((c) => c.column_name));

  const missing = [...expected].filter((c) => !actual.has(c));
  if (missing.length > 0) {
    console.log(`\n❌ 缺失列: ${missing.join(', ')}`);
    process.exit(1);
  }

  // 2. 检查 storageStatus 默认值
  const defaultVal = await prisma.$queryRaw<Array<{ column_name: string; column_default: string | null }>>`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_name = 'hot_video_candidates'
      AND column_name = 'storage_status'
  `;
  if (defaultVal.length > 0) {
    console.log(`\n  storage_status 默认值: ${defaultVal[0].column_default}`);
  }

  console.log('\n✅ PR2 迁移验证通过');
}

main()
  .catch((e) => {
    console.error('验证失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
