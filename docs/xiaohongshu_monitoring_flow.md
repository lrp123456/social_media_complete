# 小红书视频监控流程文档

## 1. 架构概览

小红书监控系统是多平台社交媒体矩阵管理系统的一部分。小红书仅支持 **"轻量模式"**——与抖音/快手支持"轻量"和"深度"评论抓取模式不同，小红书被显式限制为轻量模式（仅追踪评论数量，不抓取评论内容）。

系统使用 **BullMQ 队列** 配合调度器，定期为每个活跃用户入队监控任务。爬虫通过 CDP 连接指纹浏览器（BitBrowser/RoxyBrowser），导航至小红书创作者中心，拦截 API 响应，并将评论数量与数据库进行对比。

**核心文件：**
- 爬虫：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- 监控服务：`apps/ts-api-gateway/src/services/monitorService.ts`
- 数据库服务：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`
- API 路由：`apps/ts-api-gateway/src/routes/monitor.ts`、`matrix.ts`
- 选择器配置：`apps/ts-api-gateway/data/selectors.json`（第 1823-2350 行）

---

## 2. 爬虫 / 抓取器

**主文件：** `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

`XiaohongshuCrawler` 类负责所有小红书相关的抓取逻辑：

### 2.1 核心方法

| 方法 | 说明 |
|------|------|
| `constructor(maxMonitorVideos)` | 初始化，默认限制每个用户最多追踪 20 篇笔记 |
| `warmUp(page)` | 先导航至 `https://www.xiaohongshu.com`，执行随机滚动和空白点击，模拟人类浏览行为 |
| `navigateToCreatorHome(page)` | 导航至 `https://creator.xiaohongshu.com/creator/home`，优先尝试点击导航，失败后回退到 `page.goto()` |
| `registerListener(page, patterns)` | 注册 `RequestInterceptor`，拦截 `/api/galaxy/v2/creator/note/user/posted` API |
| `fetchNoteListFromSource(page)` | 核心数据获取方法，导航至笔记管理页、等待 API 响应、滚动加载更多 |
| `checkForUpdates(page, userId)` | 主入口，获取笔记列表、对比评论数、识别更新、批量 upsert 视频、截断多余视频 |
| `detectRiskControlAsync(page)` | 检测风控（验证码、登录重置等） |
| `captureRiskScene(page, userId, riskType)` | 保存风控页面截图和 HTML 用于分析 |
| `executeExitStrategy(page)` | 执行反检测退出策略（随机导航、空闲漫游、CDP 刷新） |

### 2.2 关键 API 拦截模式

```
/api/galaxy/v2/creator/note/user/posted
```

### 2.3 数据获取流程 (`fetchNoteListFromSource`)

1. 导航至笔记管理页面（如已在该页面则 F5 刷新）
2. 通过拦截器等待初始 API 响应
3. 滚动加载更多（最多 30 次滚动尝试，连续 10 次无数据则停止）
4. 返回最多 `maxMonitorVideos` 条记录

---

## 3. 监控服务配置

**主文件：** `apps/ts-api-gateway/src/services/monitorService.ts`

### 3.1 `runXiaohongshuCheck` 函数（第 1052-1100 行）

- **强制轻量模式**：如爬取模式设为 `deep`，记录警告并强制切换为 `light`
- **注册拦截器**：注册笔记列表 API 的请求拦截
- **导航**：如不在 `creator.xiaohongshu.com`，则导航至创作者中心
- **Phase 1（唯一阶段）**：调用 `xiaohongshuCrawler.checkForUpdates(page, task.userId)`
- **风控处理**：如检测到风控，记录场景并设置 30 分钟冷却期
- **退出策略**：检查完成后调用 `xiaohongshuCrawler.executeExitStrategy(page)`
- **无 Phase 2/3**：不像抖音/快手/腾讯，小红书不会进入评论管理导航或单独评论抓取

### 3.2 调度器配置（第 1239-1278 行）

调度器使用动态频率控制：

| 模式 | 检查间隔 | 触发条件 |
|------|---------|---------|
| 活跃模式 | 180-300 秒 | 默认模式 |
| 空闲模式 | 900-1200 秒 | 连续 4 次无更新循环后切换 |

### 3.3 BullMQ 队列配置

| 配置项 | 值 |
|--------|-----|
| 队列名称 | `monitor` |
| 并发数 | 3 workers |
| 速率限制 | 10 jobs / 60 seconds |
| 任务超时 | 10 分钟 |
| 重试次数 | 2 次，固定 5 分钟退避 |

---

## 4. 数据库模型

**Schema 文件：** `prisma/schema.prisma`

### 4.1 核心模型

| 模型 | 表名 | 说明 |
|------|------|------|
| `User` | `users` | 存储小红书账号，`platform` 字段为 `"xiaohongshu"`，含 `fingerprintWindowId`、`monitoringEnabled`、`cooldownUntil` 等字段 |
| `Video` | `videos` | 存储笔记，`id` 为小红书笔记 ID，含 `commentCount`、`metrics`（JSON）等字段 |
| `Comment` | `comments` | 轻量模式下创建合成记录，cid 格式 `light_{videoId}_{timestamp}`，文本 `[轻量模式] N 条新评论` |
| `VideoCommentRecord` | `video_comments` | 备选评论存储，`platform` 字段支持 `xiaohongshu` |
| `MonitorStatus` | `monitor_status` | 追踪每个账号的监控状态：`lastCheckTime`、`lastVideoCount`、`lastCommentCount` |
| `CrawlSetting` | `crawl_settings` | 每平台爬取模式（`deep`|`light`），小红书的 `deep` 会被 API 拒绝 |
| `ScheduleRule` | `schedule_rules` | 基于时间的调度规则（工作日、日期、全天） |

### 4.2 数据库服务关键函数

**文件：** `apps/ts-api-gateway/src/services/monitorDatabaseService.ts`

| 函数 | 说明 |
|------|------|
| `getVideosByUserId(userId)` | 获取所有视频用于对比 |
| `upsertVideosBatch(userId, videos)` | 批量 upsert 笔记数据 |
| `truncateVideosByUser(userId, maxVideos)` | 移除多余的旧笔记 |
| `updateCommentCount(videoId, count)` | 更新评论数量 |
| `upsertLightModeComment(videoId, info)` | 创建轻量模式合成评论记录 |
| `logRiskScene(userId, platform, riskType, evidence)` | 记录风控事件 |
| `setUserCooldown(userId, cooldownUntil)` | 设置 30 分钟冷却期 |
| `getCrawlMode(platform)` | 返回爬取模式（小红书始终为 `light`） |
| `getAllActiveUsers()` | 返回 `monitoringEnabled=true` 且有有效浏览器窗口的用户 |

---

## 5. API 路由

### 5.1 监控数据路由

**文件：** `apps/ts-api-gateway/src/routes/monitor.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/monitor/targets` | 列出所有监控平台，含小红书的用户/视频/评论聚合统计 |
| GET | `/api/v1/monitor/videos?platform=&search=&limit=` | 列出监控视频（可按 `platform=xiaohongshu` 过滤） |
| GET | `/api/v1/monitor/videos/:id/comments` | 获取视频的评论树 |
| POST | `/api/v1/monitor/comments/:id/read` | 标记评论已读 |
| POST | `/api/v1/monitor/comments/read-all` | 批量标记所有评论已读 |
| POST | `/api/v1/monitor/videos/:id/read-all` | 标记视频所有评论已读 |

### 5.2 矩阵 / 爬取设置路由

**文件：** `apps/ts-api-gateway/src/routes/matrix.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/matrix/monitor/crawl-settings` | 列出所有平台的爬取设置 |
| PUT | `/api/v1/matrix/monitor/crawl-settings/:platform` | 更新爬取模式，**小红书拒绝 `deep` 模式**，返回错误：`"小红书不支持深度爬取模式，仅支持轻量通知"` |

### 5.3 其他相关路由

- **账号路由** (`routes/accounts.ts`)：`GET /api/v1/accounts/hosted`，小红书特定颜色 `#ff2442`
- **操作员路由** (`routes/operators.ts`)：小红书包含在 `monitorPlatforms` 数组中
- **发布路由** (`routes/publish.ts`)：小红书包含在平台枚举中

---

## 6. 选择器 / DOM 解析

### 6.1 选择器配置

**文件：** `apps/ts-api-gateway/data/selectors.json`（第 1823-2350 行）

| 类别 | 数量 | 示例 |
|------|------|------|
| 菜单选择器 | 12 个 | `nav_to_creator_center`、`menu_note_manage`、`menu_data_dashboard` |
| 按钮选择器 | 13 个 | `btn_upload_video`、`btn_publish_submit`、`btn_video_tab` |
| 区域选择器 | 8 个 | `region_note_list`、`region_note_list_scroll`、`region_upload_zone` |
| 文本框选择器 | 3 个 | `tb_title`、`tb_description`、`tb_topic` |

### 6.2 爬虫键映射

**文件：** `apps/ts-api-gateway/src/crawlers/menuSelectors.ts`（第 101-117 行）

将爬虫风格的点分隔键映射到选择器读取器：

```
nav.to-creator       → nav_to_creator_center
menu.note-manage     → menu_note_manage
menu.data-dashboard  → menu_data_dashboard
region.note-list     → region_note_list
region.note-list-scroll → region_note_list_scroll
```

### 6.3 页面状态管理

**文件：** `packages/browser-core/src/pageStateManager.ts`

小红书 URL 模式：
- `creator.xiaohongshu.com/statistics/data-analysis`
- `creator.xiaohongshu.com/new/note-manager`

### 6.4 请求拦截器

**文件：** `packages/browser-core/src/interceptor.ts`（第 77-111 行）

包含小红书特定的响应解析逻辑，支持多种响应结构的回退路径：
- `body.data.note_list`
- `body.data.data.items`

---

## 7. 调度与定时任务

监控调度器在 `monitorService.ts`（第 1239-1527 行）中实现为进程内定时器系统（非系统 cron）。

### 7.1 核心函数

| 函数 | 说明 |
|------|------|
| `startMonitorScheduler()` | 入口点，以随机初始间隔启动调度器 |
| `runOneSchedule()` | 查询 `ScheduleRule` 记录，评估当前时间是否在允许窗口内，获取所有活跃用户，按浏览器窗口分组，去重后入队 BullMQ |
| `reportMonitorComplete(hadUpdate)` | 每个任务完成后调用，在活跃/空闲模式间切换 |
| `resetSchedulerTimer()` | 允许外部重置（如通过 API）触发立即的下一轮调度 |

### 7.2 调度流程

```
startMonitorScheduler()
  → 等待随机初始间隔
  → runOneSchedule()
    → 查询 ScheduleRule，检查当前时间是否在允许窗口
    → getAllActiveUsers()
    → 按浏览器窗口分组，去重正在运行的任务
    → 入队 BullMQ monitor 队列
  → 任务完成 → reportMonitorComplete(hadUpdate)
    → 有更新 → 切换到活跃模式（180-300s）
    → 无更新 → 连续 4 次后切换到空闲模式（900-1200s）
  → 重置定时器，等待下一轮
```

---

## 8. 发布功能（相关）

**文件：** `apps/ts-api-gateway/src/platforms/xiaohongshu.ts`

`XiaohongshuPublisher` 类继承 `BasePublisher`，处理：

| 功能 | 说明 |
|------|------|
| 登录 | 通过 `creator.xiaohongshu.com` 扫码登录 |
| 导航 | 笔记管理 → 发布笔记 → 上传视频 |
| 上传 | 使用 CDP 安全文件注入（`cdpSetInputFiles`） |
| 元数据 | 填写标题（20 字限制）、描述（富文本编辑器）、话题（`#topic` 格式） |
| 提交 | 继承 `BasePublisher.submitPublish`，使用 selectors.json 中的流程规则 |

---

## 9. Dashboard / UI 组件

| 文件 | 小红书相关内容 |
|------|--------------|
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 模拟数据含 XHS 账号、监控目标；平台特定样式 `#ff2442` |
| `apps/admin-dashboard/src/components/matrix/OperatorManagement.tsx` | XHS 列为 `{ key: 'xiaohongshu', label: '小红书' }` |
| `apps/admin-dashboard/src/app/material/page.tsx` | XHS 包含在素材浏览平台中 |
| `apps/admin-dashboard/src/app/settings/page.tsx` | 平台下拉选项包含 `小红书 (xiaohongshu)` |
| `apps/admin-dashboard/src/components/ui/MaterialIcon.tsx` | XHS 颜色 `#ff2442`，图标 `book` |
| `apps/admin-dashboard/src/components/ui/StatusPill.tsx` | XHS 颜色 `#ff2442` |
| `apps/admin-dashboard/src/hooks/useApi.ts` | XHS 包含在 Platform 联合类型中 |

---

## 10. 关键设计决策与约束

### 10.1 仅支持轻量模式

小红书创作者中心没有专门的评论管理页面（不像抖音/快手）。评论内容无法获取，除非导航到主站的单篇笔记页面（`www.xiaohongshu.com/explore/{note_id}`），而该页面需要单独的 `xsec_token` 认证。因此系统仅通过笔记列表 API 追踪评论数量。

### 10.2 基于 Cookie 的认证

小红书 API 需要浏览器 Cookie（`a1`、`webId`、`websectiga`）。纯 HTTP 客户端调用会失败，系统必须使用指纹浏览器自动化。

### 10.3 风控机制

小红书有激进的反机器人检测。爬虫在每个检查周期前后检查验证码页面、登录重置和风险关键词，检测到风控后设置 30 分钟冷却期。

### 10.4 反检测措施

- 模拟人类行为（随机滚动、阅读停顿、空白点击）
- 使用 CDP 操作（避免操作系统级检测）
- 退出策略（完成后导航到随机菜单项）

---

## 11. 相关文档

| 文件 | 说明 |
|------|------|
| `json/xiaohongshu_creator_automation_report.md` | 创作者中心研究报告：菜单结构、10+ API 端点、认证机制、数据字段映射 |
| `docs/comment_crawler_plan.md` | 多平台评论抓取计划，含小红书特定部分 |
| `design.md` | 系统设计文档，含 SQL schema、抓取流程图、平台对比表 |
