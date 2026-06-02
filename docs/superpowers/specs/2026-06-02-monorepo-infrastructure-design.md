# 阶段 1：基础设施重定义 - 设计文档

> **日期**: 2026-06-02
> **作者**: AI Orchestrator
> **版本**: 1.0.0

---

## 一、目标

建立 Monorepo 基础骨架，定义全栈技术边界，搭建 PostgreSQL/Redis 持久化层，引入全链路 Trace ID 日志规范。

---

## 二、产出物清单

| # | 文件 | 状态 |
|---|------|------|
| 1 | Monorepo 根目录结构 | ✅ 已创建 |
| 2 | `project_rules.md` | ✅ 已编写 |
| 3 | `prisma/schema.prisma` (16 张表) | ✅ 已创建 |
| 4 | `docker-compose.yml` (6 服务) | ✅ 已编写 |
| 5 | `apps/ts-api-gateway/src/middleware/trace.ts` | ✅ 已创建 |
| 6 | `apps/python-worker/app/middleware/trace.py` | ✅ 已创建 |
| 7 | `package.json` (pnpm workspaces) | ✅ 已创建 |
| 8 | `services/litellm/config.yaml` | ✅ 已创建 |
| 9 | `.env.example` / `.env` / `.gitignore` | ✅ 已创建 |

---

## 三、目录拓扑

```
/home/lrp/social_media_complete/
├── apps/
│   ├── ts-api-gateway/          # Express + BullMQ + Patchright
│   │   └── src/middleware/trace.ts
│   ├── python-worker/           # FastAPI + ARQ
│   │   └── app/middleware/trace.py
│   └── admin-dashboard/         # Next.js 14 (待构建)
├── packages/
│   ├── shared-config/           # (待构建)
│   ├── selectors/               # (待构建)
│   └── browser-core/            # (待构建)
├── services/
│   └── litellm/config.yaml
├── prisma/schema.prisma         # 16 张 PostgreSQL 表
├── docker-compose.yml           # 6 服务编排
├── project_rules.md             # 架构宪法
├── package.json                 # Monorepo 根
├── .env / .env.example
└── .gitignore
```

---

## 四、数据库表设计（16 张表）

### TS 核心表（10 张）

| 表名 | 用途 | 关键约束 |
|------|------|---------|
| `users` | 窗口→平台用户映射 | UNIQUE(fingerprint_window_id, platform) |
| `videos` | 视频元数据 | FK → users(id), INDEX(user_id, create_time) |
| `comments` | 评论数据 | UNIQUE(cid), FK → videos(id) |
| `schedule_rules` | 排期规则 | weekday/date/daily/all_day |
| `operation_logs` | 审计日志 | level: info/warn/error |
| `system_status` | 运行时状态 | 单行表 (id=1) |
| `crawl_settings` | 爬取模式配置 | UNIQUE(platform) |
| `platform_configs` | 平台配置(含版本) | UNIQUE(platform, config_key) |
| `platform_config_audit` | 配置变更审计 | - |
| `page_state_cache` | 页面刷新指纹 | UNIQUE(platform) |

### Python 端表（5 张）

| 表名 | 用途 | 关键约束 |
|------|------|---------|
| `task_records` | 任务记录 | UNIQUE(task_id) |
| `bloggers` | 博主信息 | INDEX(platform) |
| `bgm` | BGM 元数据 | UNIQUE(filename) |
| `video_comments` | 评论记录 | - |
| `monitor_status` | 监控状态 | - |
| `video_comment_counts` | 评论计数 | UNIQUE(platform, video_id) |

### 新增表（1 张）

| 表名 | 用途 | 关键约束 |
|------|------|---------|
| `custom_selectors` | 动态选择器注册表 | UNIQUE(platform, selector_key) |

---

## 五、Docker 服务编排

| 服务 | 镜像 | 端口 | 依赖 |
|------|------|------|------|
| postgres | postgres:15-alpine | 5432 | - |
| redis | redis:7-alpine | 6379 | - |
| litellm | ghcr.io/berriai/litellm:main-stable | 4000 | postgres |
| ts-api-gateway | 本地构建 | 3001 | postgres, redis |
| python-worker | 本地构建 | 8000 | postgres, redis |
| admin-dashboard | 本地构建 | 3000 | ts-api-gateway |

---

## 六、Trace ID 全链路设计

```
请求入口
  ↓ X-Trace-Id 继承或生成 UUID v4
  ├── TS Express middleware → AsyncLocalStorage 绑定
  ├── Python FastAPI middleware → contextvars 绑定
  ├── BullMQ Job → traceId 注入到 Job data
  ├── ARQ Task → trace_id 注入到 Task ctx
  └── Webhook 回调 → 原路返回 X-Trace-Id Header
```

---

## 七、技术栈契约

### TS 端
- 运行时：Node.js 20+
- Web 框架：Express
- ORM：Prisma (PostgreSQL)
- 缓存/队列：ioredis + BullMQ + Redlock
- 浏览器自动化：patchright
- 日志：Pino（结构化 JSON）

### Python 端
- 运行时：Python 3.11+
- Web 框架：FastAPI + Uvicorn
- 队列：ARQ (基于 Redis)
- 数据库：asyncpg（冷启动加载配置）
- HTTP 客户端：httpx
- AI/媒体：ffmpeg-python + LiteLLM Client
- 日志：python-json-logger

### 前端
- 框架：Next.js 14 (App Router)
- UI 库：shadcn/ui + Tailwind CSS
- 状态：Zustand
- 数据获取：SWR / Axios
- 校验：Zod

---

## 八、下一步

进入**阶段 2：公共包底座消减去重**
- 复制 `my_folder/src/browser/` → `packages/browser-core/`
- 创建 `packages/shared-config/`
- 创建 `packages/selectors/`
- 清理冗余代码

---

> **审查状态**: 等待用户评审
