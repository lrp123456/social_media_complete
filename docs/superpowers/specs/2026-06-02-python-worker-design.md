# 阶段 4：Python Worker 重构 - 设计文档

> **日期**: 2026-06-02
> **版本**: 1.0.0

---

## 一、目标

将 Python 端重构为纯无状态微服务，斩断所有浏览器依赖，用 ARQ 替代 Celery，实现算力纯净化。

---

## 二、产出物清单（17 文件，721 行）

### 项目骨架

| 文件 | 用途 |
|------|------|
| `pyproject.toml` | Python 项目元数据 |
| `requirements.txt` | 依赖清单（无 browser/patchright） |
| `Dockerfile` | FFmpeg + Python 3.11 容器 |

### 核心框架

| 文件 | 用途 |
|------|------|
| `app/main.py` | FastAPI 入口 + lifespan 管理 |
| `app/config.py` | pydantic-settings 环境变量加载 |

### 中间件

| 文件 | 用途 |
|------|------|
| `app/middleware/trace.py` | Trace ID 绑定（contextvars） - Phase 1 创建 |
| `app/middleware/logging.py` | python-json-logger 结构化日志 |

### 路由（纯无状态 API）

| 文件 | 端点 | 行为 |
|------|------|------|
| `app/routers/health.py` | GET /health | 健康检查 |
| `app/routers/tasks.py` | POST /api/v1/tasks/material | 素材分析 → ARQ → 202 |
|  | POST /api/v1/tasks/render | 视频渲染 → ARQ → 202 |

### ARQ Worker（替代 Celery）

| 文件 | 用途 |
|------|------|
| `app/workers/arq_app.py` | ARQ 队列连接管理 |
| `app/workers/tasks.py` | `process_material` / `process_render` 任务处理器 |

### 服务层（无状态、无浏览器）

| 文件 | 用途 |
|------|------|
| `app/services/llm_client.py` | LiteLLM Proxy 客户端（单例） |
| `app/services/ffmpeg.py` | FFmpeg 标准化重编码 + OSS 上传 |
| `app/services/webhook.py` | Python → TS Webhook 异步回调 |

### 数据模型

| 文件 | 用途 |
|------|------|
| `app/models/__init__.py` | Pydantic 请求/响应/回调模型 |

---

## 三、清理对照表（与旧项目对比）

| 旧项目 (n8n-backup) | 新项目 | 变更 |
|---------------------|--------|------|
| Celery | ARQ | 替代 Redis-backed 轻量队列 |
| `app/uploaders/` (7文件) | ❌ 已删除 | 迁移至 TS 端 |
| `while True` + `BRPOP` | ❌ 已删除 | ARQ 内置事件循环 |
| `.json` 文件写入 | ❌ 已删除 | 全状态来自 Payload + DB |
| playwright/patchright | ❌ 已删除 | 依赖清单无 browser 包 |
| fingerprint_browser.py | ❌ 已删除 | Browser 操作在 TS 端 |
| browser_stealth.py | ❌ 已删除 | HumanActions 在 TS 端 |

---

## 四、数据流

```
TS API Gateway (BullMQ)
  ↓ POST /api/v1/tasks/render { oss_urls: [...], ... }
Python Worker (FastAPI)
  ↓ 202 Accepted ← ARQ enqueue_job
ARQ Worker (arq.task)
  ├── download_from_oss(oss_url)
  ├── normalize_video()  [1080×1920, 30fps, yuv420p]
  ├── concat_videos()
  ├── upload_to_oss()
  └── callback_ts_webhook()  [X-Trace-Id]
        ↓ POST /api/v1/webhook/python-callback
TS API Gateway
  ↓ 更新 task_records 状态 → 解锁后续发布流
```

---

## 五、下一步

进入 **阶段 5：Next.js 前端构建**
- 初始化 `apps/admin-dashboard/` (Next.js 14 + shadcn/ui)
- 参考 Stitch UI 构建 Layout
- 构建 4 核心页面（设置/监控/发布/创作）
- 对接 TS 后端 API 替换 Mock 数据

---

> **审查状态**: 等待用户评审
