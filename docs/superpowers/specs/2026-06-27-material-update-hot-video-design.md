# 素材更新后端重构设计 · 每周热门视频采集

- **日期**: 2026-06-27
- **状态**: 设计待审
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
| 执行架构 | 方案 A：TS 网关编排 + Python Worker 执行（复用现有 FFmpeg/LLM 管线） |

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
│  5. 下发 BullMQ 任务 → Python Worker                          │
└─────────────────────────────────────────────────────────────┘
        │ BullMQ 任务 { candidateId, videoUrl, platform, frameIntervalMs, evaluatePrompt, styles, minRating }
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Python Worker material_tasks.py (改造)                        │
│  下载原始视频直链 → 按间隔抽帧 → LLM 评估(可配提示词+风格)       │
│  → 达标且命中风格 → 落盘 data/materials/{style}/{platform}/... │
│  → 回调 TS（带 candidateId + style）                          │
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
        "body": null
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
  }
}
```

**说明**：
- `{{API_KEY}}` / `{{PAGE}}` 占位符可在 `headers`/`params`/`url` 任意位置，运行时轮询注入。
- `listPath` 与 `fields` 值用点路径取值（`data.videos`、`stats.play`），不引入 JSONPath。
- `keyCooldownState` 为运行态，由 service 自动写入；前端只读展示冷却倒计时。
- `styles[].dir` 决定落盘子目录名；`keywords` 辅助 LLM 判定（提示词中提示候选风格）。

## 5. 后端设计（TS 网关）

### 5.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/services/materialUpdateConfig.ts` | 封装 `getSection('materialUpdate', DEFAULTS)` / `saveSection`；类型定义（`Platform`/`KeyPool`/`Parse`/`Processing`/`Schedule`）；提供默认值 |
| `src/services/materialKeyPool.ts` | 多 key 轮询 + 失败冷却切换：401/429/额度错误 → 写 `keyCooldownState` 冷却 → 切下一个 key；全冷却则该平台本批次失败 |
| `src/services/materialParser.ts` | 列表路径 + 字段映射解析（点路径取值），输出标准化 `Video` 对象 |
| `src/services/materialUpdateService.ts` | 核心编排：读配置 → 并发 curl 各 enabled 平台 → 解析 → 去重 upsert → 下发 BullMQ 任务 |
| `src/services/materialUpdateScheduler.ts` | cron 调度器：配置变更时 `reload()`（参考现有 `restartMonitorScheduler` 模式）；启动时注册 |
| `src/routes/config-material.ts` | `GET/PUT /api/v1/config-material`；`POST /api/v1/config-material/test`（测试单平台 curl+解析回显） |
| `src/routes/material-update.ts` | `POST /api/v1/material-update/run`（手动触发）；`GET .../status`（运行态/key 冷却）；`GET .../candidates`（候选预览） |

在 `src/index.ts` 注册新路由并启动调度器。

### 5.2 新增 PG 表

```prisma
model HotVideoCandidate {
  id           String   @id @default(cuid())
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
  status       String   @default("pending") // pending|processing|accepted|rejected
  style        String?

  @@unique([platformId, videoId])
  @@index([fetchedAt])
  @@index([status])
}
```

去重靠 `upsert` + `@@unique([platformId, videoId])`，已存在则跳过（不计入新候选，不下发处理）。

### 5.3 运行时序（每次执行）

1. `getSection('materialUpdate')` 读最新配置。
2. 遍历 `enabled` 平台，并发 curl：每平台用 `materialKeyPool` 选可用 key，注入占位符到 `headers`/`params`/`url`。
3. `materialParser` 按该平台 `parse` 提取标准化视频列表。
4. `upsert` 到 `HotVideoCandidate`（去重）；仅对**新**候选继续。
5. 新候选组装 BullMQ 任务 `{ candidateId, videoUrl, platform, frameIntervalMs, evaluatePrompt, styles, minRating }` 下发 Python。
6. key 失败 → 写 `keyCooldownState`、切下一个 key；全冷却 → 该平台本批次失败并记录到运行态。
7. Python 完成回调 → 更新 `HotVideoCandidate.status`（`accepted`/`rejected`）与 `style`。

### 5.4 API 清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/config-material` | 读取 `materialUpdate` 配置 |
| PUT | `/api/v1/config-material` | 保存配置，触发调度器 reload |
| POST | `/api/v1/config-material/test` | 用指定平台配置实际发一次 curl 并回显解析结果 |
| POST | `/api/v1/material-update/run` | 手动触发一次全量采集（复用 cron 路径） |
| GET | `/api/v1/material-update/status` | 运行态：各平台 key 冷却、最近批次 |
| GET | `/api/v1/material-update/candidates` | 候选视频分页预览 |

## 6. Python Worker 改造（`material_tasks.py`）

现有管线：入参 `oss_urls`（OSS 下载）→ 场景切分 → 每段抽 1 帧 → 硬编码 prompt 评级 → 落盘。改造点：

- **入参扩展**：支持 `videoUrl`（原始直链，先下载到 temp）、`frameIntervalMs`、`evaluatePrompt`、`styles`、`minRating`、`candidateId`。保留 `oss_urls` 兼容旧入口。
- **抽帧改为按间隔**：用 FFmpeg `fps` filter 按 `frameIntervalMs` 等间隔抽帧，替换现有「每段 1 帧」。
- **评估提示词可配**：`_rate_image` 的 prompt 从入参 `evaluatePrompt` 读取，不再硬编码；LLM 返回需含「是否达标 + 命中风格」。
- **风格判定**：与配置 `styles`（name/dir/keywords）匹配；未命中或 `rating < minRating` → 标记 `rejected`，不落盘。
- **落盘路径**：保持 `data/materials/{style}/{platform}/...`，`style` 取自配置 `styles[].dir`。
- **回调**：完成回调带 `candidateId` 与 `style`/`status`，TS 侧更新 `HotVideoCandidate`。

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
- **Python**：`material_tasks.py` 入参扩展（`videoUrl` 下载、按 `frameIntervalMs` 抽帧、可配 prompt、风格命中落盘 / 未命中 rejected）；可用本地小视频 fixture。
- **端到端**（手动）：配置一个真实平台 → test 回显 → run → 候选入库 → Python 处理 → 落盘到 `data/materials/{style}/{platform}/`。

## 9. 范围与拆分

本设计聚焦单一可实现单元：素材更新热门视频采集链路（配置 UI + TS 编排 + Python 改造）。无需进一步拆分。实现计划由后续 writing-plans 步骤产出。

## 10. 风险与备注

- **RapidAPI key 暴露**：key 写入 `settings-overrides.json`（明文），与现有 `rapidapi_keys` 存储方式一致；前端展示用掩码。如需更高安全可后续迁移到加密存储，本期不做。
- **cron 重载并发**：`reload()` 需先清除旧定时器再注册新定时器，避免重复触发（参照 `restartMonitorScheduler`）。
- **Python 任务契约**：扩展入参需保持向后兼容 `oss_urls` 旧入口，避免破坏现有调用方。
- **平台 curl 差异**：不同 RapidAPI 接口返回结构差异大，靠 `parse` 配置覆盖；测试请求端点用于配置时即时验证。
