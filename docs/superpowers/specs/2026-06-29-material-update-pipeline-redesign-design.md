# 素材更新管线重构设计 · DB 驱动 + 视频落盘 + 占位符系统

- **日期**: 2026-06-29
- **状态**: 设计待审查
- **作者**: brainstorming session
- **关联**: 增量重构 `2026-06-27-material-update-hot-video-design.md` 已落地的采集链路

## 1. 背景与目标

### 1.1 现状

`2026-06-27-material-update-hot-video-design.md` 已落地「每周热门视频采集」链路：

- 设置中心 `MaterialTab` 可配平台（curl 请求体 + Key 池 + 解析规则）、cron、评估提示词、风格列表
- `materialUpdateService.ts` 多 key 轮询采集 → 解析 → 去重入 `hot_video_candidates` → 下发 Python Worker
- Python Worker 下载视频 → 抽帧 → LLM 评估 → webhook 回调
- `/material` 页面（`apps/admin-dashboard/src/app/material/page.tsx`）**仍全是 MOCK 数据**，未对接后端
- 解析配置是自由 `KeyValueEditor`（`parse.fields: Record<string, string>`），每平台都要手动写键名

### 1.2 本次要解决的问题

| 问题 | 现状 | 目标 |
|---|---|---|
| 调度器静默空跑 | TikTok `keys=[]` 时 `fetched=0, errors=[]`，UI 无任何告警 | StatusPill 明确提示「未配置 API Key」+ 跳转链接 |
| 解析字段自由配置易错 | 每平台手动写 `videoId` / `title` 等键名 | 固定 8 字段映射表，target 是标准字段名 |
| 查询词/数量不能动态注入 | 请求体写死，切换风格需改配置 | `{{QUERY}}` / `{{COUNT}}` / `{{PAGE}}` 占位符 |
| 风格与查询词不联动 | 风格只是 LLM 评估的分类标签 | 风格决定 `{{QUERY}}` 取值，支持按平台覆盖 |
| 视频文件不入库 | Python Worker 下载后路径仅 Worker 知 | 网关下载到本地 pending → 评估后移到 style 目录 → DB 记 `storagePath` |
| `/material` 页面是 mock | 全部硬编码数据 | 左侧快速采集面板 + 右侧资产库面板，对接真实 API |

### 1.3 非目标 (YAGNI)

- 不引入 OSS / S3 对象存储（仅本地磁盘）
- 不做视频转码 / 缩略图自动生成
- 不做 CDN 签名 URL 自动转 cookie（仅支持公开 URL）
- 不做跨表去重策略变化（仍按 `platform + videoId`）
- 不做 A/B 评估或多模型对比
- 不做配置历史版本/审计
- 不替换现有浏览器版达人监控

## 2. 关键决策（来自澄清）

| 决策点 | 选择 |
|---|---|
| 标准化解析字段 | 8 字段：videoId, title, likeCount, commentCount, videoUrl, cover, author, publishTime |
| 解析配置 UI | 仅固定字段映射表，移除自由 KeyValueEditor |
| 视频文件存储后端 | 仅本地磁盘 |
| 目录组织 | `{root}/{platform}/_pending/{date}/{id}.mp4` → 评估后移动到 `{root}/{platform}/{styleDir}/{date}/{id}.mp4` |
| DB 模型 | 扩 `hot_video_candidates` 表加列，不新建表 |
| 占位符 | `{{QUERY}}` / `{{COUNT}}` / `{{PAGE}}` 三个通用占位符 |
| 查询词策略 | 风格 + 平台 → 独立查询模板，可覆盖统一默认 |
| `/material` 页面定位 | 左侧快速采集面板 + 右侧资产库面板 |
| 0/0 状态反馈 | StatusPill 全面覆盖 + 「前往设置」跳转 |
| 交付方式 | 分 4 个 PR 提交，同一设计分步验收 |

## 3. 整体架构与数据流

```
[系统设置·素材更新 tab]
  ├── 平台采集源（PlatformCard：请求体含 {{QUERY}}/{{COUNT}}/{{PAGE}}）
  ├── 风格列表（StyleListEditor：keywords + platformOverrides）
  ├── 视频存储设置（新增：根路径 + 启用下载 toggle）
  ├── 调度设置（cron）
  └── 运行状态（StatusPill：含 no_keys 告警）
         │
         ▼ 配置写入 data/settings-overrides.json [section: materialUpdate]
         │
┌────────────────────────────────────────────────────────────────┐
│ TS 网关 materialUpdateService                                   │
│  1. cron 触发 / 手动触发（可带 styleDir + count 覆盖）            │
│  2. resolveQuery(style, platform) → {{QUERY}} 取值              │
│  3. 多 key 轮询 curl → 解析 8 字段 → 标准化视频对象               │
│  4. 去重(平台+videoId) → 写入 HotVideoCandidate (含 storageStatus)│
│  5. 下载视频到 {root}/{platform}/_pending/{date}/{id}.mp4        │
│     → storagePath 写入 DB, storageStatus='pending_downloaded'   │
│  6. 下发 Python Worker（传 local_path 而非 video_url）           │
└────────────────────────────────────────────────────────────────┘
         │ POST /api/v1/tasks/material-update { candidate_id, local_path, ... }
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Python Worker material_tasks.py                                 │
│  读本地文件 → 抽帧 → LLM 评估 → webhook 回调                     │
│  （不再自己下载，仅读 local_path）                                │
└────────────────────────────────────────────────────────────────┘
         │ POST /api/v1/material-update/webhook { candidate_id, status, style }
         ▼
┌────────────────────────────────────────────────────────────────┐
│ TS 网关 webhook handler                                         │
│  status=accepted → 移动文件到 {root}/{platform}/{styleDir}/{date}│
│     → storagePath 更新, storageStatus='archived', acceptedAt=now│
│  status=rejected → 删除 pending 文件                             │
│     → storageStatus='none'                                      │
└────────────────────────────────────────────────────────────────┘
```

## 4. 数据模型变更

### 4.1 Prisma Schema 扩列

`prisma/schema.prisma` 中 `HotVideoCandidate` 模型新增列：

```prisma
model HotVideoCandidate {
  // ... 现有字段保持不变
  id           String   @id @default(cuid())
  platform     String   @db.VarChar(64)
  videoId      String   @map("video_id") @db.VarChar(256)
  title        String?  @db.VarChar(512)
  author       String?  @db.VarChar(256)
  playCount    BigInt?  @map("play_count")
  cover        String?  @db.VarChar(1024)
  videoUrl     String?  @map("video_url") @db.VarChar(1024)
  publishTime  DateTime? @map("publish_time")
  rawJson      Json?    @map("raw_json")
  fetchedAt    DateTime @default(now()) @map("fetched_at")
  createdAt    DateTime @default(now()) @map("created_at")
  status       String   @default("pending") @db.VarChar(32)
  style        String?  @db.VarChar(64)

  // ── 新增列 ──
  likeCount      BigInt?  @map("like_count")
  commentCount   BigInt?  @map("comment_count")
  rating         Int?     // LLM 评估评级 1-5，webhook 回调时写入
  storagePath    String?  @map("storage_path") @db.VarChar(1024)
  storageStatus  String   @default("none") @map("storage_status") @db.VarChar(32)
  // none | pending_downloaded | archived | failed
  acceptedAt     DateTime? @map("accepted_at")
  failReason     String?  @map("fail_reason") @db.VarChar(512)

  @@unique([platform, videoId], name: "uq_hot_video_platform_video")
  @@index([fetchedAt], name: "idx_hot_video_fetched_at")
  @@index([status], name: "idx_hot_video_status")
  @@index([platform, status, fetchedAt], name: "idx_hot_video_platform_status_fetched")
  @@index([storageStatus], name: "idx_hot_video_storage_status")
  @@index([platform, storageStatus], name: "idx_hot_video_platform_storage")
  @@map("hot_video_candidates")
}
```

### 4.2 迁移策略

- 新列全部可空或有默认值，`prisma migrate dev` 自动生成迁移 SQL
- 现有行：`storagePath=NULL`, `storageStatus='none'`, `likeCount=NULL`, `commentCount=NULL`, `acceptedAt=NULL`
- 不回填历史数据
- 现有 `parse.fields`（自由键值）由 PR1 的迁移脚本尝试按字段名映射到新 `fieldMap`，匹配不上的留空让用户重配

### 4.3 配置结构变更

`data/settings-overrides.json` 的 `materialUpdate` 段：

```jsonc
{
  "platforms": [
    {
      "id": "platform_xxx",
      "name": "tiktok",
      "enabled": true,
      "request": {
        "method": "POST",
        "url": "https://api.example.com/search",
        "headers": { "X-API-Key": "{{API_KEY}}" },
        "params": {},
        "body": "{\"searchQueries\":[\"{{QUERY}}\"],\"resultsPerPage\":{{COUNT}}}",
        "maxPages": 1,
        "timeoutMs": 30000
      },
      "keyPool": { "placeholder": "API_KEY", "keys": [], "cooldownMs": 300000 },
      "parse": {
        "listPath": "data.videos",
        "fieldMap": {
          "videoId": "id",
          "title": "desc",
          "likeCount": "stats.diggCount",
          "commentCount": "stats.commentCount",
          "videoUrl": "playUrl",
          "cover": "cover",
          "author": "author.nickname",
          "publishTime": "createTime"
        }
      }
    }
  ],
  "schedule": { "cron": ["7 3 * * 1"], "enabled": false },
  "processing": {
    "frameIntervalMs": 1000,
    "evaluatePrompt": "...",
    "minRating": 4,
    "styles": [
      {
        "name": "口播",
        "dir": "口播",
        "keywords": ["口播", "讲解"],
        "platformOverrides": {
          "platform_xxx": ["口播教程", "讲解视频"]
        }
      }
    ]
  },
  "storage": {
    "enabled": true,
    "rootPath": "/data/videos"
  },
  "keyCooldownState": {},
  "allCooldownRetryAfterMs": 1800000
}
```

**变更点**：
- `Platform.parse.fields: Record<string, string>` → `Platform.parse.fieldMap: Record<TargetField, ResponsePath>`
- `StyleDef` 新增可选 `platformOverrides?: Record<platformId, string[]>`
- 新增顶层 `storage: { enabled: boolean, rootPath: string }`

## 5. PR1 — 占位符系统 + 标准解析字段

### 5.1 范围

**后端**：
- `materialUpdateConfig.ts`：类型定义更新（`fieldMap` 替代 `fields`，`StyleDef.platformOverrides`，`storage` 配置段）
- `materialUpdateService.ts`：
  - `injectPlaceholders` 扩展支持 `{{QUERY}}` / `{{COUNT}}`
  - body JSON 嵌套替换：先 `JSON.parse` → 递归遍历 string 值替换占位符 → `JSON.stringify`
  - `parseVideoList` 改用 `fieldMap`（8 字段固定键），返回 `ParsedVideo` 含 `likeCount` / `commentCount`
- `materialParser.ts`：解析逻辑改用 `fieldMap`，`listPath` 仍是点路径定位数组，数组每项按 `fieldMap` 取值
- 迁移脚本 `scripts/migrate-parse-fields.ts`：读取现有配置，按字段名匹配映射到 `fieldMap`

**前端**：
- `PlatformCard.tsx`：解析配置区把 `KeyValueEditor` 替换为「8 字段固定映射表」组件 `FieldMapEditor`
  - 每行：`<label>videoId</label> <input value={fieldMap.videoId} placeholder="点路径，如 data.videos[*].id" />`
  - 8 行固定，不可增删
- `StyleListEditor.tsx`：每条风格下方加「按平台覆盖」可展开区
  - 展开后：列出当前所有平台，每平台一个 input（逗号分隔关键词）
  - 空值 = 用统一 `keywords`
- `types/material.ts`：类型同步更新

### 5.2 占位符注入规则

```ts
// materialUpdateService.ts
function injectPlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    // COUNT 是数字不编码，QUERY/PAGE/API_KEY 按 URL 编码
    const isNumeric = placeholder === 'COUNT';
    result = result.replace(regex, isNumeric ? value : encodeURIComponent(value));
  }
  return result;
}

// body 处理（如果是 JSON 字符串）
function injectBodyPlaceholders(bodyStr: string, vars: Record<string, string>): string {
  try {
    const parsed = JSON.parse(bodyStr);
    const injected = deepReplaceStrings(parsed, vars);
    return JSON.stringify(injected);
  } catch {
    // 不是合法 JSON，按纯字符串替换
    return injectPlaceholders(bodyStr, vars);
  }
}

function deepReplaceStrings(obj: any, vars: Record<string, string>): any {
  if (typeof obj === 'string') return injectPlaceholders(obj, vars);
  if (Array.isArray(obj)) return obj.map(v => deepReplaceStrings(v, vars));
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) result[k] = deepReplaceStrings(v, vars);
    return result;
  }
  return obj;
}
```

### 5.3 风格 → 查询词解析

```ts
function resolveQuery(style: StyleDef, platformId: string): string {
  const keywords = style.platformOverrides?.[platformId] ?? style.keywords;
  return keywords.join(',');
  // 这个字符串会作为 {{QUERY}} 的值注入
}
```

当 `runMaterialUpdate` 接受 `{ styleDir?, count? }` 参数时：
- 若指定 `styleDir`：找到对应 style，对每个平台调用 `resolveQuery(style, platform.id)` 得到 `{{QUERY}}`
- 若未指定：`{{QUERY}}` 不注入（保留原文字面量 `{{QUERY}}` 在模板中）——这意味着 cron 定时触发时请求体里若有 `{{QUERY}}` 会原样发送。**建议**：cron 触发场景应在请求体中不使用 `{{QUERY}}`，或为每个风格分别配置 cron（后续可迭代）。手动触发时 `/material` 页面会强制要求选风格。
- `{{COUNT}}` = `count` 参数或默认 `50`（固定常量，不与 `maxPages` 挂钩）

### 5.4 测试

- `injectPlaceholders` 单测：URL / params / headers / body(string) / body(JSON 嵌套) / 未匹配原样 / COUNT 不编码
- `parseVideoList` 单测：8 字段全映射 / 缺失字段返回 null / 嵌套路径 `stats.diggCount` / 数组展开
- `resolveQuery` 单测：有 platformOverrides / 无 platformOverrides 回退 / 空关键词
- `migrate-parse-fields` 单测：已知字段名匹配 / 未知字段名留空

## 6. PR2 — 视频下载 + DB 扩列

### 6.1 范围

**DB**：
- `prisma/schema.prisma`：`HotVideoCandidate` 加列（见 §4.1）
- `prisma migrate dev --name hot_video_storage_columns`

**后端**：
- 新建 `apps/ts-api-gateway/src/services/videoStorageService.ts`：
  - `downloadVideo(videoUrl, platformId, videoId): Promise<string>` — 流式下载到 `{root}/{platform}/_pending/{YYYY-MM-DD}/{videoId}.mp4`，返回相对路径
  - `archiveVideo(pendingPath, platformId, styleDir): Promise<string>` — 移动文件到 `{root}/{platform}/{styleDir}/{YYYY-MM-DD}/{videoId}.mp4`，返回新相对路径
  - `deletePending(pendingPath): Promise<void>` — 删除 pending 文件
  - 下载重试：失败重试 2 次，间隔 1s，最终失败抛错
  - 流式拉取：Node `https`/`http` 模块 + `fs.createWriteStream`，避免大视频撑爆内存
- `materialUpdateService.ts`：
  - `dispatchToPython` 之前先调 `downloadVideo`，更新 DB `storagePath` + `storageStatus='pending_downloaded'`
  - 下载失败：`storageStatus='failed'` + `failReason`，仍下发 Python（让 Python 回退用 `video_url`）
  - payload 改为传 `local_path`（绝对路径）而非 `video_url`
- `routes/material-update.ts` webhook handler：
  - `status=accepted` 且有 `style` → `archiveVideo` 移动文件 → 更新 `storagePath` + `storageStatus='archived'` + `acceptedAt` + `rating`（从 webhook payload 的 `result.rating` 提取）
  - `status=rejected` → `deletePending` → `storageStatus='none'` + `storagePath=NULL`
- `routes/material-update.ts` webhook schema 扩展：`result` 中期望 `rating: number`（1-5），handler 提取后写入 DB `rating` 列
- Python Worker `material_tasks.py`：优先读 `local_path`，若不存在则回退用 `video_url`（向后兼容）

**前端**：
- `MaterialTab.tsx` 新增「视频存储设置」面板（在「调度设置」和「处理与评估」之间）：
  - toggle：启用视频下载
  - input：根路径（如 `/data/videos`）
  - 只读：磁盘使用量（`du -sh root` 一次/小时缓存，后端新 endpoint `GET /material-update/disk-usage`）

### 6.2 下载实现细节

```ts
// videoStorageService.ts
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

export async function downloadVideo(
  videoUrl: string,
  rootPath: string,
  platformId: string,
  videoId: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(rootPath, platformId, '_pending', date);
  await fs.promises.mkdir(dir, { recursive: true });
  
  const filePath = path.join(dir, `${videoId}.mp4`);
  const relativePath = path.join(platformId, '_pending', date, `${videoId}.mp4`);

  await downloadWithRetry(videoUrl, filePath, 2);
  return relativePath;
}

async function downloadWithRetry(url: string, dest: string, retries: number): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await streamDownload(url, dest);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function streamDownload(url: string, dest: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (response) => {
      // 处理 301/302/307/308 重定向（视频 CDN 常用）
      if ([301, 302, 307, 308].includes(response.statusCode!) && response.headers.location) {
        response.resume(); // 释放当前响应
        file.close();
        fs.unlinkSync(dest);
        if (maxRedirects <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        streamDownload(response.headers.location, dest, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}
```

### 6.3 已知限制

- 视频源 URL 若需鉴权（CDN 签名、cookie），当前不支持——仅支持公开 URL
- Python Worker 需与 TS 网关挂载同一磁盘卷（Docker volume 配置）
- 磁盘容量监控仅做只读展示，不自动清理

### 6.4 测试

- `videoStorageService` 单测：mock http 响应、流式写入、移动文件、删除文件、重试逻辑
- webhook handler 单测：accepted 移动文件 / rejected 删除文件 / 无 storagePath 的容错
- end-to-end：采集 → 落 pending → webhook accept → 验证文件在 style 目录 + DB 更新

## 7. PR3 — 0/0 状态 StatusPill + 跳转

### 7.1 范围

**后端**：
- `routes/material-update.ts` `/status` 端点返回新增 `runHealth`:
  ```ts
  interface RunHealth {
    ok: boolean;
    warnings: Array<{
      kind: 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch';
      platformId: string;
      platformName: string;
      message: string;
    }>;
  }
  ```
  - `no_keys`：平台 `enabled && keyPool.keys.length === 0`
  - `all_keys_cooldown`：平台所有 key 都在冷却中
  - `parse_mismatch`：`fetched > 0 && newCandidates === 0`（可能解析配置有误）
- `materialUpdateService.ts`：`runState` 增加 `warnings` 字段，采集时记录

**前端**：
- `MaterialTab.tsx`「运行状态」面板：
  - 顶部：若 `runHealth.warnings.length > 0`，显示 `<StatusPill tone="warning" icon="warning">本次运行有 {n} 个告警</StatusPill>`
  - 每个平台行：
    - `no_keys` → `<StatusPill tone="error">未配置 API Key</StatusPill>` + `<button onClick={scrollToPlatform}>前往设置</button>`
    - `all_keys_cooldown` → `<StatusPill tone="warning">所有 Key 冷却中</StatusPill>`
    - `parse_mismatch` → `<StatusPill tone="warning">解析配置可能有误</StatusPill>`
- `PlatformCard.tsx`：
  - 顶部加红点角标（当 `keyPool.keys.length === 0 && enabled`）
  - 暴露 `data-platform-id={platform.id}` 属性供锚点跳转
- `MaterialTab.tsx` 加 `scrollToPlatform(platformId)` 方法：`document.querySelector([data-platform-id="${platformId}"])?.scrollIntoView()`

### 7.2 测试

- 后端：`runHealth` 计算逻辑单测（no_keys / all_keys_cooldown / parse_mismatch / ok）
- 前端：mock API 响应 + 验证 StatusPill 渲染 + 跳转交互

## 8. PR4 — /material 页面重设计

### 8.1 范围

重写 `apps/admin-dashboard/src/app/material/page.tsx`，移除所有 MOCK 数据。

### 8.2 布局

Bento 12 列网格，左 4 / 右 8（沿用现有风格 token）。

**左侧 — 快速采集面板**（4 列）：
```
┌─────────────────────────────┐
│  采集配置                    │
│                             │
│  选择平台                    │
│  [tiktok] [douyin] ...      │
│                             │
│  选择风格                    │
│  [口播 ▼]                   │
│                             │
│  采集数量                    │
│  [────●────] 50             │
│                             │
│  [  启动采集  ]              │
│                             │
│  ── 任务状态 ──              │
│  状态: 运行中  进度: 62%     │
│  [████████░░░░] 124/200     │
└─────────────────────────────┘
```

- 平台选择：从 `useMaterialConfig` 取 `platforms.filter(p => p.enabled)`，单选
- 风格选择：从 `config.processing.styles` 取，select 控件
- 数量滑块：1-200，初始值 = 50（固定默认，不依赖 `maxPages`）
- 触发按钮：调用扩展后的 `useTriggerMaterialRun({ styleDir, count })`
- 任务状态：从 `useMaterialStatus` 取 `running` / `lastRunAt` / `lastResult`，实时展示

**右侧 — 资产库面板**（8 列）：
```
┌──────────────────────────────────────────────────┐
│  素材归档视窗                       共 42 条素材   │
│                                                  │
│  [风格: 全部▼] [平台: 全部▼] [状态: 全部▼]        │
│                                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│  │cover │ │cover │ │cover │ │cover │            │
│  │title │ │title │ │title │ │title │            │
│  │author│ │author│ │author│ │author│            │
│  │S 口播│ │A 场景│ │B 口播│ │S 口播│            │
│  └──────┘ └──────┘ └──────┘ └──────┘            │
└──────────────────────────────────────────────────┘
```

- 顶栏 filter：风格 / 平台 / 状态（pending / processing / accepted / rejected）
- 列表：来自 `useMaterials`（已有 hook），按 `acceptedAt` 或 `fetchedAt` 倒序
- 卡片信息：cover / title / 作者 / 平台 / 风格 / quality（来自 LLM 评级）/ storagePath（点击复制）
- 「重跑 LLM」按钮：单条重新评估（POST 新 endpoint `/material-update/reprocess/{id}`）
- 「打开文件」按钮：若有 `storagePath`，显示路径 tooltip（浏览器无法直接打开本地文件）

### 8.3 后端接口变更

- `POST /material-update/run` 接受可选 body `{ styleDir?: string, count?: number }`
  - 若指定 `styleDir`：`runMaterialUpdate` 对每个平台用 `resolveQuery` 得到 `{{QUERY}}`
  - 若指定 `count`：作为 `{{COUNT}}` 注入
  - 若未指定：`{{QUERY}}` = 空，`{{COUNT}}` = 默认值
- `GET /materials` 扩列返回：`storagePath, storageStatus, likeCount, commentCount, acceptedAt`
- 新增 `POST /material-update/reprocess/:id`：重新下发单条候选到 Python Worker

### 8.4 前端类型变更

`types/material.ts` 扩展：
```ts
export interface MaterialItem {
  id: string;
  platform: string;
  videoId: string;
  title: string | null;
  author: string | null;
  cover: string | null;
  videoUrl: string | null;
  playCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishTime: string | null;
  status: 'pending' | 'processing' | 'accepted' | 'rejected' | 'no_url';
  style: string | null;
  storagePath: string | null;
  storageStatus: 'none' | 'pending_downloaded' | 'archived' | 'failed';
  acceptedAt: string | null;
  fetchedAt: string;
}
```

### 8.5 移除项

- `MOCK_MATERIALS` / `MOCK_TASK_STATUS` 全部删除
- 旧的「选择平台 / 关键词 / 数量 / 点赞阈值 / 收藏阈值 / 分类标签」表单全部删除（这些逻辑迁到 settings）
- `simulateProgress` 假进度模拟删除

### 8.6 测试

- `/material` 端到端：选择风格 → 触发 → 拉新条目 → 过滤 → 重跑
- 空状态：无候选视频时的空状态展示
- 加载状态：skeleton + error boundary

## 9. PR 依赖与顺序

```
PR1（占位符 + 标准解析字段）
  ↓ 依赖
PR2（视频下载 + DB 扩列）
  ↓ 依赖
PR3（0/0 状态 StatusPill）—— 可与 PR2 并行
  ↓ 依赖
PR4（/material 页面重设计）—— 依赖 PR1+PR2+PR3
```

- PR1 必须先做：后续 PR 依赖新的 `fieldMap` 和占位符
- PR2 和 PR3 可并行：PR2 改后端下载管线，PR3 改前端状态展示，无冲突
- PR4 最后做：依赖前三个 PR 的后端接口

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 视频源 URL 需鉴权 | 下载失败 | PR2 文档标注 known limitation；后续可扩展带 cookie 下载 |
| Python Worker 读本地文件需共享卷 | Docker 部署 | docker-compose.yml 配置 volume 挂载 |
| 现有 `parse.fields` 配置迁移 | 用户需重配 | 迁移脚本尝试按字段名匹配；匹配不上的留空 + UI 提示 |
| 大视频撑爆内存 | 网关 OOM | 流式下载（`pipe` 而非 `buffer`） |
| 磁盘满 | 下载失败 | PR2 加磁盘使用量只读展示；后续可加自动清理 |
| body JSON 占位符替换破坏结构 | 采集失败 | `deepReplaceStrings` 仅替换 string 值，不碰 number/boolean/null |
| `{{COUNT}}` 在 JSON 中需是数字 | `resultsPerPage: "50"` 而非 `50` | `injectPlaceholders` 对 COUNT 不加引号；但 JSON.parse 后 string "50" 仍是 string — 需在 `deepReplaceStrings` 中对 COUNT 做特殊处理：若父字段值是纯 `{{COUNT}}`，替换为 number |

### 10.1 COUNT 在 JSON 中的特殊处理

```ts
function deepReplaceStrings(obj: any, vars: Record<string, string>): any {
  if (typeof obj === 'string') {
    // 若整个字符串就是 {{COUNT}}，替换为 number
    if (obj === '{{COUNT}}') {
      return parseInt(vars.COUNT, 10);
    }
    return injectPlaceholders(obj, vars);
  }
  if (Array.isArray(obj)) return obj.map(v => deepReplaceStrings(v, vars));
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) result[k] = deepReplaceStrings(v, vars);
    return result;
  }
  return obj;
}
```

## 11. 验收标准

### PR1 验收
- [ ] 在 PlatformCard 中配置 8 字段映射，测试请求能正确解析出视频列表
- [ ] 在请求体中写 `{"searchQueries":["{{QUERY}}"],"resultsPerPage":{{COUNT}}}`，切换风格后 `{{QUERY}}` 正确替换
- [ ] `{{COUNT}}` 在 JSON 中替换为 number 类型（不是 string）
- [ ] 现有 `parse.fields` 配置迁移脚本运行后，`fieldMap` 正确填充

### PR2 验收
- [ ] 采集后视频文件出现在 `{root}/{platform}/_pending/{date}/{videoId}.mp4`
- [ ] DB 中 `storagePath` 和 `storageStatus='pending_downloaded'` 正确写入
- [ ] Python Worker 收到 `local_path` 并能读取本地文件
- [ ] webhook accepted 后文件移动到 `{root}/{platform}/{styleDir}/{date}/{videoId}.mp4`
- [ ] webhook rejected 后 pending 文件被删除
- [ ] 下载失败时 `storageStatus='failed'` + `failReason` 记录

### PR3 验收
- [ ] 平台 `keys=[]` 且 `enabled=true` 时，运行状态面板显示「未配置 API Key」StatusPill
- [ ] 点击「前往设置」能滚动到对应 PlatformCard
- [ ] PlatformCard 顶部有红点角标
- [ ] `fetched > 0 && newCandidates === 0` 时显示「解析配置可能有误」

### PR4 验收
- [ ] `/material` 页面无任何 MOCK 数据
- [ ] 选择平台 + 风格 + 数量后点击「启动采集」能触发真实采集
- [ ] 资产库面板展示真实 `hot_video_candidates` 数据
- [ ] 风格/平台/状态 filter 正常工作
- [ ] 「重跑 LLM」按钮能重新下发单条候选
