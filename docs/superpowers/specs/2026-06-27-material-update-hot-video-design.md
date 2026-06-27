# 素材更新后端重构设计 · 每周热门视频采集

- **日期**: 2026-06-27
- **状态**: 设计已修订（基于 oracle 架构审核）
- **作者**: brainstorming session
- **关联**: 重构原「达人监控」素材更新链路；与现有浏览器版达人监控并行

## 1. 背景与目标

### 1.1 现状

- 「素材更新」(`/material`) 前后端均为 Mock：`apps/ts-api-gateway/src/routes/materials.ts` 返回硬编码数据，`materialService.ts` 仅做素材选择策略。
- 「达人监控」(`/api/v1/monitor`) 是真实实现：`monitorService.ts` + 各 `crawlers/*Crawler.ts` 通过指纹浏览器 + Playwright 拦截创作者中心 XHR，监控预存用户 id 的视频评论变化。调度为应用内 `setTimeout` + BullMQ 队列。
- `config-network.ts` 已定义 `rapidapi_keys` / `hosts` 字段，前端 `GeneralTab.tsx` 已有编辑 UI，但**全代码库无任何后端代码消费这些 key 发 curl**——属于预留未实现。
- Python Worker `app/workers/material_tasks.py` 已有真实 FFmpeg 场景切分 + 抽帧 + LLM 评级 + 分类落盘管线，靠 webhook 触发，入参为 `oss_urls`，提示词与风格列表硬编码。
- 配置存储分散：PG 表（`CrawlSetting`/`ScheduleRule`/`PlatformConfig`）与 JSON 文件（`data/settings-overrides.json`/`selectors.json`）混用。统一设置持久化由 `apps/ts-api-gateway/src/lib/settingsStore.ts` 提供（`getSection(section, defaults)` / `saveSection(section, data)`，写 `data/settings-overrides.json`，热读缓存）。

### 1.2 目标

将素材更新从「达人监控（浏览器拦截）」重构为「每周热门视频采集（curl/RapidAPI）」的**全新并行数据源**，浏览器版达人监控保留不动。新链路：

```
配置(系统设置·素材更新 tab)
  → cron/手动触发
  → 多 key 轮询 curl 各平台热门视频 API
  → 解析(列表路径+字段映射) → 去重入候选库
  → 下发 Python Worker：按间隔抽帧 → LLM 评估(可配提示词+风格) → 达标命中风格 → 按风格落盘素材库
```

### 1.3 非目标 (YAGNI)

- 不替换/改造现有浏览器版达人监控（`monitorService.ts` 及 `crawlers/*Crawler.ts` 保持原样）。
- 不引入 JSONPath 依赖，解析仅用点路径。
- 不做自动全量进入处理管线的人工筛选 UI 之外的高级规则引擎（候选预览仅展示，筛选靠评估阈值与风格命中）。
- 不做配置历史版本/审计（JSON 文件覆盖写，与现有 `settingsStore` 一致）。

## 2. 关键决策（来自澄清）

| 决策点 | 选择 |
|---|---|
| 与达人监控关系 | 全新并行数据源，互不影响 |
| curl 配置粒度 | 结构化字段拆分（method/url/headers/params/body） |
| 响应体解析 | 列表路径 + 字段映射（点路径） |
| 多 key 策略 | 轮询 + 失败自动冷却切换（401/429/额度错误冷却） |
| 数据落地消费 | 抓取去重入候选库 → 抽帧 → LLM 评估 → 达标命中风格入素材库 |
| 风格分类 | 预定义风格列表 + LLM 判定 |
| 调度 | cron 表达式可配（多个）+ 手动触发 |
| 平台范围 | 国内主流 + 海外主流 + 平台条目可自由增删 |
| 配置存储 | JSON 文件（复用 `settingsStore`，新 section `materialUpdate`） |
| 执行架构 | TS 网关编排 + Python Worker 执行（HTTP POST 到 Python ARQ 队列，复用现有 FFmpeg/LLM 管线；Python 完成后 webhook 回调 TS） |

## 3. 整体架构与数据流

```
[系统设置·素材更新 tab]  ──写──▶  data/settings-overrides.json [section: materialUpdate]
        │                                          ▲ 热读
        ▼ 读取最新配置                              │
┌─────────────────────────────────────────────────────────────┐
│ TS 网关 materialUpdateService                                │
│  1. cron 触发 / 手动触发                                      │
│  2. 多 key 轮询 + 失败冷却 → curl 各平台热门视频 API           │
│  3. 解析(列表路径+字段映射) → 标准化视频对象                    │
│  4. 去重(平台+videoId) → 写入 HotVideoCandidate (PG)          │
│  5. 下发 HTTP POST → Python Worker（ARQ 队列）                 │
└─────────────────────────────────────────────────────────────┘
        │ POST /api/v1/tasks/material-update { candidateId, videoUrl, platform, frameIntervalMs, evaluatePrompt, styles, minRating }
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Python Worker material_tasks.py (改造)                        │
│  下载原始视频直链 → 按间隔抽帧 → LLM 评估(可配提示词+风格)       │
│  → 达标且命中风格 → 落盘 data/materials/{style}/{platform}/... │
│  → webhook 回调 TS（带 candidateId + style + status）         │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**：所有运行代码执行前先调 `getSection('materialUpdate', DEFAULTS)` 读取最新配置；配置 `PUT` 保存后立即生效（cron 重载、下次抓取用新 key/解析）。

## 4. 配置数据结构

写入 `data/settings-overrides.json` 的 `materialUpdate` 段：

```jsonc
{
  "platforms": [
    {
      "id": "douyin_hot",
      "name": "抖音热门",
      "enabled": true,
      "request": {
        "method": "GET",
        "url": "https://tiktok-video.p.rapidapi.com/...?term={{PAGE}}",
        "headers": { "x-rapidapi-key": "{{API_KEY}}", "x-rapidapi-host": "..." },
        "params": { "period": "week", "count": 50 },
        "body": null,
        "maxPages": 3,
        "timeoutMs": 30000
      },
      "keyPool": {
        "placeholder": "API_KEY",
        "keys": ["fbe8a12e...", "a91c..."],
        "cooldownMs": 300000
      },
      "parse": {
        "listPath": "data.videos",
        "fields": {
          "videoId": "video_id",
          "title": "desc",
          "author": "author.nickname",
          "playCount": "stats.play",
          "cover": "cover.url",
          "videoUrl": "video_url",
          "publishTime": "create_time"
        }
      }
    }
  ],
  "schedule": {
    "cron": ["7 3 * * 1"],
    "enabled": true
  },
  "processing": {
    "frameIntervalMs": 1000,
    "evaluatePrompt": "分析这张图片...",
    "styles": [
      { "name": "口播", "dir": "口播", "keywords": ["口播", "讲解"] },
      { "name": "场景", "dir": "场景", "keywords": ["户外", "街景"] }
    ],
    "minRating": 4
  },
  "keyCooldownState": {
    "douyin_hot": { "fbe8a12e...": 1719480000000 }
  },
  "allCooldownRetryAfterMs": 1800000
}
```

**说明**：
- `{{API_KEY}}` / `{{PAGE}}` 占位符可在 `headers`/`params`/`url` 任意位置，运行时轮询注入（字符串替换，key 中含 URL 特殊字符时自动 URL 编码）。
- `listPath` 与 `fields` 值用点路径取值（`data.videos`、`stats.play`），不引入 JSONPath；点路径可解析到数组，若响应为嵌套数组（如 `data.videos.items`）需在 listPath 中完整指定。
- `maxPages` 控制分页采集上限，`{{PAGE}}` 从 1 递增到 `maxPages`；未配置时默认 1（仅采集首页）。
- `timeoutMs` 为 HTTP 请求超时（connect + read），默认 30000ms。
- `keyCooldownState` 为运行态，由 service 自动写入；前端只读展示冷却倒计时。
- `allCooldownRetryAfterMs` 为全平台 key 冷却后的自动重试延迟（默认 1800000ms = 30 分钟），避免等到下次 cron。
- `styles[].dir` 决定落盘子目录名；`keywords` 辅助 LLM 判定（提示词中提示候选风格）。

## 5. 后端设计（TS 网关）

### 5.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/services/materialUpdateConfig.ts` | 封装 `getSection('materialUpdate', DEFAULTS)` / `saveSection`；类型定义（`Platform`/`KeyPool`/`Parse`/`Processing`/`Schedule`）；提供默认值 |
| `src/services/materialKeyPool.ts` | 多 key 轮询 + 失败冷却切换：401/429/额度错误 → 写 `keyCooldownState` 冷却 → 切下一个 key；全冷却则该平台本批次失败 |
| `src/services/materialParser.ts` | 列表路径 + 字段映射解析（点路径取值），输出标准化 `Video` 对象 |
| `src/services/materialUpdateService.ts` | 核心编排：读配置 → 并发 curl 各 enabled 平台 → 解析 → 去重 upsert → 下发 HTTP POST 到 Python Worker（ARQ 队列） |
| `src/services/materialUpdateScheduler.ts` | cron 调度器：配置变更时 `reload()`（参考现有 `restartMonitorScheduler` 模式）；启动时注册 |
| `src/routes/config-material.ts` | `GET/PUT /api/v1/config-material`；`POST /api/v1/config-material/test`（测试单平台 curl+解析回显） |
| `src/routes/material-update.ts` | `POST /api/v1/material-update/run`（手动触发）；`GET .../status`（运行态/key 冷却）；`GET .../candidates`（候选预览）；`POST .../webhook`（Python 完成回调：更新 candidate status/style） |

在 `src/index.ts` 注册新路由并启动调度器。

### 5.2 新增 PG 表

```prisma
model HotVideoCandidate {
  id           String   @id @default(uuid())   // 与项目现有 schema 保持一致
  platformId   String
  videoId      String
  title        String?
  author       String?
  playCount    Int?
  cover        String?
  videoUrl     String?
  publishTime  DateTime?
  rawJson      Json?
  fetchedAt    DateTime @default(now())
  status       String   @default("pending") // pending|processing|no_url|accepted|rejected
  style        String?

  @@unique([platformId, videoId])
  @@index([fetchedAt])
  @@index([status])
}
```

去重靠 `upsert` + `@@unique([platformId, videoId])`。**已存在且 `status !== 'rejected'` 的候选跳过**（不计入新候选，不下发处理）；`status === 'rejected'` 的候选允许重新处理（更新 `status` 为 `pending` 并重新下发）。

### 5.3 运行时序（每次执行）

0. **并发互斥**：检查 `running` 标志（进程内锁），若已在运行则跳过（cron）或返回 409（手动触发）。参照 `monitorService.ts` 的 `schedulerStates` 模式。
1. `getSection('materialUpdate')` 读最新配置（**每次执行时读取，不在模块顶层缓存**）。
2. 遍历 `enabled` 平台，并发 curl：每平台用 `materialKeyPool` 选可用 key，注入占位符到 `headers`/`params`/`url`；按 `maxPages` 分页循环（`{{PAGE}}` 从 1 递增），每页请求带 `timeoutMs` 超时。
3. **响应体错误检测**：不仅检查 HTTP 状态码（401/429），还需检测 200 响应体中的额度/限流错误（正则匹配 `rate limit`、`quota exceeded`、`credits` 等关键词，或 JSON path 检测 `message`/`error` 字段）。命中时触发 key 冷却，与 401/429 同等处理。
4. `materialParser` 按该平台 `parse` 提取标准化视频列表；`videoUrl` 为空的候选标记为 `no_url` 不下发处理。
5. `upsert` 到 `HotVideoCandidate`（去重）；**仅 `status === 'rejected'` 的候选允许重新处理**（重新下发 Python），其余已存在候选跳过。
6. 新候选组装任务 `{ candidateId, videoUrl, platform, frameIntervalMs, evaluatePrompt, styles, minRating }` 通过 HTTP POST 到 Python Worker `POST /api/v1/tasks/material-update`（ARQ 队列）。
7. key 失败 → 写 `keyCooldownState`、切下一个 key；全冷却 → 该平台本批次失败，记录到运行态，**调度 `allCooldownRetryAfterMs` 后自动重试一次**（而非等到下次 cron）。
8. Python 完成后 webhook 回调 `POST /api/v1/material-update/webhook` → 更新 `HotVideoCandidate.status`（`accepted`/`rejected`）与 `style`。

### 5.4 API 清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/config-material` | 读取 `materialUpdate` 配置 |
| PUT | `/api/v1/config-material` | 保存配置，触发调度器 reload |
| POST | `/api/v1/config-material/test` | 用指定平台配置实际发一次 curl 并回显解析结果 |
| POST | `/api/v1/material-update/run` | 手动触发一次全量采集（复用 cron 路径） |
| GET | `/api/v1/material-update/status` | 运行态：各平台 key 冷却、最近批次 |
| GET | `/api/v1/material-update/candidates` | 候选视频分页预览 |
| POST | `/api/v1/material-update/webhook` | Python Worker 完成回调（更新 candidate status/style） |

## 6. Python Worker 改造（`material_tasks.py`）

现有管线：入参 `oss_urls`（OSS 下载）→ 场景切分 → 每段抽 1 帧 → 硬编码 prompt 评级 → 落盘。改造点：

- **入参扩展**：`MaterialUpdateRequest` Pydantic 模型新增可选字段：`video_url: str | None`（原始直链）、`frame_interval_ms: int = 1000`、`evaluate_prompt: str | None`、`styles: list[dict] | None`、`min_rating: int = 4`、`candidate_id: str | None`。保留 `oss_urls` 兼容旧入口。
- **新增 HTTP 直链下载函数**：现有 `download_from_oss`（`apps/python-worker/app/services/ffmpeg.py:14-30`）仅支持阿里云 OSS（`oss2` SDK）。新增 `download_from_url(url: str, temp_dir: str) -> str` 使用 `httpx` 流式下载 HTTP 直链到本地 temp 文件，返回本地路径。
- **入参分发**：`process_material_update` 内做参数分发——`if video_url` → 新路径（HTTP 下载），`elif oss_urls` → 旧路径（OSS 下载），保持向后兼容。
- **抽帧改为按间隔**：用 FFmpeg `fps` filter 按 `frameIntervalMs` 等间隔抽帧，替换现有「每段 1 帧」；FFmpeg 子进程调用加 `asyncio.wait_for` 超时保护。
- **评估提示词可配**：`_rate_image` 的 prompt 从入参 `evaluatePrompt` 读取，不再硬编码；LLM 返回需含「是否达标 + 命中风格」。解析增加 `json.loads` 的 try/except + fallback 策略（解析失败时 reject）。
- **风格判定**：与配置 `styles`（name/dir/keywords）匹配；未命中或 `rating < minRating` → 标记 `rejected`，不落盘。
- **落盘路径**：保持 `data/materials/{style}/{platform}/...`，`style` 取自配置 `styles[].dir`。
- **回调**：完成后通过 webhook POST 到 TS 侧 `POST /api/v1/material-update/webhook`，带 `candidateId` 与 `style`/`status`。

## 7. 前端设计：「素材更新设置」Tab

### 7.1 导航接入

在 `apps/admin-dashboard/src/app/settings/page.tsx` 的 `TabKey` 增加 `'material'`，tab 栏新增第 5 个按钮（图标 `video_library`、label「素材更新」），沿用现有 `TabButton` 组件与 CSS display 切换模式（保持表单状态不丢）。新增 `tabs/MaterialTab.tsx`。

### 7.2 视觉系统

**严格沿用现有 Material Design 3**，与 `GeneralTab`/`MatrixTab` 同源，不另起炉灶：
- 复用 `HeaderStrip`/`AccentBar`（Bento）、`StatusPill`、`MaterialIcon`、`PanelSkeleton`/`QueryError`。
- 色板：`surface-container`/`outline-variant`/`primary`/`on-surface-variant`。

差异化「记忆点」（在 MD3 约束内）：
- 顶部 `HeaderStrip`：渐变 accent bar + 大号 headline「素材更新 · 每周热门采集」+ 右侧实时状态胶囊（下次执行倒计时 / 上次结果）。
- 平台条目为纵向卡片列表，每张卡片左侧一条彩色平台色带（抖音黑/小红书红/快手橙/B站粉/TikTok 青等）。
- key 池用标签式 chip 流：每个 key 是可掩码 chip（`fbe8…c483`），冷却中的 key 显示暗色 + 倒计时角标——直观体现「负载均衡池」语义。
- 配置变更后顶部出现「已保存 · 下次抓取生效」`StatusPill` 反馈。

### 7.3 Tab 内分区（5 个面板，纵向滚动）

1. **平台采集源管理**（`PlatformCardsPanel`）——核心
   - 顶部「+ 新增平台」按钮（自由增删）
   - 每平台卡片：[色带] 平台名 + enabled 开关 + 删除
     - 请求配置：method/url/headers(KV)/params(KV)/body
     - Key 池：占位符 + chip 流 + 冷却倒计时
     - 解析配置：listPath + 字段映射(KV)
     - 操作：[测试请求]（实时拉一条，回显解析结果）
2. **调度设置**（`SchedulePanel`）：enabled 开关 + 多 cron 输入（每行一个 + 增删）+ 下次执行预览
3. **处理与评估**（`ProcessingPanel`）：抽帧间隔（ms）+ 评估提示词（textarea）+ 风格列表（增删：name/dir/keywords）+ 达标评级阈值（1–5）
4. **运行状态**（`RunStatusPanel`）：各平台 key 冷却状态、最近抓取批次、候选库计数 + [立即执行] 按钮
5. **候选视频预览**（`CandidatePreviewPanel`，可选）：最近抓取去重后的候选视频网格（封面+标题+平台）

### 7.4 复用与新增组件

- **复用**：`KeyValueEditor`（headers/params/字段映射 KV 编辑）、`PanelSkeleton`/`QueryError`、`HeaderStrip`/`AccentBar`/`StatusPill`/`MaterialIcon`。
- **新增**（`settings/shared/` 或 `settings/components/`）：
  - `PlatformCard.tsx`（单平台卡片：色带、分区、enabled）
  - `KeyPoolEditor.tsx`（key chip 流 + 掩码 + 冷却角标 + 占位符输入）
  - `CronListEditor.tsx`（多 cron 增删 + 下次执行预览）
  - `StyleListEditor.tsx`（风格条目增删）
  - `MaterialTab` 顶层组合 + React Query hooks（`useMaterialConfig`/`useUpdateMaterialConfig`/`useTestPlatform`/`useTriggerRun`）

### 7.5 数据流

所有面板读写同一 `GET/PUT /api/v1/config-material`。「测试请求」走 `POST /api/v1/config-material/test`。「立即执行」走 `POST /api/v1/material-update/run`。「运行状态」「候选预览」分别走 `GET .../status`、`GET .../candidates`。

## 8. 测试策略

- **TS 单元**：`materialParser`（点路径取值、缺失字段、listPath 为数组/对象）、`materialKeyPool`（轮询选 key、冷却写入、全冷却失败、冷却过期恢复）。
- **TS 集成**：`config-material` 路由 GET/PUT 往返；`test` 端点 mock fetch 回显解析；`run` 触发后候选 upsert 去重（同 videoId 不重复下发）。
- **Python**：`material_tasks.py` 入参扩展（`videoUrl` 下载、按 `frameIntervalMs` 抽帧、可配 prompt、风格命中落盘 / 未命中 rejected）；`download_from_url` HTTP 直链下载函数；可用本地小视频 fixture。
- **端到端**（手动）：配置一个真实平台 → test 回显 → run → 候选入库 → Python 处理 → 落盘到 `data/materials/{style}/{platform}/`。

## 9. 范围与拆分

本设计聚焦单一可实现单元：素材更新热门视频采集链路（配置 UI + TS 编排 + Python 改造）。无需进一步拆分。实现计划由后续 writing-plans 步骤产出。

## 10. 风险与备注

- **RapidAPI key 暴露**：key 写入 `settings-overrides.json`（明文），与现有 `rapidapi_keys` 存储方式一致；前端展示用掩码。如需更高安全可后续迁移到加密存储，本期不做。
- **cron 重载并发**：`reload()` 需先清除旧定时器再注册新定时器，避免重复触发（参照 `restartMonitorScheduler`）。
- **执行并发安全**：cron 触发和手动触发可能并发执行。TS 侧需进程内互斥锁（`running` 标志），参照 `monitorService.ts` 的 `schedulerStates` 模式。
- **Python 任务契约**：扩展入参需保持向后兼容 `oss_urls` 旧入口，避免破坏现有调用方。新增 `download_from_url` 函数（`httpx` 流式下载），与现有 `download_from_oss` 并存。
- **平台 curl 差异**：不同 RapidAPI 接口返回结构差异大，靠 `parse` 配置覆盖；测试请求端点用于配置时即时验证。
- **RapidAPI 响应体错误**：RapidAPI 常返回 200 + 错误消息（如 `{"message": "rate limit exceeded"}`）。`materialKeyPool` 需检测响应体中的限流/额度错误关键词，否则 key 永远不会被冷却。
- **全冷却自动重试**：所有 key 冷却后，调度 `allCooldownRetryAfterMs`（默认 30 分钟）后自动重试一次，避免等到下次 cron（每周一次）导致整批失败丢失一周数据。
- **settingsStore 缓存**：`settingsStore.ts` 使用模块级 `_cache`。`materialUpdateService.ts` 必须在每次执行时主动调用 `getSection`，不能在模块顶层缓存配置。
- **数据保留策略**：`HotVideoCandidate` 表会随时间增长。后续需增加自动清理（如超过 90 天的 `rejected` 候选定期删除）。
