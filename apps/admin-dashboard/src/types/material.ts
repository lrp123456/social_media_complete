export interface PlatformRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: string | null;
  maxPages: number;
  timeoutMs: number;
}

export interface KeyPool {
  placeholder: string;
  keys: string[];
  cooldownMs: number;
}

export type TargetField =
  | 'videoId'
  | 'title'
  | 'likeCount'
  | 'commentCount'
  | 'videoUrl'
  | 'cover'
  | 'author'
  | 'publishTime';

export type FieldMap = Record<TargetField, string>;

export interface ParseConfig {
  listPath: string;
  /** 旧版自由键值映射（PR1 迁移兼容） */
  fields?: Record<string, string>;
  /** 标准 8 字段映射表 */
  fieldMap: FieldMap;
}

export interface Platform {
  id: string;
  name: string;
  enabled: boolean;
  request: PlatformRequest;
  keyPool: KeyPool;
  parse: ParseConfig;
}

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
  /** 按平台覆盖查询关键词，key=平台ID，value=关键词列表 */
  platformOverrides?: Record<string, string[]>;
}

export interface Processing {
  frameIntervalMs: number;
  evaluatePrompt: string;
  styles: StyleDef[];
  minRating: number;
}

export interface Schedule {
  cron: string[];
  enabled: boolean;
}

export interface StorageConfig {
  enabled: boolean;
  rootPath: string;
}

export interface MaterialUpdateConfig {
  platforms: Platform[];
  schedule: Schedule;
  processing: Processing;
  storage: StorageConfig;
  keyCooldownState: Record<string, Record<string, number>>;
  allCooldownRetryAfterMs: number;
}

// ============================================================
// PR4: 素材候选（与后端 /material-update/candidates 对齐）
// ============================================================

export type MaterialCandidateStatus =
  | 'pending'
  | 'processing'
  | 'no_url'
  | 'accepted'
  | 'rejected';

export interface MaterialCandidate {
  id: string;
  platform: string;
  videoId: string;
  title: string | null;
  author: string | null;
  playCount: number | null;
  cover: string | null;
  videoUrl: string | null;
  publishTime: string | null; // ISO date
  fetchedAt: string; // ISO date
  createdAt: string; // ISO date
  status: MaterialCandidateStatus;
  style: string | null;
  likeCount: number | null;
  commentCount: number | null;
  rating: number | null; // 1-5
  storagePath: string | null;
  storageStatus: 'none' | 'pending_downloaded' | 'archived' | 'failed';
  acceptedAt: string | null; // ISO date
  failReason: string | null;
}

export interface MaterialCandidatesResponse {
  items: MaterialCandidate[];
  total: number;
  page: number;
  pageSize: number;
}
