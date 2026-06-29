// materialFieldMigration.ts — 存量 fields → fieldMap 迁移纯函数
import type { FieldMap, TargetField } from './materialUpdateConfig';
import { DEFAULT_FIELD_MAP, TARGET_FIELDS } from './materialUpdateConfig';

/**
 * 已知字段名 → 标准 TargetField 映射表。
 * key: 存量配置中可能出现的字段名（小写比较）
 * value: 对应的标准 TargetField
 */
const KNOWN_FIELD_ALIASES: Record<string, TargetField> = {
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

/**
 * 尝试将存量 fields 映射为标准 FieldMap。
 *
 * 匹配策略：
 * 1. 将存量字段名转小写后在 KNOWN_FIELD_ALIASES 中查找
 * 2. 若找到，将存量点路径值填入对应标准 TargetField
 * 3. 若找不到，忽略该字段（留空让用户手动补全）
 *
 * @param fields - 存量解析配置中的 fields 记录
 * @returns 标准 FieldMap（8 键恒存在，未匹配的键值为空串 ''）
 */
export function migrateFieldsToFieldMap(fields: Record<string, string> | undefined | null): FieldMap {
  const result: FieldMap = { ...DEFAULT_FIELD_MAP };

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
 * 检查 FieldMap 是否完整（所有 8 字段均已配置非空值）。
 * 用于 UI 提示用户补全缺失字段。
 */
export function isFieldMapComplete(fieldMap: FieldMap): boolean {
  return TARGET_FIELDS.every((f) => fieldMap[f] && fieldMap[f].length > 0);
}

/**
 * 返回 FieldMap 中未配置的字段列表。
 */
export function getMissingFields(fieldMap: FieldMap): TargetField[] {
  return TARGET_FIELDS.filter((f) => !fieldMap[f] || fieldMap[f].length === 0);
}
