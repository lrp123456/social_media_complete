#!/usr/bin/env tsx
/**
 * migrate-parse-fields.ts — 一次性迁移脚本
 *
 * 将存量配置 `materialUpdate.platforms[].parse.fields`（自由键值映射）
 * 迁移为标准 `fieldMap`（8 固定字段）。
 *
 * 变更：
 * - 非空 `fields` → 按字段名匹配转化为 `fieldMap`
 * - 移除 `fields` 键
 * - 无 `fields` 或已迁移的平台跳过
 *
 * 用法：
 *   npx tsx scripts/migrate-parse-fields.ts
 *
 * 管理员手动运行，不自动执行。
 */
import fs from 'fs';
import path from 'path';

// ============================================================
// 已知字段名 → 标准 TargetField 映射表（与 materialFieldMigration.ts 同步）
// ============================================================
const TARGET_FIELDS = ['videoId', 'title', 'likeCount', 'commentCount', 'videoUrl', 'cover', 'author', 'publishTime'];

const DEFAULT_FIELD_MAP: Record<string, string> = {
  videoId: '',
  title: '',
  likeCount: '',
  commentCount: '',
  videoUrl: '',
  cover: '',
  author: '',
  publishTime: '',
};

const KNOWN_FIELD_ALIASES: Record<string, string> = {
  // videoId
  videoid: 'videoId',
  video_id: 'videoId',
  id: 'videoId',
  // title
  title: 'title',
  desc: 'title',
  description: 'title',
  // likeCount
  likecount: 'likeCount',
  like_count: 'likeCount',
  diggcount: 'likeCount',
  digg_count: 'likeCount',
  likes: 'likeCount',
  like: 'likeCount',
  // commentCount
  commentcount: 'commentCount',
  comment_count: 'commentCount',
  comments: 'commentCount',
  comment: 'commentCount',
  // videoUrl
  videourl: 'videoUrl',
  video_url: 'videoUrl',
  playurl: 'videoUrl',
  play_url: 'videoUrl',
  url: 'videoUrl',
  // cover
  cover: 'cover',
  coverurl: 'cover',
  cover_url: 'cover',
  thumbnail: 'cover',
  thumbnailurl: 'cover',
  thumbnail_url: 'cover',
  // author
  author: 'author',
  authorname: 'author',
  author_name: 'author',
  nickname: 'author',
  nick_name: 'author',
  // publishTime
  publishtime: 'publishTime',
  publish_time: 'publishTime',
  createtime: 'publishTime',
  create_time: 'publishTime',
  createdat: 'publishTime',
  created_at: 'publishTime',
  timestamp: 'publishTime',
  ts: 'publishTime',
};

// ============================================================
// 迁移逻辑
// ============================================================

interface MigrationResult {
  platformId: string;
  platformName: string;
  hadFields: boolean;
  fieldsCount: number;
  matchedCount: number;
  missingFields: string[];
}

/**
 * 将存量 fields 映射为标准 fieldMap。
 */
function migrateFieldsToFieldMap(fields: Record<string, string> | undefined | null): Record<string, string> {
  const result: Record<string, string> = { ...DEFAULT_FIELD_MAP };
  if (!fields) return result;

  for (const [fieldName, dotPath] of Object.entries(fields)) {
    const lowerName = fieldName.toLowerCase().trim();
    const targetField = KNOWN_FIELD_ALIASES[lowerName];
    if (targetField && dotPath) {
      result[targetField] = dotPath;
    }
  }

  return result;
}

/**
 * 返回 fieldMap 中未配置的字段。
 */
function getMissingFields(fieldMap: Record<string, string>): string[] {
  return TARGET_FIELDS.filter((f) => !fieldMap[f] || fieldMap[f].length === 0);
}

// ============================================================
// 文件操作
// ============================================================

const OVERRIDES_FILE = path.resolve(__dirname, '..', 'data', 'settings-overrides.json');

function loadSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch {
    console.error(`❌ 无法读取 ${OVERRIDES_FILE}，文件可能不存在`);
    process.exit(1);
  }
}

function saveSettings(settings: Record<string, any>): void {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  console.log(`✅ 已写回 ${OVERRIDES_FILE}`);
}

// ============================================================
// 主流程
// ============================================================

function main(): void {
  const settings = loadSettings();
  const materialUpdate = settings.materialUpdate;
  if (!materialUpdate) {
    console.log('ℹ️  配置中无 materialUpdate 段，无需迁移');
    return;
  }

  const platforms = materialUpdate.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    console.log('ℹ️  无平台配置，无需迁移');
    return;
  }

  const results: MigrationResult[] = [];
  let migratedCount = 0;

  for (const platform of platforms) {
    const parse = platform.parse;
    if (!parse) continue;

    const fields = parse.fields;
    const hasFields = fields && typeof fields === 'object' && Object.keys(fields).length > 0;

    if (!hasFields) {
      results.push({
        platformId: platform.id || '(unknown)',
        platformName: platform.name || '(unknown)',
        hadFields: false,
        fieldsCount: 0,
        matchedCount: 0,
        missingFields: [],
      });
      continue;
    }

    const fieldMap = migrateFieldsToFieldMap(fields);
    const missingFields = getMissingFields(fieldMap);
    const matchedCount = TARGET_FIELDS.filter((f) => fieldMap[f] && fieldMap[f].length > 0).length;

    // 替换 fieldMap、移除 fields
    parse.fieldMap = fieldMap;
    delete parse.fields;

    results.push({
      platformId: platform.id,
      platformName: platform.name,
      hadFields: true,
      fieldsCount: Object.keys(fields).length,
      matchedCount,
      missingFields,
    });

    migratedCount++;
  }

  // 写回文件
  saveSettings(settings);

  // 打印汇总
  console.log('\n═══════════════════════════════════════');
  console.log('  migrate-parse-fields 迁移报告');
  console.log('═══════════════════════════════════════');
  console.log();

  for (const r of results) {
    if (r.hadFields) {
      const matchRate = r.matchedCount >= 8 ? '✅ 完整' : `⚠️  部分 (${r.matchedCount}/8)`;
      console.log(`  [${r.platformName}] ${r.platformId}:`);
      console.log(`    存量字段: ${r.fieldsCount} 个 → 匹配 ${r.matchedCount}/8 个标准字段`);
      console.log(`    状态: ${matchRate}`);
      if (r.missingFields.length > 0) {
        console.log(`    缺失字段: ${r.missingFields.join(', ')}`);
      }
    } else {
      console.log(`  [${r.platformName}] ${r.platformId}: 无 fields 配置，跳过`);
    }
    console.log();
  }

  console.log(`📊 共处理 ${platforms.length} 个平台，迁移 ${migratedCount} 个`);
  console.log('\n⚠️  请检查缺失字段并手动补全 fieldMap 配置。');
  console.log('   管理员可运行 `npx tsx scripts/migrate-parse-fields.ts` 重新执行。\n');
}

main();
