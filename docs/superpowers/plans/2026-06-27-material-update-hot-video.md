# 素材更新 · 每周热门视频采集 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将「素材更新」从 Mock 重构为「每周热门视频采集」全链路：配置 UI → TS 网关编排（多 key 轮询 curl/RapidAPI → 解析去重 → 下发 Python Worker）→ Python Worker（HTTP 下载 → 按间隔抽帧 → LLM 评估 → 风格命中落盘 → webhook 回调）。

**架构：** TS 网关新增 `materialUpdateService` 编排服务 + cron 调度器，通过 `settingsStore` 持久化配置到 `data/settings-overrides.json`。采集到的候选视频 upsert 到 PG `HotVideoCandidate` 表，新候选通过 HTTP POST 下发到 Python Worker ARQ 队列。Python Worker 改造 `material_tasks.py` 支持 HTTP 直链下载 + 按间隔抽帧 + 可配提示词 + 风格命中落盘 + webhook 回调。前端新增「素材更新」Tab，5 个面板管理平台采集源 / 调度 / 处理评估 / 运行状态 / 候选预览。

**技术栈：** TypeScript (Express 4 + Prisma 6 + Zod 3 + Jest 29) · Python (FastAPI + ARQ + httpx + FFmpeg) · React 18 (Next.js 14 + Tailwind + React Query 5)

---

## 文件结构

### TS 网关 — 新增文件

| 文件 | 职责 |
|---|---|
| `apps/ts-api-gateway/src/services/materialUpdateConfig.ts` | 类型定义（`Platform`/`KeyPool`/`Parse`/`Processing`/`Schedule`/`MaterialUpdateConfig`）+ 默认值 + `getMaterialUpdateConfig()`/`saveMaterialUpdateConfig()` 封装 |
| `apps/ts-api-gateway/src/services/materialParser.ts` | 列表路径 + 字段映射解析（点路径取值），输出标准化 `Video` 对象 |
| `apps/ts-api-gateway/src/services/materialKeyPool.ts` | 多 key 轮询 + 失败冷却切换（401/429/响应体错误检测） |
| `apps/ts-api-gateway/src/services/materialUpdateService.ts` | 核心编排：读配置 → 并发 curl → 解析 → 去重 upsert → 下发 Python Worker |
| `apps/ts-api-gateway/src/services/materialUpdateScheduler.ts` | cron 调度器：`reload()` / `start()` / `stop()`，基于 `cron-parser` + `setTimeout` |
| `apps/ts-api-gateway/src/routes/config-material.ts` | `GET/PUT /api/v1/config-material` + `POST /api/v1/config-material/test` |
| `apps/ts-api-gateway/src/routes/material-update.ts` | `POST .../run` + `GET .../status` + `GET .../candidates` + `POST .../webhook` |
| `apps/ts-api-gateway/src/services/__tests__/materialParser.test.ts` | materialParser 单元测试 |
| `apps/ts-api-gateway/src/services/__tests__/materialKeyPool.test.ts` | materialKeyPool 单元测试 |

### TS 网关 — 修改文件

| 文件 | 修改内容 |
|---|---|
| `prisma/schema.prisma` | 新增 `HotVideoCandidate` model |
| `apps/ts-api-gateway/src/index.ts` | 注册 2 个新路由 + 启动调度器 |
| `apps/ts-api-gateway/package.json` | 新增 `cron-parser` 依赖 |

### Python Worker — 修改文件

| 文件 | 修改内容 |
|---|---|
| `apps/python-worker/app/services/ffmpeg.py` | 新增 `download_from_url()` HTTP 直链下载函数 |
| `apps/python-worker/app/models/__init__.py` | 新增 `MaterialUpdateRequest` 模型（从 tasks.py 提取并扩展） |
| `apps/python-worker/app/routers/tasks.py` | 改为从 models 导入 `MaterialUpdateRequest` |
| `apps/python-worker/app/workers/material_tasks.py` | 修复 ctx 签名 + 入参扩展 + 按间隔抽帧 + 可配 prompt + 图片发送 + 风格命中 + webhook 回调 |
| `apps/python-worker/app/config.py` | 新增 `ts_material_webhook_url` 配置项 |

### 前端 — 新增文件

| 文件 | 职责 |
|---|---|
| `apps/admin-dashboard/src/app/settings/tabs/MaterialTab.tsx` | 素材更新 Tab 顶层组合，管理 5 个面板 |
| `apps/admin-dashboard/src/app/settings/components/PlatformCard.tsx` | 单平台配置卡片（色带 + 请求/Key池/解析分区 + 测试按钮） |
| `apps/admin-dashboard/src/app/settings/components/KeyPoolEditor.tsx` | Key chip 流编辑器（掩码 + 冷却角标） |
| `apps/admin-dashboard/src/app/settings/components/CronListEditor.tsx` | 多 cron 表达式增删 + 下次执行预览 |
| `apps/admin-dashboard/src/app/settings/components/StyleListEditor.tsx` | 风格条目增删（name/dir/keywords） |

### 前端 — 修改文件

| 文件 | 修改内容 |
|---|---|
| `apps/admin-dashboard/src/hooks/useApi.ts` | 新增 `useMaterialConfig`/`useUpdateMaterialConfig`/`useTestPlatform`/`useTriggerRun`/`useMaterialStatus`/`useMaterialCandidates` hooks |
| `apps/admin-dashboard/src/app/settings/page.tsx` | `TabKey` 增加 `'material'` + Tab 按钮 + 内容 div |

---

## 任务依赖图

```
任务1 (Prisma) ──────────────────────────────────────┐
任务2 (Config类型) ──┬── 任务3 (Parser, TDD) ───────┐ │
                     ├── 任务4 (KeyPool, TDD) ──────┤ │
                     │                               ├── 任务5 (Service) ── 任务6 (Scheduler)
                     │                               │           │
                     ├── 任务7 (config-material路由) ◄───────────┤
                     │                               ├── 任务8 (material-update路由)
                     │                               │       │
                     │                               │   任务9 (index.ts注册)
                     │                               │
任务10 (Python download_from_url) ─── 任务11 (Python模型) ─── 任务12 (Python重构)
                     │
任务13 (前端API hooks) ── 任务14 (前端共享组件) ── 任务15 (前端MaterialTab) ── 任务16 (前端page.tsx)
```

**可并行：** 任务 1-4（基础层）可并行；任务 10-11（Python 基础）可与 TS 任务并行；任务 13-14 可并行。

---

### 任务 1：Prisma Schema — HotVideoCandidate 模型

**文件：**
- 修改：`prisma/schema.prisma`（文件末尾追加）
- 生成迁移：`prisma/migrations/20260627000001_add_hot_video_candidate/`

- [ ] **步骤 1：在 schema.prisma 末尾新增 model**

在 `prisma/schema.prisma` 文件末尾追加：

```prisma
// ============================================================
// 素材更新 — 每周热门视频采集
// ============================================================

model HotVideoCandidate {
  id           String   @id @default(cuid())
  platformId   String   @map("platform_id") @db.VarChar(64)
  videoId      String   @map("video_id") @db.VarChar(256)
  title        String?  @db.VarChar(512)
  author       String?  @db.VarChar(256)
  playCount    Int?     @map("play_count")
  cover        String?  @db.VarChar(1024)
  videoUrl     String?  @map("video_url") @db.VarChar(1024)
  publishTime  DateTime? @map("publish_time")
  rawJson      Json?    @map("raw_json")
  fetchedAt    DateTime @default(now()) @map("fetched_at")
  status       String   @default("pending") @db.VarChar(32) // pending|processing|no_url|accepted|rejected
  style        String?  @db.VarChar(64)

  @@unique([platformId, videoId], name: "uq_hot_video_platform_video")
  @@index([fetchedAt], name: "idx_hot_video_fetched_at")
  @@index([status], name: "idx_hot_video_status")
  @@map("hot_video_candidates")
}
```

- [ ] **步骤 2：生成 Prisma 客户端**

运行：
```bash
cd /home/lrp/social_media_complete && pnpm prisma:generate
```
预期：输出 `✔ Generated Prisma Client` 无错误。

- [ ] **步骤 3：创建数据库迁移**

运行：
```bash
cd /home/lrp/social_media_complete && pnpm prisma:migrate -- --name add_hot_video_candidate
```
预期：创建 `prisma/migrations/20260627000001_add_hot_video_candidate/migration.sql`，包含 `CREATE TABLE "hot_video_candidates"` 语句。

- [ ] **步骤 4：验证迁移已应用**

运行：
```bash
cd /home/lrp/social_media_complete && npx prisma db pull --print | grep -i "hot_video"
```
预期：输出包含 `model HotVideoCandidate` 的 schema 片段。

- [ ] **步骤 5：Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260627000001_add_hot_video_candidate/
git commit -m "feat: add HotVideoCandidate prisma model for material update"
```

---

### 任务 2：materialUpdateConfig.ts — 类型定义与配置封装

**文件：**
- 创建：`apps/ts-api-gateway/src/services/materialUpdateConfig.ts`

- [ ] **步骤 1：创建配置类型与默认值文件**

创建 `apps/ts-api-gateway/src/services/materialUpdateConfig.ts`：

```typescript
// materialUpdateConfig.ts — 素材更新配置类型 + 默认值 + settingsStore 封装
import { getSection, saveSection } from '../lib/settingsStore';

// ============================================================
// 类型定义
// ============================================================

export interface KeyPool {
  placeholder: string;
  keys: string[];
  cooldownMs: number;
}

export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
}

export interface PlatformRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: string | null;
  maxPages: number;
  timeoutMs: number;
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

export interface KeyCooldownState {
  [platformId: string]: Record<string, number>; // key -> cooldown expiry timestamp (ms)
}

export interface MaterialUpdateConfig {
  platforms: Platform[];
  schedule: Schedule;
  processing: Processing;
  keyCooldownState: KeyCooldownState;
  allCooldownRetryAfterMs: number;
}

// ============================================================
// 默认值
// ============================================================

export const DEFAULT_PROCESSING: Processing = {
  frameIntervalMs: 1000,
  evaluatePrompt: `分析这张视频截图，返回 JSON（只返回 JSON 不要其他内容）：
{
  "style": "风格分类名称",
  "rating": "品质评级 1-5 (1最低,5最高)",
  "matched": "是否命中候选风格: true|false",
  "matchedStyle": "命中的风格目录名，未命中则为 null"
}`,
  styles: [
    { name: '口播', dir: '口播', keywords: ['口播', '讲解', '说话'] },
    { name: '场景', dir: '场景', keywords: ['户外', '街景', '风景'] },
  ],
  minRating: 4,
};

export const DEFAULT_CONFIG: MaterialUpdateConfig = {
  platforms: [],
  schedule: {
    cron: ['7 3 * * 1'],
    enabled: false,
  },
  processing: DEFAULT_PROCESSING,
  keyCooldownState: {},
  allCooldownRetryAfterMs: 1800000,
};

// ============================================================
// settingsStore 封装
// ============================================================

export function getMaterialUpdateConfig(): MaterialUpdateConfig {
  return getSection<MaterialUpdateConfig>('materialUpdate', DEFAULT_CONFIG);
}

export function saveMaterialUpdateConfig(data: Partial<MaterialUpdateConfig>): MaterialUpdateConfig {
  const current = getMaterialUpdateConfig();
  const merged = { ...current, ...data };
  saveSection('materialUpdate', merged);
  return merged;
}

export function saveKeyCooldownState(state: KeyCooldownState): void {
  const current = getMaterialUpdateConfig();
  current.keyCooldownState = state;
  saveSection('materialUpdate', current);
}
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | grep -i "materialUpdateConfig" || echo "No errors in materialUpdateConfig"
```
预期：无错误（`No errors in materialUpdateConfig`）。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/materialUpdateConfig.ts
git commit -m "feat: add materialUpdateConfig types and settingsStore wrapper"
```

---

### 任务 3：materialParser.ts — 响应解析器（TDD）

**文件：**
- 创建：`apps/ts-api-gateway/src/services/materialParser.ts`
- 测试：`apps/ts-api-gateway/src/services/__tests__/materialParser.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/ts-api-gateway/src/services/__tests__/materialParser.test.ts`：

```typescript
import { parseVideoList, getByDotPath } from '../materialParser';

describe('getByDotPath', () => {
  it('从嵌套对象按点路径取值', () => {
    const obj = { data: { videos: [{ id: 1 }] } };
    expect(getByDotPath(obj, 'data.videos')).toEqual([{ id: 1 }]);
  });

  it('路径不存在返回 undefined', () => {
    const obj = { data: {} };
    expect(getByDotPath(obj, 'data.missing')).toBeUndefined();
  });

  it('单层路径', () => {
    const obj = { name: 'hello' };
    expect(getByDotPath(obj, 'name')).toBe('hello');
  });

  it('空路径返回原对象', () => {
    const obj = { a: 1 };
    expect(getByDotPath(obj, '')).toBe(obj);
  });
});

describe('parseVideoList', () => {
  const parseConfig = {
    listPath: 'data.videos',
    fields: {
      videoId: 'video_id',
      title: 'desc',
      author: 'author.nickname',
      playCount: 'stats.play',
      cover: 'cover.url',
      videoUrl: 'video_url',
      publishTime: 'create_time',
    },
  };

  it('解析标准响应体', () => {
    const response = {
      data: {
        videos: [
          {
            video_id: 'v001',
            desc: '测试视频',
            author: { nickname: '创作者A' },
            stats: { play: 12345 },
            cover: { url: 'https://img.example.com/1.jpg' },
            video_url: 'https://video.example.com/1.mp4',
            create_time: 1719480000,
          },
        ],
      },
    };

    const result = parseVideoList(response, parseConfig);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      videoId: 'v001',
      title: '测试视频',
      author: '创作者A',
      playCount: 12345,
      cover: 'https://img.example.com/1.jpg',
      videoUrl: 'https://video.example.com/1.mp4',
      publishTime: expect.any(Number),
    });
  });

  it('字段缺失时对应字段为 undefined', () => {
    const response = { data: { videos: [{ video_id: 'v002' }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result).toHaveLength(1);
    expect(result[0].videoId).toBe('v002');
    expect(result[0].title).toBeUndefined();
    expect(result[0].videoUrl).toBeUndefined();
  });

  it('listPath 指向非数组时返回空数组', () => {
    const response = { data: { videos: 'not_an_array' } };
    const result = parseVideoList(response, parseConfig);
    expect(result).toEqual([]);
  });

  it('listPath 不存在时返回空数组', () => {
    const response = { other: {} };
    const result = parseVideoList(response, parseConfig);
    expect(result).toEqual([]);
  });

  it('publishTime Unix 时间戳转为毫秒时间戳', () => {
    const response = { data: { videos: [{ video_id: 'v003', create_time: 1719480000 }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].publishTime).toBe(1719480000 * 1000);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/services/__tests__/materialParser.test.ts --verbose 2>&1 | tail -20
```
预期：FAIL，报错 `Cannot find module '../materialParser'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `apps/ts-api-gateway/src/services/materialParser.ts`：

```typescript
// materialParser.ts — 响应体解析：列表路径 + 字段映射（点路径取值）
export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
}

export interface ParsedVideo {
  videoId: string;
  title?: string;
  author?: string;
  playCount?: number;
  cover?: string;
  videoUrl?: string;
  publishTime?: number;
  rawJson?: unknown;
}

/**
 * 按点路径从对象中取值。
 * 'data.videos' => obj.data.videos
 * 空路径返回原对象。
 */
export function getByDotPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 按 parseConfig 从 API 响应体解析出标准化视频列表。
 */
export function parseVideoList(response: unknown, config: ParseConfig): ParsedVideo[] {
  const list = getByDotPath(response, config.listPath);
  if (!Array.isArray(list)) return [];

  return list.map((item) => {
    const video: ParsedVideo = { videoId: '' };
    for (const [targetField, sourcePath] of Object.entries(config.fields)) {
      const value = getByDotPath(item, sourcePath);
      if (value === undefined || value === null) continue;

      if (targetField === 'playCount') {
        video.playCount = typeof value === 'number' ? value : parseInt(String(value), 10) || undefined;
      } else if (targetField === 'publishTime') {
        // Unix 秒时间戳 → 毫秒
        const num = typeof value === 'number' ? value : parseInt(String(value), 10);
        if (!isNaN(num)) {
          video.publishTime = num > 1e12 ? num : num * 1000;
        }
      } else {
        (video as Record<string, unknown>)[targetField] = value;
      }
    }
    video.rawJson = item;
    return video;
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/services/__tests__/materialParser.test.ts --verbose 2>&1 | tail -20
```
预期：PASS，所有测试用例通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/materialParser.ts apps/ts-api-gateway/src/services/__tests__/materialParser.test.ts
git commit -m "feat: add materialParser with dot-path field mapping + tests"
```

---

### 任务 4：materialKeyPool.ts — Key 池管理器（TDD）

**文件：**
- 创建：`apps/ts-api-gateway/src/services/materialKeyPool.ts`
- 测试：`apps/ts-api-gateway/src/services/__tests__/materialKeyPool.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/ts-api-gateway/src/services/__tests__/materialKeyPool.test.ts`：

```typescript
import { KeyPoolManager } from '../materialKeyPool';
import type { KeyPool, KeyCooldownState } from '../materialUpdateConfig';

const mockKeyPool: KeyPool = {
  placeholder: 'API_KEY',
  keys: ['key_aaa', 'key_bbb', 'key_ccc'],
  cooldownMs: 300000,
};

describe('KeyPoolManager', () => {
  it('首次选 key 返回第一个可用 key', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    const key = mgr.selectKey();
    expect(key).toBe('key_aaa');
  });

  it('冷却第一个 key 后选第二个', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    mgr.markCooldown('key_aaa');
    const key = mgr.selectKey();
    expect(key).toBe('key_bbb');
  });

  it('所有 key 都冷却后返回 null', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    mgr.markCooldown('key_aaa');
    mgr.markCooldown('key_bbb');
    mgr.markCooldown('key_ccc');
    const key = mgr.selectKey();
    expect(key).toBeNull();
  });

  it('冷却过期的 key 恢复可用', () => {
    const pastExpiry = Date.now() - 1000;
    const cooldownState: KeyCooldownState = {
      plat1: { key_aaa: pastExpiry },
    };
    const mgr = new KeyPoolManager('plat1', mockKeyPool, cooldownState);
    const key = mgr.selectKey();
    expect(key).toBe('key_aaa');
  });

  it('markCooldown 写入的过期时间为 now + cooldownMs', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    const before = Date.now();
    mgr.markCooldown('key_aaa');
    const after = Date.now();
    const state = mgr.getCooldownState();
    const expiry = state.plat1?.['key_aaa'];
    expect(expiry).toBeDefined();
    expect(expiry!).toBeGreaterThanOrEqual(before + mockKeyPool.cooldownMs);
    expect(expiry!).toBeLessThanOrEqual(after + mockKeyPool.cooldownMs);
  });

  it('检测 200 响应体中的限流错误关键词', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    expect(mgr.isBodyError({ message: 'rate limit exceeded' })).toBe(true);
    expect(mgr.isBodyError({ error: 'You exceeded your quota' })).toBe(true);
    expect(mgr.isBodyError({ message: 'not enough credits' })).toBe(true);
    expect(mgr.isBodyError({ data: { videos: [] } })).toBe(false);
    expect(mgr.isBodyError({ message: 'success' })).toBe(false);
  });

  it('无 key 的池始终返回 null', () => {
    const emptyPool: KeyPool = { ...mockKeyPool, keys: [] };
    const mgr = new KeyPoolManager('plat1', emptyPool, {});
    expect(mgr.selectKey()).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/services/__tests__/materialKeyPool.test.ts --verbose 2>&1 | tail -20
```
预期：FAIL，报错 `Cannot find module '../materialKeyPool'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `apps/ts-api-gateway/src/services/materialKeyPool.ts`：

```typescript
// materialKeyPool.ts — 多 key 轮询 + 失败冷却切换
import type { KeyPool, KeyCooldownState } from './materialUpdateConfig';

const BODY_ERROR_PATTERNS = [
  /rate\s*limit/i,
  /quota\s*exceeded/i,
  /not\s*enough\s*credits/i,
  /too\s*many\s*requests/i,
  /api\s*key\s*invalid/i,
  /unauthorized/i,
];

export class KeyPoolManager {
  private cooldownState: KeyCooldownState;
  private readonly platformId: string;
  private readonly keyPool: KeyPool;

  constructor(platformId: string, keyPool: KeyPool, existingState: KeyCooldownState) {
    this.platformId = platformId;
    this.keyPool = keyPool;
    this.cooldownState = { ...existingState };
  }

  /**
   * 选下一个可用 key（轮询）。
   * 全部冷却中返回 null。
   */
  selectKey(): string | null {
    const now = Date.now();
    const platformState = this.cooldownState[this.platformId] || {};

    for (const key of this.keyPool.keys) {
      const expiry = platformState[key];
      if (!expiry || expiry <= now) {
        return key;
      }
    }
    return null;
  }

  /**
   * 标记某个 key 冷却（now + cooldownMs）。
   */
  markCooldown(key: string): void {
    if (!this.cooldownState[this.platformId]) {
      this.cooldownState[this.platformId] = {};
    }
    this.cooldownState[this.platformId][key] = Date.now() + this.keyPool.cooldownMs;
  }

  /**
   * 获取当前冷却状态快照。
   */
  getCooldownState(): KeyCooldownState {
    return JSON.parse(JSON.stringify(this.cooldownState));
  }

  /**
   * 检测 200 响应体中的限流/额度错误。
   * RapidAPI 常返回 200 + 错误消息。
   */
  isBodyError(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const text = JSON.stringify(body);
    return BODY_ERROR_PATTERNS.some((pattern) => pattern.test(text));
  }

  /**
   * 判断 HTTP 状态码是否应触发 key 冷却。
   */
  static shouldCooldownByStatus(status: number): boolean {
    return status === 401 || status === 429 || status === 403;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/services/__tests__/materialKeyPool.test.ts --verbose 2>&1 | tail -20
```
预期：PASS，所有测试用例通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/materialKeyPool.ts apps/ts-api-gateway/src/services/__tests__/materialKeyPool.test.ts
git commit -m "feat: add KeyPoolManager with rotation, cooldown, and body error detection + tests"
```

---

### 任务 5：materialUpdateService.ts — 核心编排服务

**文件：**
- 创建：`apps/ts-api-gateway/src/services/materialUpdateService.ts`

- [ ] **步骤 1：创建编排服务**

创建 `apps/ts-api-gateway/src/services/materialUpdateService.ts`：

```typescript
// materialUpdateService.ts — 核心编排：读配置 → 并发 curl → 解析 → 去重 → 下发 Python Worker
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { getConfig } from '@social-media/shared-config';
import { logger } from '../lib/logger';
import {
  getMaterialUpdateConfig,
  saveKeyCooldownState,
  type MaterialUpdateConfig,
  type Platform,
} from './materialUpdateConfig';
import { parseVideoList, type ParsedVideo } from './materialParser';
import { KeyPoolManager } from './materialKeyPool';

// 运行态
interface RunState {
  running: boolean;
  lastRunAt: number | null;
  lastResult: Record<string, { fetched: number; newCandidates: number; errors: string[] }>;
}

const runState: RunState = {
  running: false,
  lastRunAt: null,
  lastResult: {},
};

export function isRunning(): boolean {
  return runState.running;
}

export function getRunState(): RunState {
  return { ...runState };
}

/**
 * 注入占位符到字符串（URL 编码 key 值）。
 */
function injectPlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    result = result.replace(regex, encodeURIComponent(value));
  }
  return result;
}

/**
 * 对单个平台执行采集。
 */
async function fetchPlatform(
  platform: Platform,
  config: MaterialUpdateConfig,
  cooldownState: ReturnType<KeyPoolManager['getCooldownState']>,
): Promise<{ videos: ParsedVideo[]; newCooldownState: ReturnType<KeyPoolManager['getCooldownState']> }> {
  const keyMgr = new KeyPoolManager(platform.id, platform.keyPool, cooldownState);
  const allVideos: ParsedVideo[] = [];

  const maxPages = platform.request.maxPages || 1;

  for (let page = 1; page <= maxPages; page++) {
    const key = keyMgr.selectKey();
    if (!key) {
      logger.warn(`[materialUpdate] 平台 ${platform.id} 所有 key 已冷却，跳过剩余分页`);
      break;
    }

    const vars: Record<string, string> = {
      [platform.keyPool.placeholder]: key,
      PAGE: String(page),
    };

    const url = injectPlaceholders(platform.request.url, vars);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.request.headers)) {
      headers[k] = injectPlaceholders(v, vars);
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.request.params)) {
      params[k] = injectPlaceholders(v, vars);
    }

    try {
      const response = await axios({
        method: platform.request.method,
        url,
        headers,
        params,
        data: platform.request.body ? JSON.parse(platform.request.body) : undefined,
        timeout: platform.request.timeoutMs || 30000,
        validateStatus: () => true, // 不抛异常，手动检查状态码
      });

      // HTTP 状态码检测
      if (KeyPoolManager.shouldCooldownByStatus(response.status)) {
        logger.warn(`[materialUpdate] 平台 ${platform.id} key=${key.slice(0, 8)}... HTTP ${response.status}，冷却`);
        keyMgr.markCooldown(key);
        continue; // 尝试下一个 key
      }

      // 响应体错误检测
      if (keyMgr.isBodyError(response.data)) {
        logger.warn(`[materialUpdate] 平台 ${platform.id} key=${key.slice(0, 8)}... 响应体限流错误，冷却`);
        keyMgr.markCooldown(key);
        continue;
      }

      // 解析
      const videos = parseVideoList(response.data, platform.parse);
      allVideos.push(...videos);
      logger.info(`[materialUpdate] 平台 ${platform.id} 第 ${page} 页: ${videos.length} 条`);
    } catch (err) {
      logger.error(`[materialUpdate] 平台 ${platform.id} 第 ${page} 页请求失败: ${err}`);
    }
  }

  return { videos: allVideos, newCooldownState: keyMgr.getCooldownState() };
}

/**
 * 下发候选视频到 Python Worker。
 */
async function dispatchToPython(
  candidateId: string,
  videoUrl: string,
  platformId: string,
  config: MaterialUpdateConfig,
): Promise<void> {
  const appConfig = getConfig();
  const payload = {
    task_id: candidateId,
    task_type: 'material_update',
    candidate_id: candidateId,
    video_url: videoUrl,
    platform: platformId,
    oss_urls: [],
    frame_interval_ms: config.processing.frameIntervalMs,
    evaluate_prompt: config.processing.evaluatePrompt,
    styles: config.processing.styles,
    min_rating: config.processing.minRating,
  };

  try {
    await axios.post(
      `${appConfig.PYTHON_WORKER_URL}/api/v1/tasks/material-update`,
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    logger.info(`[materialUpdate] 候选 ${candidateId} 已下发 Python Worker`);
  } catch (err) {
    logger.error(`[materialUpdate] 候选 ${candidateId} 下发失败: ${err}`);
    // 标记为 pending 以便后续重试
    await prisma.hotVideoCandidate.update({
      where: { id: candidateId },
      data: { status: 'pending' },
    });
  }
}

/**
 * 执行一次全量采集（cron 和手动触发共享此入口）。
 */
export async function runMaterialUpdate(): Promise<void> {
  if (runState.running) {
    logger.warn('[materialUpdate] 已在运行中，跳过本次触发');
    return;
  }

  runState.running = true;
  runState.lastRunAt = Date.now();
  runState.lastResult = {};

  // 每次执行时读取最新配置（不在模块顶层缓存）
  const config = getMaterialUpdateConfig();
  const enabledPlatforms = config.platforms.filter((p) => p.enabled);

  logger.info(`[materialUpdate] 开始采集，${enabledPlatforms.length} 个启用平台`);

  // 合并所有平台的冷却状态
  let mergedCooldownState = { ...config.keyCooldownState };

  // 并发采集各平台
  const platformResults = await Promise.allSettled(
    enabledPlatforms.map(async (platform) => {
      const result = await fetchPlatform(platform, config, mergedCooldownState);
      // 合并冷却状态
      mergedCooldownState = result.newCooldownState;
      return { platform, videos: result.videos };
    }),
  );

  // 持久化冷却状态
  saveKeyCooldownState(mergedCooldownState);

  // 去重 upsert + 下发新候选
  for (const settled of platformResults) {
    if (settled.status !== 'fulfilled') continue;
    const { platform, videos } = settled.value;
    const errors: string[] = [];
    let newCount = 0;

    for (const video of videos) {
      if (!video.videoId) continue;

      try {
        // upsert：已存在且 status !== 'rejected' 跳过；rejected 允许重新处理
        const existing = await prisma.hotVideoCandidate.findUnique({
          where: { platformId_videoId: { platformId: platform.id, videoId: video.videoId } },
        });

        if (existing && existing.status !== 'rejected') {
          continue; // 已存在且非 rejected，跳过
        }

        const isReprocess = existing?.status === 'rejected';

        const candidate = await prisma.hotVideoCandidate.upsert({
          where: { platformId_videoId: { platformId: platform.id, videoId: video.videoId } },
          create: {
            platformId: platform.id,
            videoId: video.videoId,
            title: video.title || null,
            author: video.author || null,
            playCount: video.playCount || null,
            cover: video.cover || null,
            videoUrl: video.videoUrl || null,
            publishTime: video.publishTime ? new Date(video.publishTime) : null,
            rawJson: video.rawJson as any,
            status: video.videoUrl ? 'pending' : 'no_url',
          },
          update: isReprocess
            ? { status: video.videoUrl ? 'pending' : 'no_url', style: null, fetchedAt: new Date() }
            : {},
        });

        // 仅新候选或重新处理的候选才下发
        if (!existing || isReprocess) {
          if (candidate.videoUrl) {
            await prisma.hotVideoCandidate.update({
              where: { id: candidate.id },
              data: { status: 'processing' },
            });
            await dispatchToPython(candidate.id, candidate.videoUrl!, platform.id, config);
            newCount++;
          }
        }
      } catch (err) {
        errors.push(String(err));
      }
    }

    runState.lastResult[platform.id] = {
      fetched: videos.length,
      newCandidates: newCount,
      errors,
    };
  }

  runState.running = false;
  logger.info(`[materialUpdate] 采集完成: ${JSON.stringify(runState.lastResult)}`);
}

/**
 * 测试单个平台配置（回显解析结果，不下发不写库）。
 */
export async function testPlatform(platform: Platform): Promise<{ videos: ParsedVideo[]; rawResponse: unknown }> {
  const config = getMaterialUpdateConfig();
  const emptyCooldown: ReturnType<KeyPoolManager['getCooldownState']> = {};
  const result = await fetchPlatform(platform, config, emptyCooldown);
  return { videos: result.videos, rawResponse: null };
}
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | grep -i "materialUpdateService" || echo "No errors in materialUpdateService"
```
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/materialUpdateService.ts
git commit -m "feat: add materialUpdateService with concurrent curl, dedup upsert, and Python dispatch"
```

---

### 任务 6：materialUpdateScheduler.ts — Cron 调度器

**文件：**
- 创建：`apps/ts-api-gateway/src/services/materialUpdateScheduler.ts`
- 修改：`apps/ts-api-gateway/package.json`（新增 `cron-parser` 依赖）

- [ ] **步骤 1：安装 cron-parser 依赖**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && pnpm add cron-parser
```
预期：`cron-parser` 添加到 `dependencies`。

- [ ] **步骤 2：创建调度器**

创建 `apps/ts-api-gateway/src/services/materialUpdateScheduler.ts`：

```typescript
// materialUpdateScheduler.ts — cron 调度器（cron-parser + setTimeout，参照 monitorService 模式）
import cronParser from 'cron-parser';
import { logger } from '../lib/logger';
import { getMaterialUpdateConfig } from './materialUpdateConfig';
import { runMaterialUpdate, isRunning } from './materialUpdateService';

const timers: ReturnType<typeof setTimeout>[] = [];
const allCooldownRetryTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

/**
 * 计算多个 cron 表达式中最近的下一次执行时间。
 */
function getNextRunTime(cronExpressions: string[]): Date | null {
  let earliest: Date | null = null;
  for (const expr of cronExpressions) {
    try {
      const interval = cronParser.parseExpression(expr);
      const next = interval.next().toDate();
      if (!earliest || next < earliest) {
        earliest = next;
      }
    } catch (err) {
      logger.error(`[materialScheduler] 无效 cron 表达式: ${expr} - ${err}`);
    }
  }
  return earliest;
}

/**
 * 注册下一次执行。
 */
function scheduleNext(): void {
  const config = getMaterialUpdateConfig();
  if (!config.schedule.enabled) {
    logger.info('[materialScheduler] 调度未启用，不注册下次执行');
    return;
  }

  const nextRun = getNextRunTime(config.schedule.cron);
  if (!nextRun) {
    logger.warn('[materialScheduler] 无有效 cron 表达式，不注册下次执行');
    return;
  }

  const delay = nextRun.getTime() - Date.now();
  if (delay < 0) {
    // 已过期，立即执行
    logger.info('[materialScheduler] cron 时间已过期，立即执行');
    triggerRun();
    return;
  }

  const timer = setTimeout(() => {
    triggerRun();
  }, delay);

  timers.push(timer);
  logger.info(`[materialScheduler] 下次执行: ${nextRun.toISOString()} (${Math.round(delay / 1000)}s 后)`);
}

/**
 * 触发一次执行，执行完后注册下一次。
 */
async function triggerRun(): Promise<void> {
  if (isRunning()) {
    logger.warn('[materialScheduler] 上次执行仍在运行，跳过');
    scheduleNext();
    return;
  }

  try {
    await runMaterialUpdate();

    // 检查是否所有平台 key 全冷却，如果是则安排自动重试
    const config = getMaterialUpdateConfig();
    const now = Date.now();
    const allCooledDown = config.platforms
      .filter((p) => p.enabled)
      .every((p) => {
        const state = config.keyCooldownState[p.id] || {};
        return p.keyPool.keys.every((k) => {
          const expiry = state[k];
          return expiry && expiry > now;
        });
      });

    if (allCooledDown && config.platforms.some((p) => p.enabled)) {
      logger.info(`[materialScheduler] 所有平台 key 全冷却，${config.allCooldownRetryAfterMs}ms 后自动重试`);
      if (allCooldownRetryTimer.current) clearTimeout(allCooldownRetryTimer.current);
      allCooldownRetryTimer.current = setTimeout(() => {
        allCooldownRetryTimer.current = null;
        triggerRun();
      }, config.allCooldownRetryAfterMs);
    }
  } catch (err) {
    logger.error(`[materialScheduler] 执行失败: ${err}`);
  }

  scheduleNext();
}

/**
 * 清除所有定时器。
 */
function clearAllTimers(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.length = 0;
  if (allCooldownRetryTimer.current) {
    clearTimeout(allCooldownRetryTimer.current);
    allCooldownRetryTimer.current = null;
  }
}

/**
 * 启动调度器（应用启动时调用）。
 */
export function startMaterialUpdateScheduler(): void {
  const config = getMaterialUpdateConfig();
  if (!config.schedule.enabled) {
    logger.info('[materialScheduler] 调度未启用，跳过启动');
    return;
  }
  logger.info('[materialScheduler] 启动调度器');
  scheduleNext();
}

/**
 * 重载调度器（配置变更后调用，参照 restartMonitorScheduler 模式）。
 */
export function reloadMaterialUpdateScheduler(): void {
  clearAllTimers();
  startMaterialUpdateScheduler();
}

/**
 * 停止调度器（graceful shutdown 时调用）。
 */
export function stopMaterialUpdateScheduler(): void {
  clearAllTimers();
  logger.info('[materialScheduler] 调度器已停止');
}
```

- [ ] **步骤 3：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | grep -i "materialUpdateScheduler" || echo "No errors in materialUpdateScheduler"
```
预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/materialUpdateScheduler.ts apps/ts-api-gateway/package.json
git commit -m "feat: add materialUpdateScheduler with cron-parser + setTimeout + all-cooldown retry"
```

---

### 任务 7：config-material.ts — 配置路由

**文件：**
- 创建：`apps/ts-api-gateway/src/routes/config-material.ts`

- [ ] **步骤 1：创建配置路由**

创建 `apps/ts-api-gateway/src/routes/config-material.ts`：

```typescript
// config-material.ts — 素材更新配置路由
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getMaterialUpdateConfig,
  saveMaterialUpdateConfig,
  DEFAULT_CONFIG,
  type Platform,
} from '../services/materialUpdateConfig';
import { testPlatform } from '../services/materialUpdateService';
import { reloadMaterialUpdateScheduler } from '../services/materialUpdateScheduler';
import { logger } from '../lib/logger';

export const configMaterialRouter = Router();

// ============================================================
// GET /api/v1/config-material — 读取配置
// ============================================================
configMaterialRouter.get('/', (_req: Request, res: Response) => {
  const config = getMaterialUpdateConfig();
  res.json({
    success: true,
    data: config,
    meta: {
      carrier: 'data/settings-overrides.json',
      strategy: 'hot',
    },
  });
});

// ============================================================
// PUT /api/v1/config-material — 保存配置 + 触发调度器 reload
// ============================================================
const putBodySchema = z.object({}).passthrough(); // 允许任意字段，前端发完整配置对象

configMaterialRouter.put('/', (req: Request, res: Response) => {
  const parsed = putBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const merged = saveMaterialUpdateConfig(parsed.data);
  reloadMaterialUpdateScheduler();
  logger.info('[config-material] 配置已保存，调度器已重载');

  res.json({
    success: true,
    data: merged,
    message: '配置已保存，下次抓取生效',
  });
});

// ============================================================
// POST /api/v1/config-material/test — 测试单个平台 curl + 解析回显
// ============================================================
configMaterialRouter.post('/test', async (req: Request, res: Response) => {
  const platform = req.body as Platform;
  if (!platform || !platform.id || !platform.request?.url) {
    res.status(400).json({ success: false, error: '缺少 platform.id 或 platform.request.url' });
    return;
  }

  try {
    const result = await testPlatform(platform);
    res.json({
      success: true,
      data: {
        videoCount: result.videos.length,
        videos: result.videos.slice(0, 10), // 最多回显 10 条
      },
    });
  } catch (err) {
    logger.error(`[config-material] 测试平台 ${platform.id} 失败: ${err}`);
    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | grep -i "config-material" || echo "No errors in config-material"
```
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/config-material.ts
git commit -m "feat: add config-material routes (GET/PUT/test) with scheduler reload"
```

---

### 任务 8：material-update.ts — 运行/状态/候选/Webhook 路由

**文件：**
- 创建：`apps/ts-api-gateway/src/routes/material-update.ts`

- [ ] **步骤 1：创建运行态路由**

创建 `apps/ts-api-gateway/src/routes/material-update.ts`：

```typescript
// material-update.ts — 素材更新运行态路由
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getMaterialUpdateConfig } from '../services/materialUpdateConfig';
import { runMaterialUpdate, isRunning, getRunState } from '../services/materialUpdateService';
import { logger } from '../lib/logger';

export const materialUpdateRouter = Router();

// ============================================================
// POST /api/v1/material-update/run — 手动触发一次全量采集
// ============================================================
materialUpdateRouter.post('/run', async (_req: Request, res: Response) => {
  if (isRunning()) {
    res.status(409).json({ success: false, error: '采集正在运行中' });
    return;
  }

  // 非阻塞触发
  runMaterialUpdate().catch((err) => {
    logger.error(`[material-update] 手动触发失败: ${err}`);
  });

  res.status(202).json({ success: true, message: '采集已触发' });
});

// ============================================================
// GET /api/v1/material-update/status — 运行态 + key 冷却状态
// ============================================================
materialUpdateRouter.get('/status', (_req: Request, res: Response) => {
  const config = getMaterialUpdateConfig();
  const runState = getRunState();
  const now = Date.now();

  const platformStatus = config.platforms.map((p) => {
    const state = config.keyCooldownState[p.id] || {};
    const keys = p.keyPool.keys.map((k) => {
      const expiry = state[k];
      const cooledDown = expiry && expiry > now;
      return {
        masked: k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : k,
        cooledDown: !!cooledDown,
        cooldownRemaining: cooledDown ? expiry - now : 0,
      };
    });
    return {
      platformId: p.id,
      platformName: p.name,
      enabled: p.enabled,
      keys,
    };
  });

  // 候选计数
  prisma.hotVideoCandidate
    .groupBy({ by: ['status'], _count: true })
    .then((counts) => {
      const candidateCounts: Record<string, number> = {};
      for (const c of counts) candidateCounts[c.status] = c._count;
      res.json({
        success: true,
        data: {
          running: runState.running,
          lastRunAt: runState.lastRunAt,
          lastResult: runState.lastResult,
          platforms: platformStatus,
          candidateCounts,
        },
      });
    })
    .catch((err) => {
      res.status(500).json({ success: false, error: String(err) });
    });
});

// ============================================================
// GET /api/v1/material-update/candidates — 候选视频分页预览
// ============================================================
const candidatesQuerySchema = z.object({
  page: z.string().optional().default('1'),
  pageSize: z.string().optional().default('20'),
  platformId: z.string().optional(),
  status: z.string().optional(),
});

materialUpdateRouter.get('/candidates', async (req: Request, res: Response) => {
  const parsed = candidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { page, pageSize, platformId, status } = parsed.data;
  const pageNum = parseInt(page, 10);
  const size = parseInt(pageSize, 10);

  const where: Record<string, unknown> = {};
  if (platformId) where.platformId = platformId;
  if (status) where.status = status;

  try {
    const [items, total] = await Promise.all([
      prisma.hotVideoCandidate.findMany({
        where,
        orderBy: { fetchedAt: 'desc' },
        skip: (pageNum - 1) * size,
        take: size,
      }),
      prisma.hotVideoCandidate.count({ where }),
    ]);

    res.json({
      success: true,
      data: { items, total, page: pageNum, pageSize: size },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ============================================================
// POST /api/v1/material-update/webhook — Python Worker 完成回调
// ============================================================
const webhookBodySchema = z.object({
  candidate_id: z.string().optional(),
  task_id: z.string(),
  status: z.string(),
  style: z.string().nullable().optional(),
  result: z.record(z.unknown()).optional(),
  error: z.string().nullable().optional(),
});

materialUpdateRouter.post('/webhook', async (req: Request, res: Response) => {
  const parsed = webhookBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { candidate_id, status, style, error } = parsed.data;

  logger.info(`[material-update] webhook 回调: candidate=${candidate_id} status=${status} style=${style}`);

  if (candidate_id) {
    try {
      // 映射 Python 状态到 candidate 状态
      const candidateStatus = status === 'completed'
        ? (style ? 'accepted' : 'rejected')
        : 'rejected';

      await prisma.hotVideoCandidate.update({
        where: { id: candidate_id },
        data: {
          status: candidateStatus,
          style: style || null,
        },
      });
      logger.info(`[material-update] 候选 ${candidate_id} 更新为 ${candidateStatus}`);
    } catch (err) {
      logger.error(`[material-update] 更新候选 ${candidate_id} 失败: ${err}`);
    }
  }

  res.json({ success: true });
});
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | grep -i "material-update.ts" || echo "No errors in material-update.ts"
```
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/material-update.ts
git commit -m "feat: add material-update routes (run/status/candidates/webhook)"
```

---

### 任务 9：index.ts — 路由注册与调度器启动

**文件：**
- 修改：`apps/ts-api-gateway/src/index.ts`

- [ ] **步骤 1：在 index.ts 中注册路由和启动调度器**

在 `apps/ts-api-gateway/src/index.ts` 中：

**1) 在 import 区块（约第 20-40 行附近，与其他 router import 并列）新增：**

```typescript
import { configMaterialRouter } from './routes/config-material';
import { materialUpdateRouter } from './routes/material-update';
```

**2) 在路由注册区块（约第 88-116 行，与其他 `app.use` 并列）新增两行：**

```typescript
app.use('/api/v1/config-material', configMaterialRouter);
app.use('/api/v1/material-update', materialUpdateRouter);
```

**3) 在 import 区块新增调度器 import：**

```typescript
import { startMaterialUpdateScheduler, stopMaterialUpdateScheduler } from './services/materialUpdateScheduler';
```

**4) 在 `app.listen` 回调中（约第 128-140 行，`startMonitorScheduler()` 之后）新增：**

```typescript
  startMaterialUpdateScheduler();
```

**5) 在 `SIGTERM`/`SIGINT` 处理中（约第 163-171 行）新增停止调度器：**

在 `process.exit(0)` 之前新增：

```typescript
  stopMaterialUpdateScheduler();
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit --pretty 2>&1 | tail -5
```
预期：无错误。

- [ ] **步骤 3：启动服务验证路由注册**

运行：
```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && timeout 5 npx tsx src/index.ts 2>&1 || true
```
预期：日志中出现 `/api/v1/config-material` 和 `/api/v1/material-update` 相关注册信息，无启动崩溃。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/index.ts
git commit -m "feat: register material-update routes and start scheduler in index.ts"
```

---

### 任务 10：Python — download_from_url HTTP 直链下载

**文件：**
- 修改：`apps/python-worker/app/services/ffmpeg.py`（在 `download_from_oss` 之后新增函数）

- [ ] **步骤 1：在 ffmpeg.py 中新增 download_from_url 函数**

在 `apps/python-worker/app/services/ffmpeg.py` 的 `download_from_oss` 函数之后（第 30 行之后）新增：

```python


async def download_from_url(url: str, local_path: str, timeout: float = 120.0) -> str:
    """
    从 HTTP/HTTPS 直链下载文件到本地路径（流式下载）。
    用于素材更新热门视频采集场景，与 download_from_oss 并存。
    """
    import httpx

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(local_path, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    f.write(chunk)

    logger.info(f"HTTP 下载完成: {url} → {local_path}")
    return local_path
```

- [ ] **步骤 2：验证语法**

运行：
```bash
cd /home/lrp/social_media_complete/apps/python-worker && python -c "from app.services.ffmpeg import download_from_url; print('OK')"
```
预期：输出 `OK`。

- [ ] **步骤 3：Commit**

```bash
git add apps/python-worker/app/services/ffmpeg.py
git commit -m "feat: add download_from_url for HTTP direct link download"
```

---

### 任务 11：Python — MaterialUpdateRequest 模型扩展

**文件：**
- 修改：`apps/python-worker/app/models/__init__.py`（新增模型）
- 修改：`apps/python-worker/app/routers/tasks.py`（改为从 models 导入）
- 修改：`apps/python-worker/app/config.py`（新增 webhook URL 配置）

- [ ] **步骤 1：在 models/__init__.py 中新增 MaterialUpdateRequest**

在 `apps/python-worker/app/models/__init__.py` 的 `RenderTaskRequest` 之后（约第 34 行之后）新增：

```python


class MaterialUpdateRequest(BaseModel):
    """素材更新请求（热门视频采集）"""
    task_id: str
    task_type: str = "material_update"
    # 旧入口兼容
    oss_urls: list[str] = Field(default_factory=list)
    platform: str = "unknown"
    user_id: str | None = None
    # 新增字段（热门视频采集）
    candidate_id: str | None = None
    video_url: str | None = None
    frame_interval_ms: int = 1000
    evaluate_prompt: str | None = None
    styles: list[dict] | None = None
    min_rating: int = 4
```

- [ ] **步骤 2：修改 tasks.py 改为从 models 导入**

在 `apps/python-worker/app/routers/tasks.py` 中：

**2a) 修改 import 行（第 11 行）：**

将：
```python
from app.models import MaterialTaskRequest, RenderTaskRequest, TaskResponse
```
改为：
```python
from app.models import MaterialTaskRequest, MaterialUpdateRequest, RenderTaskRequest, TaskResponse
```

**2b) 删除局部定义的 `MaterialUpdateRequest`（第 16-22 行）：**

删除以下代码块：
```python
class MaterialUpdateRequest(BaseModel):
    """素材更新请求"""
    task_id: str
    task_type: str = "material_update"
    oss_urls: list[str]
    platform: str
    user_id: str | None = None
```

同时删除现在不再需要的 `from pydantic import BaseModel` import（如果该文件中没有其他 BaseModel 使用）——检查后保留或删除。

- [ ] **步骤 3：在 config.py 中新增 webhook URL 配置**

在 `apps/python-worker/app/config.py` 的 `ts_webhook_url` 字段之后（第 28 行之后）新增：

```python
    # TS 素材更新 webhook 回调（独立端点）
    ts_material_webhook_url: str = "http://localhost:3001/api/v1/material-update/webhook"
```

- [ ] **步骤 4：验证导入链**

运行：
```bash
cd /home/lrp/social_media_complete/apps/python-worker && python -c "
from app.models import MaterialUpdateRequest
req = MaterialUpdateRequest(task_id='test', video_url='https://example.com/v.mp4', candidate_id='c1')
print(f'candidate_id={req.candidate_id}, video_url={req.video_url}, frame_interval_ms={req.frame_interval_ms}')
print(f'oss_urls={req.oss_urls} (default empty list)')
print('OK')
"
```
预期：输出 `candidate_id=c1, video_url=https://example.com/v.mp4, frame_interval_ms=1000` 和 `oss_urls=[]`。

- [ ] **步骤 5：验证 FastAPI 路由仍可加载**

运行：
```bash
cd /home/lrp/social_media_complete/apps/python-worker && python -c "
from app.routers.tasks import router
print(f'Routes: {[r.path for r in router.routes]}')
print('OK')
"
```
预期：输出包含 `/api/v1/tasks/material-update`。

- [ ] **步骤 6：Commit**

```bash
git add apps/python-worker/app/models/__init__.py apps/python-worker/app/routers/tasks.py apps/python-worker/app/config.py
git commit -m "feat: extend MaterialUpdateRequest model with video_url/prompt/styles fields + webhook URL config"
```

---

### 任务 12：Python — process_material_update 重构

**文件：**
- 修改：`apps/python-worker/app/workers/material_tasks.py`（全文重构）

这是 Python 侧最大的改造。需要：
1. 修复 arq 函数签名（加 `ctx` 参数）
2. 入参分发（`video_url` 新路径 vs `oss_urls` 旧路径）
3. 按间隔抽帧（替换场景切分 + 每段 1 帧）
4. 评估提示词可配 + 实际发送图片给 LLM
5. 风格命中判定 + 达标落盘 / 未命中 rejected
6. webhook 回调带 `candidate_id` + `style`

- [ ] **步骤 1：重构 material_tasks.py 全文**

将 `apps/python-worker/app/workers/material_tasks.py` **全文替换**为：

```python
"""
素材更新任务 - 切分/抽帧/LLM评级/分类落盘
工作流: 下载素材 → 按间隔抽帧 → LLM风格评级(可配提示词) → 风格命中落盘
支持两种入口:
  1. video_url (新): HTTP 直链下载 → 按间隔抽帧 → 评估 → 落盘
  2. oss_urls (旧): OSS 下载 → 场景切分 → 抽帧 → 评估 → 落盘 (向后兼容)
"""

import asyncio
import base64
import json
import os
import shutil
import tempfile
from app.middleware.logging import logger
from app.middleware.trace import get_trace_id, set_trace_id
from app.config import settings
from app.services.ffmpeg import download_from_oss, download_from_url
from app.services.llm_client import llm_client
from app.models import WebhookCallback
from app.services.webhook import callback_ts_webhook
import httpx


MATERIAL_BASE = os.path.join(os.path.expanduser("~"), "data", "materials")


async def process_material_update(ctx, task_data: dict) -> dict:
    """
    素材更新主流程（ARQ 任务函数，ctx 为 ARQ 上下文）
    入参分发: video_url → 新路径, oss_urls → 旧路径
    """
    task_id = task_data["task_id"]
    trace_id = task_data.get("trace_id", task_id)
    set_trace_id(trace_id)

    # 从入参读取可配参数（新字段）
    candidate_id = task_data.get("candidate_id")
    evaluate_prompt = task_data.get("evaluate_prompt")
    styles = task_data.get("styles", [])
    min_rating = task_data.get("min_rating", 4)
    frame_interval_ms = task_data.get("frame_interval_ms", 1000)
    platform = task_data.get("platform", "unknown")
    video_url = task_data.get("video_url")

    logger.info(f"🎬 素材更新开始: {task_id} (candidate={candidate_id})")

    temp_dir = tempfile.mkdtemp(prefix=f"material_{task_id}_")
    downloaded = []

    try:
        # 1. 下载素材（入参分发）
        if video_url:
            # 新路径: HTTP 直链下载
            local = os.path.join(temp_dir, f"source_video{_ext_from_url(video_url)}")
            await download_from_url(video_url, local)
            downloaded.append(local)
            logger.info(f"HTTP 直链下载: {os.path.basename(local)}")
        else:
            # 旧路径: OSS 下载（向后兼容）
            oss_urls = task_data.get("oss_urls", [task_data.get("oss_url")])
            for i, url in enumerate(oss_urls):
                if not url:
                    continue
                local = os.path.join(temp_dir, f"source_{i}{_ext_from_url(url)}")
                await download_from_oss(url, local)
                downloaded.append(local)
                logger.info(f"OSS 下载: {os.path.basename(local)}")

        # 2. 逐素材处理
        results = []
        for src_path in downloaded:
            is_image = src_path.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif'))

            if is_image:
                frames = [src_path]
            else:
                # 视频按间隔抽帧
                frames = await _extract_frames_by_interval(src_path, temp_dir, frame_interval_ms)

            if frames:
                result = await _rate_and_match(frames, evaluate_prompt, styles, min_rating)
            else:
                result = {"style": None, "rating": 0, "matched": False, "accepted": False}

            results.append(result)

        # 3. 分类落盘（仅 accepted 的素材）
        moved = await _classify_and_store(downloaded, results, platform, task_id, styles)

        # 4. 回调 TS
        # 取第一个结果作为 candidate 的 style（单视频场景）
        primary_result = results[0] if results else {"style": None, "accepted": False}
        await _callback_material(
            candidate_id=candidate_id,
            task_id=task_id,
            status="completed",
            style=primary_result.get("style") if primary_result.get("accepted") else None,
            accepted=primary_result.get("accepted", False),
            total=len(downloaded),
            moved=moved,
        )

        logger.info(f"✅ 素材更新完成: {task_id} ({moved}/{len(downloaded)} 落盘)")
        return {"status": "completed", "task_id": task_id, "count": moved}

    except Exception as e:
        logger.error(f"❌ 素材更新失败: {task_id} - {e}")
        await _callback_material(
            candidate_id=candidate_id,
            task_id=task_id,
            status="failed",
            style=None,
            accepted=False,
            total=0,
            moved=0,
            error=str(e),
        )
        raise

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================
# 内部辅助函数
# ============================================================

async def _extract_frames_by_interval(video_path: str, output_dir: str, interval_ms: int) -> list:
    """
    按 fps filter 等间隔抽帧（替换旧的场景切分 + 每段 1 帧）。
    interval_ms 毫秒抽一帧。
    """
    fps = 1000.0 / interval_ms if interval_ms > 0 else 1.0
    output_pattern = os.path.join(output_dir, "frame_%04d.jpg")
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps:.6f}",
        "-q:v", "2",
        "-y", output_pattern,
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.communicate(), timeout=300)  # 5 分钟超时保护
    except asyncio.TimeoutError:
        logger.warning(f"抽帧超时(300s)，使用已生成的帧")

    frames = sorted([
        os.path.join(output_dir, f) for f in os.listdir(output_dir)
        if f.startswith("frame_") and f.endswith(".jpg")
    ])
    logger.info(f"按间隔({interval_ms}ms)抽帧: {len(frames)} 帧")
    return frames


async def _rate_and_match(
    frames: list,
    evaluate_prompt: str | None,
    styles: list[dict],
    min_rating: int,
) -> dict:
    """
    LLM 评估 + 风格匹配。
    返回 {style, rating, matched, accepted, matched_style_dir}
    """
    # 使用可配提示词，fallback 到默认
    prompt = evaluate_prompt or """分析这张视频截图，返回 JSON（只返回 JSON 不要其他内容）：
{
  "style": "风格分类名称",
  "rating": "品质评级 1-5 (1最低,5最高)",
  "description": "简短描述"
}"""

    # 取最多 3 帧评估
    ratings = []
    matched_styles = []
    for frame in frames[:3]:
        result = await _rate_image_with_llm(frame, prompt)
        if result:
            ratings.append(result)
            # 风格匹配
            style_name = result.get("style", "")
            for s in styles:
                s_name = s.get("name", "")
                s_keywords = s.get("keywords", [])
                if style_name == s_name or any(kw in style_name for kw in s_keywords):
                    matched_styles.append(s.get("dir", s_name))
                    break

    if not ratings:
        return {"style": None, "rating": 0, "matched": False, "accepted": False}

    # 取众数风格
    from collections import Counter
    style_counter = Counter(r.get("style", "") for r in ratings)
    primary_style = style_counter.most_common(1)[0][0] if style_counter else None

    # 平均评级
    avg_rating = round(sum(int(r.get("rating", 3)) for r in ratings) / len(ratings))

    # 风格命中 + 达标 → accepted
    matched = len(matched_styles) > 0
    accepted = matched and avg_rating >= min_rating
    matched_dir = matched_styles[0] if matched_styles else None

    return {
        "style": primary_style,
        "rating": avg_rating,
        "matched": matched,
        "accepted": accepted,
        "matched_style_dir": matched_dir,
    }


async def _rate_image_with_llm(image_path: str, prompt: str) -> dict | None:
    """
    发送图片 + prompt 到 LLM，返回解析后的 dict。
    使用 base64 编码图片，通过 multimodal 消息格式发送。
    """
    try:
        # 读取图片并 base64 编码
        with open(image_path, "rb") as f:
            image_b64 = base64.b64encode(f.read()).decode("utf-8")

        # 判断 MIME 类型
        ext = os.path.splitext(image_path)[1].lower()
        mime = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "image/jpeg")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
                ],
            }
        ]

        text = await llm_client.get_content("gemini-2.0-flash", messages)
        cleaned = await _parse_json(text)
        return json.loads(cleaned)
    except Exception as e:
        logger.warning(f"LLM 评级降级: {e}")
        return None


async def _classify_and_store(
    sources: list,
    results: list,
    platform: str,
    task_id: str,
    styles: list[dict],
) -> int:
    """
    按风格命中落盘到 data/materials/{style_dir}/{platform}/
    仅 accepted 的素材才落盘。
    """
    moved = 0
    for src, result in zip(sources, results):
        if not result.get("accepted"):
            logger.info(f"跳过未达标素材: {os.path.basename(src)} (rating={result.get('rating')}, matched={result.get('matched')})")
            continue

        try:
            style_dir = result.get("matched_style_dir") or result.get("style") or "未分类"
            # 落盘路径: data/materials/{style_dir}/{platform}/
            dest_dir = os.path.join(MATERIAL_BASE, style_dir, platform)
            os.makedirs(dest_dir, exist_ok=True)

            dest_path = os.path.join(dest_dir, os.path.basename(src))
            shutil.copy2(src, dest_path)
            moved += 1
            logger.info(f"归档: {os.path.relpath(dest_path, MATERIAL_BASE)}")
        except Exception as e:
            logger.warning(f"归档失败: {os.path.basename(src)} - {e}")
    return moved


async def _callback_material(
    candidate_id: str | None,
    task_id: str,
    status: str,
    style: str | None,
    accepted: bool,
    total: int,
    moved: int,
    error: str | None = None,
) -> None:
    """
    回调 TS 侧 /api/v1/material-update/webhook。
    带 candidate_id + style + status。
    """
    if not candidate_id:
        # 无 candidate_id 时走标准 webhook
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status=status,
            result={"total": total, "classified": moved, "style": style},
            error=error,
        ))
        return

    # 带 candidate_id 的专用回调
    trace_id = get_trace_id()
    payload = {
        "candidate_id": candidate_id,
        "task_id": task_id,
        "status": status,
        "style": style if accepted else None,
        "result": {"total": total, "classified": moved, "accepted": accepted},
        "error": error,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                settings.ts_material_webhook_url,
                json=payload,
                headers={"X-Trace-Id": trace_id},
            )
            response.raise_for_status()
            logger.info(f"✅ Material webhook 回调成功: candidate={candidate_id}")
    except Exception as e:
        logger.error(f"❌ Material webhook 回调失败: candidate={candidate_id} - {e}")


def _ext_from_url(url: str) -> str:
    """从 URL 提取文件扩展名"""
    from urllib.parse import urlparse
    ext = os.path.splitext(urlparse(url).path)[1]
    return ext if ext else ".mp4"


async def _parse_json(text: str) -> str:
    """剥离 Markdown 代码块，返回纯 JSON 字符串"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1])
    return text
```

- [ ] **步骤 2：验证语法和导入**

运行：
```bash
cd /home/lrp/social_media_complete/apps/python-worker && python -c "
from app.workers.material_tasks import process_material_update
import inspect
sig = inspect.signature(process_material_update)
params = list(sig.parameters.keys())
print(f'函数签名参数: {params}')
assert 'ctx' in params, '缺少 ctx 参数'
assert 'task_data' in params, '缺少 task_data 参数'
print('OK')
"
```
预期：输出 `函数签名参数: ['ctx', 'task_data']` 和 `OK`。

- [ ] **步骤 3：验证 ARQ Worker 可加载**

运行：
```bash
cd /home/lrp/social_media_complete/apps/python-worker && python -c "
from app.workers.tasks import WorkerSettings
print(f'注册函数数: {len(WorkerSettings.functions)}')
func_names = [getattr(f, '__name__', str(f)) for f in WorkerSettings.functions]
print(f'函数名: {func_names}')
assert 'process_material_update' in func_names, 'process_material_update 未注册'
print('OK')
"
```
预期：输出包含 `process_material_update` 的函数列表。

- [ ] **步骤 4：Commit**

```bash
git add apps/python-worker/app/workers/material_tasks.py
git commit -m "feat: refactor process_material_update with ctx fix, interval frames, configurable prompt, image sending, style matching, and candidate webhook"
```

---

### 任务 13：前端 — API Hooks

**文件：**
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`（在文件末尾追加新 hooks）

- [ ] **步骤 1：在 useApi.ts 末尾追加素材更新相关 hooks**

在 `apps/admin-dashboard/src/hooks/useApi.ts` 文件末尾追加：

```typescript

// ============================================================
// 素材更新 — 每周热门视频采集
// ============================================================

export function useMaterialConfig() {
  return useQuery({
    queryKey: ['config-material'],
    queryFn: () => api.get('/config-material').then((r) => r.data),
  });
}

export function useUpdateMaterialConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, any>) =>
      api.put('/config-material', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-material'] }),
  });
}

export function useTestPlatform() {
  return useMutation({
    mutationFn: (platform: Record<string, any>) =>
      api.post('/config-material/test', platform).then((r) => r.data),
  });
}

export function useTriggerMaterialRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/material-update/run').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['material-status'] }),
  });
}

export function useMaterialStatus() {
  return useQuery({
    queryKey: ['material-status'],
    queryFn: () => api.get('/material-update/status').then((r) => r.data),
    refetchInterval: 10000,
  });
}

export function useMaterialCandidates(page = 1, pageSize = 20, platformId?: string, status?: string) {
  const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
  if (platformId) params.platformId = platformId;
  if (status) params.status = status;
  return useQuery({
    queryKey: ['material-candidates', page, pageSize, platformId, status],
    queryFn: () => api.get('/material-update/candidates', { params }).then((r) => r.data),
  });
}
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit --pretty 2>&1 | grep -i "useApi" || echo "No errors in useApi"
```
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat: add material update API hooks (config/test/run/status/candidates)"
```

---

### 任务 14：前端 — 共享组件（KeyPoolEditor / CronListEditor / StyleListEditor）

**文件：**
- 创建：`apps/admin-dashboard/src/app/settings/components/KeyPoolEditor.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/components/CronListEditor.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/components/StyleListEditor.tsx`

- [ ] **步骤 1：创建 KeyPoolEditor**

创建 `apps/admin-dashboard/src/app/settings/components/KeyPoolEditor.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface KeyChip {
  key: string;
  masked: string;
  cooledDown: boolean;
  cooldownRemaining: number;
}

export function KeyPoolEditor({
  keys,
  placeholder,
  onChange,
  keyChips,
}: {
  keys: string[];
  placeholder: string;
  onChange: (keys: string[]) => void;
  keyChips?: KeyChip[];
}) {
  const [newKey, setNewKey] = useState('');

  const addKey = () => {
    if (!newKey.trim()) return;
    if (keys.includes(newKey.trim())) return;
    onChange([...keys, newKey.trim()]);
    setNewKey('');
  };

  const removeKey = (idx: number) => {
    onChange(keys.filter((_, i) => i !== idx));
  };

  const maskKey = (k: string) =>
    k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;

  // 运行态冷却信息
  const chipInfo = (k: string): KeyChip | undefined =>
    keyChips?.find((c) => c.key === k);

  return (
    <div className="space-y-2">
      {/* 占位符输入 */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-on-surface-variant shrink-0">占位符</span>
        <code className="form-input flex-1 font-mono text-sm bg-surface-container">
          {'{{' + placeholder + '}}'}
        </code>
      </div>

      {/* Key chip 流 */}
      <div className="flex flex-wrap gap-2">
        {keys.map((k, i) => {
          const info = chipInfo(k);
          const cooled = info?.cooledDown;
          const remaining = info?.cooldownRemaining || 0;
          const remainingMin = Math.ceil(remaining / 60000);
          return (
            <div
              key={i}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-mono border transition-all ${
                cooled
                  ? 'bg-surface-container text-on-surface-variant border-outline-variant opacity-60'
                  : 'bg-primary/10 text-primary border-primary/30'
              }`}
            >
              <span>{maskKey(k)}</span>
              {cooled && (
                <span className="text-xs bg-error/10 text-error px-1.5 py-0.5 rounded">
                  冷却 {remainingMin}m
                </span>
              )}
              <button
                type="button"
                onClick={() => removeKey(i)}
                className="btn-ghost text-error shrink-0 -mr-1"
              >
                <MaterialIcon icon="close" size="xs" />
              </button>
            </div>
          );
        })}
        {keys.length === 0 && (
          <p className="text-sm text-on-surface-variant italic">尚未配置 API Key</p>
        )}
      </div>

      {/* 新增 Key 输入 */}
      <div className="flex gap-2">
        <input
          className="form-input flex-1 font-mono text-sm"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKey())}
          placeholder="输入 API Key 后回车"
          type="password"
        />
        <button type="button" onClick={addKey} className="btn-secondary text-sm shrink-0">
          <MaterialIcon icon="add" size="sm" />
          添加
        </button>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：创建 CronListEditor**

创建 `apps/admin-dashboard/src/app/settings/components/CronListEditor.tsx`：

```tsx
'use client';

import { useMemo } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export function CronListEditor({
  crons,
  onChange,
}: {
  crons: string[];
  onChange: (crons: string[]) => void;
}) {
  const addCron = () => {
    onChange([...crons, '0 3 * * *']);
  };

  const updateCron = (idx: number, value: string) => {
    const next = [...crons];
    next[idx] = value;
    onChange(next);
  };

  const removeCron = (idx: number) => {
    onChange(crons.filter((_, i) => i !== idx));
  };

  // 下次执行预览（简单解析，不引入 cron-parser 前端依赖）
  const nextRunPreview = useMemo(() => {
    if (crons.length === 0) return null;
    // 仅做格式校验提示，实际下次执行由后端计算
    const valid = crons.filter((c) => c.trim().split(/\s+/).length >= 5);
    return valid.length > 0 ? `${valid.length} 个有效表达式` : '无有效表达式';
  }, [crons]);

  return (
    <div className="space-y-3">
      {crons.map((cron, i) => (
        <div key={i} className="flex gap-2 items-center">
          <code className="form-input flex-1 font-mono text-sm" contentEditable={false}>
            <input
              className="w-full bg-transparent font-mono text-sm outline-none"
              value={cron}
              onChange={(e) => updateCron(i, e.target.value)}
              placeholder="分 时 日 月 周 (如: 7 3 * * 1)"
            />
          </code>
          <button
            type="button"
            onClick={() => removeCron(i)}
            className="btn-ghost text-error shrink-0"
          >
            <MaterialIcon icon="delete" size="sm" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button type="button" onClick={addCron} className="btn-secondary text-sm">
          <MaterialIcon icon="add" size="sm" />
          新增 cron
        </button>
        {nextRunPreview && (
          <span className="text-sm text-on-surface-variant">{nextRunPreview}</span>
        )}
      </div>
      <p className="text-xs text-on-surface-variant">
        格式: 分 时 日 月 周 · 示例 <code className="font-mono">7 3 * * 1</code> = 每周一 03:07
      </p>
    </div>
  );
}
```

- [ ] **步骤 3：创建 StyleListEditor**

创建 `apps/admin-dashboard/src/app/settings/components/StyleListEditor.tsx`：

```tsx
'use client';

import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
}

export function StyleListEditor({
  styles,
  onChange,
}: {
  styles: StyleDef[];
  onChange: (styles: StyleDef[]) => void;
}) {
  const addStyle = () => {
    onChange([...styles, { name: '', dir: '', keywords: [] }]);
  };

  const updateStyle = (idx: number, field: keyof StyleDef, value: string | string[]) => {
    const next = [...styles];
    if (field === 'keywords') {
      next[idx] = { ...next[idx], keywords: (value as string).split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
    } else {
      next[idx] = { ...next[idx], [field]: value };
    }
    onChange(next);
  };

  const removeStyle = (idx: number) => {
    onChange(styles.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {styles.map((style, i) => (
        <div key={i} className="flex gap-2 items-start p-3 rounded-lg border border-outline-variant bg-surface-container-lowest">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 flex-1">
            <input
              className="form-input text-sm"
              value={style.name}
              onChange={(e) => updateStyle(i, 'name', e.target.value)}
              placeholder="风格名称"
            />
            <input
              className="form-input text-sm font-mono"
              value={style.dir}
              onChange={(e) => updateStyle(i, 'dir', e.target.value)}
              placeholder="落盘目录名"
            />
            <input
              className="form-input text-sm"
              value={style.keywords.join(', ')}
              onChange={(e) => updateStyle(i, 'keywords', e.target.value)}
              placeholder="关键词(逗号分隔)"
            />
          </div>
          <button
            type="button"
            onClick={() => removeStyle(i)}
            className="btn-ghost text-error shrink-0 mt-1"
          >
            <MaterialIcon icon="delete" size="sm" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addStyle} className="btn-secondary text-sm">
        <MaterialIcon icon="add" size="sm" />
        新增风格
      </button>
    </div>
  );
}
```

- [ ] **步骤 4：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit --pretty 2>&1 | grep -E "(KeyPoolEditor|CronListEditor|StyleListEditor)" || echo "No errors in new components"
```
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/KeyPoolEditor.tsx apps/admin-dashboard/src/app/settings/components/CronListEditor.tsx apps/admin-dashboard/src/app/settings/components/StyleListEditor.tsx
git commit -m "feat: add KeyPoolEditor, CronListEditor, StyleListEditor components"
```

---

### 任务 15：前端 — MaterialTab + PlatformCard

**文件：**
- 创建：`apps/admin-dashboard/src/app/settings/components/PlatformCard.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/tabs/MaterialTab.tsx`

- [ ] **步骤 1：创建 PlatformCard 组件**

创建 `apps/admin-dashboard/src/app/settings/components/PlatformCard.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { AccentBar } from '@/components/ui/Bento';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { KeyPoolEditor, type KeyChip } from './KeyPoolEditor';
import type { Platform } from '@/types/material';

// 平台色带颜色映射
const PLATFORM_COLORS: Record<string, string> = {
  douyin: 'error',
  xiaohongshu: 'error',
  kuaishou: 'warning',
  bilibili: 'primary',
  tiktok: 'success',
};
const DEFAULT_COLOR = 'primary';

export function PlatformCard({
  platform,
  onChange,
  onRemove,
  onTest,
  testing,
  testResult,
  keyChips,
}: {
  platform: Platform;
  onChange: (p: Platform) => void;
  onRemove: () => void;
  onTest: () => void;
  testing: boolean;
  testResult: { videoCount: number; videos: any[] } | null;
  keyChips?: KeyChip[];
}) {
  const [expanded, setExpanded] = useState(true);
  const colorName = PLATFORM_COLORS[platform.id.split('_')[0]] || DEFAULT_COLOR;

  const update = (patch: Partial<Platform>) => {
    onChange({ ...platform, ...patch });
  };

  const updateRequest = (patch: Partial<Platform['request']>) => {
    update({ request: { ...platform.request, ...patch } });
  };

  const updateParse = (patch: Partial<Platform['parse']>) => {
    update({ parse: { ...platform.parse, ...patch } });
  };

  return (
    <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
      <AccentBar color={colorName as any} />
      {/* 卡片头部 */}
      <div className="flex items-center gap-3 p-4 border-b border-outline-variant">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="btn-ghost shrink-0"
        >
          <MaterialIcon icon={expanded ? 'expand_more' : 'chevron_right'} size="sm" />
        </button>
        <input
          className="form-input flex-1 text-sm font-medium"
          value={platform.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="平台名称"
        />
        <code className="text-xs text-on-surface-variant font-mono">{platform.id}</code>
        {/* enabled 开关 */}
        <button
          type="button"
          onClick={() => update({ enabled: !platform.enabled })}
          className={`toggle-track ${platform.enabled ? 'bg-primary' : 'bg-surface-container-high'}`}
        >
          <span className={`toggle-thumb ${platform.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <button type="button" onClick={onRemove} className="btn-ghost text-error shrink-0">
          <MaterialIcon icon="delete" size="sm" />
        </button>
      </div>

      {/* 卡片内容 */}
      {expanded && (
        <div className="p-4 space-y-4">
          {/* 请求配置 */}
          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">请求配置</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
              <select
                className="form-input text-sm"
                value={platform.request.method}
                onChange={(e) => updateRequest({ method: e.target.value as 'GET' | 'POST' })}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
              <input
                className="form-input text-sm font-mono"
                value={platform.request.url}
                onChange={(e) => updateRequest({ url: e.target.value })}
                placeholder="https://api.example.com/...?term={{PAGE}}"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Headers</label>
                <KeyValueEditor
                  value={platform.request.headers}
                  onChange={(v) => updateRequest({ headers: v })}
                />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Params</label>
                <KeyValueEditor
                  value={platform.request.params}
                  onChange={(v) => updateRequest({ params: v })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">分页数</label>
                <input
                  type="number"
                  className="form-input text-sm"
                  value={platform.request.maxPages}
                  onChange={(e) => updateRequest({ maxPages: parseInt(e.target.value) || 1 })}
                  min={1}
                  max={10}
                />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">超时(ms)</label>
                <input
                  type="number"
                  className="form-input text-sm"
                  value={platform.request.timeoutMs}
                  onChange={(e) => updateRequest({ timeoutMs: parseInt(e.target.value) || 30000 })}
                  step={1000}
                />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Body (JSON)</label>
                <input
                  className="form-input text-sm font-mono"
                  value={platform.request.body || ''}
                  onChange={(e) => updateRequest({ body: e.target.value || null })}
                  placeholder="null"
                />
              </div>
            </div>
          </div>

          {/* Key 池 */}
          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">Key 池</h4>
            <KeyPoolEditor
              keys={platform.keyPool.keys}
              placeholder={platform.keyPool.placeholder}
              onChange={(keys) => update({ keyPool: { ...platform.keyPool, keys } })}
              keyChips={keyChips}
            />
          </div>

          {/* 解析配置 */}
          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">解析配置</h4>
            <div className="mb-2">
              <label className="text-xs text-on-surface-variant mb-1 block">列表路径 (点路径)</label>
              <input
                className="form-input text-sm font-mono"
                value={platform.parse.listPath}
                onChange={(e) => updateParse({ listPath: e.target.value })}
                placeholder="data.videos"
              />
            </div>
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">字段映射</label>
              <KeyValueEditor
                value={platform.parse.fields}
                onChange={(v) => updateParse({ fields: v })}
              />
            </div>
          </div>

          {/* 测试按钮 + 结果回显 */}
          <div className="flex items-center gap-3 pt-2 border-t border-outline-variant">
            <button
              type="button"
              onClick={onTest}
              disabled={testing}
              className="btn-primary text-sm"
            >
              <MaterialIcon icon={testing ? 'progress_activity' : 'network_check'} size="sm" spin={testing} />
              {testing ? '测试中...' : '测试请求'}
            </button>
            {testResult && (
              <div className="text-sm">
                <span className="text-on-surface-variant">解析到 </span>
                <span className="font-semibold text-primary">{testResult.videoCount}</span>
                <span className="text-on-surface-variant"> 条视频</span>
              </div>
            )}
          </div>
          {testResult && testResult.videos.length > 0 && (
            <div className="bg-surface-container rounded-lg p-3 max-h-48 overflow-y-auto">
              <pre className="text-xs font-mono text-on-surface-variant whitespace-pre-wrap">
                {JSON.stringify(testResult.videos, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **步骤 2：创建类型定义文件**

创建 `apps/admin-dashboard/src/types/material.ts`：

```typescript
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

export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
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

export interface MaterialUpdateConfig {
  platforms: Platform[];
  schedule: Schedule;
  processing: Processing;
  keyCooldownState: Record<string, Record<string, number>>;
  allCooldownRetryAfterMs: number;
}
```

- [ ] **步骤 3：创建 MaterialTab 组件**

创建 `apps/admin-dashboard/src/app/settings/tabs/MaterialTab.tsx`：

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { HeaderStrip } from '@/components/ui/Bento';
import { AccentBar } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { PlatformCard } from '../components/PlatformCard';
import { CronListEditor } from '../components/CronListEditor';
import { StyleListEditor, type StyleDef } from '../components/StyleListEditor';
import {
  useMaterialConfig,
  useUpdateMaterialConfig,
  useTestPlatform,
  useTriggerMaterialRun,
  useMaterialStatus,
  useMaterialCandidates,
} from '@/hooks/useApi';
import type { MaterialUpdateConfig, Platform } from '@/types/material';

const DEFAULT_PLATFORM: Platform = {
  id: '',
  name: '',
  enabled: true,
  request: {
    method: 'GET',
    url: '',
    headers: {},
    params: {},
    body: null,
    maxPages: 1,
    timeoutMs: 30000,
  },
  keyPool: { placeholder: 'API_KEY', keys: [], cooldownMs: 300000 },
  parse: { listPath: '', fields: {} },
};

export default function MaterialTab() {
  const configQuery = useMaterialConfig();
  const updateConfig = useUpdateMaterialConfig();
  const testPlatform = useTestPlatform();
  const triggerRun = useTriggerMaterialRun();
  const statusQuery = useMaterialStatus();
  const candidatesQuery = useMaterialCandidates(1, 12);

  const [form, setForm] = useState<MaterialUpdateConfig | null>(null);
  const initRef = useRef(false);
  const [savedPill, setSavedPill] = useState(false);
  const [testingPlatformId, setTestingPlatformId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { videoCount: number; videos: any[] }>>({});

  // 初始化表单
  useEffect(() => {
    if (configQuery.data && !initRef.current) {
      setForm(configQuery.data);
      initRef.current = true;
    }
  }, [configQuery.data]);

  // 保存
  const handleSave = () => {
    if (!form) return;
    updateConfig.mutate(form, {
      onSuccess: () => {
        setSavedPill(true);
        setTimeout(() => setSavedPill(false), 3000);
      },
    });
  };

  // 平台操作
  const addPlatform = () => {
    if (!form) return;
    const newPlatform: Platform = {
      ...DEFAULT_PLATFORM,
      id: `platform_${Date.now()}`,
      name: '新平台',
    };
    setForm({ ...form, platforms: [...form.platforms, newPlatform] });
  };

  const updatePlatform = (idx: number, p: Platform) => {
    if (!form) return;
    const platforms = [...form.platforms];
    platforms[idx] = p;
    setForm({ ...form, platforms });
  };

  const removePlatform = (idx: number) => {
    if (!form) return;
    setForm({ ...form, platforms: form.platforms.filter((_, i) => i !== idx) });
  };

  // 测试请求
  const handleTest = (platform: Platform) => {
    setTestingPlatformId(platform.id);
    testPlatform.mutate(platform, {
      onSuccess: (data) => {
        setTestResults({ ...testResults, [platform.id]: data });
        setTestingPlatformId(null);
      },
      onError: () => setTestingPlatformId(null),
    });
  };

  if (configQuery.isLoading) return <PanelSkeleton rows={8} />;
  if (configQuery.isError) return <QueryError />;
  if (!form) return null;

  // 运行态 key chip 信息
  const getKeyChips = (platformId: string) => {
    const platformStatus = statusQuery.data?.platforms?.find((p) => p.platformId === platformId);
    return platformStatus?.keys?.map((k: any) => ({
      key: '', // 不暴露完整 key
      masked: k.masked,
      cooledDown: k.cooledDown,
      cooldownRemaining: k.cooldownRemaining,
    }));
  };

  return (
    <div className="space-y-6 p-6">
      {/* 顶部 HeaderStrip */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="primary" />
        <HeaderStrip>
          <div className="flex items-center justify-between w-full">
            <div>
              <h2 className="text-headline-sm font-bold">素材更新 · 每周热门采集</h2>
              <p className="text-sm text-on-surface-variant mt-1">
                配置 RapidAPI 平台 → 定时采集热门视频 → LLM 评估 → 按风格落盘素材库
              </p>
            </div>
            <div className="flex items-center gap-2">
              {savedPill && (
                <StatusPill tone="success" icon="check_circle">
                  已保存 · 下次抓取生效
                </StatusPill>
              )}
              {statusQuery.data?.running && (
                <StatusPill tone="info" icon="progress_activity" dot>
                  采集中...
                </StatusPill>
              )}
            </div>
          </div>
        </HeaderStrip>
      </section>

      {/* 面板 1: 平台采集源管理 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="tertiary" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">平台采集源</h3>
          <button onClick={addPlatform} className="btn-primary text-sm">
            <MaterialIcon icon="add" size="sm" />
            新增平台
          </button>
        </HeaderStrip>
        <div className="p-4 space-y-3">
          {form.platforms.length === 0 && (
            <p className="text-sm text-on-surface-variant italic text-center py-4">
              尚未配置采集平台，点击「新增平台」开始
            </p>
          )}
          {form.platforms.map((p, i) => (
            <PlatformCard
              key={p.id}
              platform={p}
              onChange={(np) => updatePlatform(i, np)}
              onRemove={() => removePlatform(i)}
              onTest={() => handleTest(p)}
              testing={testingPlatformId === p.id}
              testResult={testResults[p.id] || null}
              keyChips={getKeyChips(p.id)}
            />
          ))}
        </div>
      </section>

      {/* 面板 2: 调度设置 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="success" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">调度设置</h3>
          <button
            type="button"
            onClick={() => setForm({ ...form, schedule: { ...form.schedule, enabled: !form.schedule.enabled } })}
            className={`toggle-track ${form.schedule.enabled ? 'bg-primary' : 'bg-surface-container-high'}`}
          >
            <span className={`toggle-thumb ${form.schedule.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </HeaderStrip>
        <div className="p-4">
          <CronListEditor
            crons={form.schedule.cron}
            onChange={(crons) => setForm({ ...form, schedule: { ...form.schedule, cron: crons } })}
          />
        </div>
      </section>

      {/* 面板 3: 处理与评估 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="warning" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">处理与评估</h3>
        </HeaderStrip>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">抽帧间隔 (ms)</label>
              <input
                type="number"
                className="form-input text-sm"
                value={form.processing.frameIntervalMs}
                onChange={(e) =>
                  setForm({
                    ...form,
                    processing: { ...form.processing, frameIntervalMs: parseInt(e.target.value) || 1000 },
                  })
                }
                step={500}
                min={100}
              />
            </div>
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">达标评级阈值 (1-5)</label>
              <input
                type="number"
                className="form-input text-sm"
                value={form.processing.minRating}
                onChange={(e) =>
                  setForm({
                    ...form,
                    processing: { ...form.processing, minRating: parseInt(e.target.value) || 4 },
                  })
                }
                min={1}
                max={5}
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">评估提示词</label>
            <textarea
              className="form-input text-sm font-mono w-full min-h-32"
              value={form.processing.evaluatePrompt}
              onChange={(e) =>
                setForm({
                  ...form,
                  processing: { ...form.processing, evaluatePrompt: e.target.value },
                })
              }
              rows={6}
            />
          </div>
          <div>
            <label className="text-sm font-semibold mb-2 block">风格列表</label>
            <StyleListEditor
              styles={form.processing.styles}
              onChange={(styles: StyleDef[]) =>
                setForm({ ...form, processing: { ...form.processing, styles } })
              }
            />
          </div>
        </div>
      </section>

      {/* 面板 4: 运行状态 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="error" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">运行状态</h3>
          <button
            onClick={() => triggerRun.mutate()}
            disabled={statusQuery.data?.running}
            className="btn-primary text-sm"
          >
            <MaterialIcon icon="play_arrow" size="sm" />
            立即执行
          </button>
        </HeaderStrip>
        <div className="p-4">
          {statusQuery.isLoading ? (
            <PanelSkeleton rows={3} />
          ) : statusQuery.data ? (
            <div className="space-y-3">
              {/* 候选计数 */}
              <div className="flex flex-wrap gap-2">
                {Object.entries(statusQuery.data.candidateCounts || {}).map(([status, count]) => (
                  <StatusPill key={status} tone={
                    status === 'accepted' ? 'success' :
                    status === 'rejected' ? 'error' :
                    status === 'processing' ? 'info' : 'neutral'
                  }>
                    {status}: {count as number}
                  </StatusPill>
                ))}
              </div>
              {/* 各平台 key 状态 */}
              {statusQuery.data.platforms?.map((p: any) => (
                <div key={p.platformId} className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{p.platformName}</span>
                  <span className="text-on-surface-variant">
                    {p.keys.filter((k: any) => !k.cooledDown).length}/{p.keys.length} key 可用
                  </span>
                  {p.keys.some((k: any) => k.cooledDown) && (
                    <span className="text-xs text-error">
                      {p.keys.filter((k: any) => k.cooledDown).length} 个冷却中
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <QueryError />
          )}
        </div>
      </section>

      {/* 面板 5: 候选视频预览 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="primary" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">候选视频预览</h3>
          <span className="text-sm text-on-surface-variant">
            共 {candidatesQuery.data?.total || 0} 条
          </span>
        </HeaderStrip>
        <div className="p-4">
          {candidatesQuery.isLoading ? (
            <PanelSkeleton rows={4} />
          ) : candidatesQuery.data?.items?.length ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {candidatesQuery.data.items.map((c: any) => (
                <div key={c.id} className="rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest">
                  {c.cover && (
                    <img src={c.cover} alt={c.title || ''} className="w-full aspect-video object-cover" />
                  )}
                  <div className="p-2">
                    <p className="text-sm font-medium truncate">{c.title || '(无标题)'}</p>
                    <p className="text-xs text-on-surface-variant">{c.author || '未知'}</p>
                    <div className="flex items-center gap-1 mt-1">
                      <StatusPill tone={
                        c.status === 'accepted' ? 'success' :
                        c.status === 'rejected' ? 'error' :
                        c.status === 'processing' ? 'info' : 'neutral'
                      }>
                        {c.status}
                      </StatusPill>
                      {c.style && <span className="text-xs text-on-surface-variant">{c.style}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant italic text-center py-4">
              暂无候选视频
            </p>
          )}
        </div>
      </section>

      {/* 底部保存按钮 */}
      <div className="sticky bottom-0 bg-surface-container-lowest/90 backdrop-blur border-t border-outline-variant p-4 -mx-6 -mb-6">
        <button onClick={handleSave} className="btn-primary w-full" disabled={updateConfig.isPending}>
          <MaterialIcon icon="save" size="sm" />
          {updateConfig.isPending ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **步骤 4：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit --pretty 2>&1 | grep -E "(MaterialTab|PlatformCard|material\.ts)" || echo "No errors in MaterialTab/PlatformCard"
```
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/PlatformCard.tsx apps/admin-dashboard/src/app/settings/tabs/MaterialTab.tsx apps/admin-dashboard/src/types/material.ts
git commit -m "feat: add MaterialTab with 5 panels + PlatformCard component"
```

---

### 任务 16：前端 — page.tsx Tab 接入

**文件：**
- 修改：`apps/admin-dashboard/src/app/settings/page.tsx`

- [ ] **步骤 1：修改 page.tsx 接入 MaterialTab**

在 `apps/admin-dashboard/src/app/settings/page.tsx` 中：

**1a) 修改 TabKey 类型（第 9 行）：**

将：
```tsx
type TabKey = 'general' | 'creation' | 'llm' | 'matrix';
```
改为：
```tsx
type TabKey = 'general' | 'creation' | 'llm' | 'matrix' | 'material';
```

**1b) 新增 import（第 7 行之后）：**

```tsx
import MaterialTab from './tabs/MaterialTab';
```

**1c) 新增 Tab 按钮（第 38 行之后，`matrix` TabButton 之后）：**

```tsx
          <TabButton active={activeTab === 'material'} onClick={() => setActiveTab('material')} icon="video_library" label="素材更新" />
```

**1d) 新增 Tab 内容 div（第 46 行之后，`matrix` div 之后）：**

```tsx
        <div style={{ display: activeTab === 'material' ? 'block' : 'none' }}><MaterialTab /></div>
```

- [ ] **步骤 2：验证编译**

运行：
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && npx tsc --noEmit --pretty 2>&1 | tail -5
```
预期：无错误。

- [ ] **步骤 3：启动前端验证页面加载**

运行：
```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard && timeout 15 pnpm dev 2>&1 | grep -i "error\|ready\|compiled" || true
```
预期：看到 `ready` 或 `compiled` 无错误。

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/page.tsx
git commit -m "feat: add material update tab to settings page"
```

---

## 端到端验证清单

完成所有 16 个任务后，执行以下手动验证：

1. **TS 网关启动**：`pnpm dev:ts` — 日志出现 `materialScheduler` 和路由注册，无崩溃
2. **Python Worker 启动**：`cd apps/python-worker && uvicorn app.main:app` — 无导入错误
3. **前端启动**：`pnpm dev:dashboard` — 设置页出现「素材更新」Tab
4. **配置往返**：前端 → 保存一个平台配置 → `cat data/settings-overrides.json` 确认 `materialUpdate` section 写入
5. **测试请求**：配置一个真实 RapidAPI 平台 → 点击「测试请求」→ 回显解析结果
6. **手动触发**：点击「立即执行」→ `GET /api/v1/material-update/status` 显示 running → 候选入库
7. **Python 处理**：检查 Python Worker 日志 — HTTP 下载 → 抽帧 → LLM 评估 → 落盘到 `~/data/materials/{style}/{platform}/`
8. **Webhook 回调**：TS 日志出现 `候选 xxx 更新为 accepted/rejected`
9. **候选预览**：前端「候选视频预览」面板显示封面 + 标题 + 状态
10. **单元测试**：`cd apps/ts-api-gateway && npx jest --verbose` — materialParser + materialKeyPool 全通过
