# 阶段 3：TS 后端重构 + 发布器迁移 - 设计文档

> **日期**: 2026-06-02
> **版本**: 1.0.0

---

## 一、目标

构建 TS API Gateway 完整骨架，将 Python 端 7 个平台的发布器全部重写为 TypeScript + patchright，注入 Redlock 分布式锁机制。

---

## 二、产出物清单

### 项目骨架（3 文件）

| 文件 | 用途 |
|------|------|
| `package.json` | Express + BullMQ + Prisma + Patchright 依赖 |
| `tsconfig.json` | TypeScript 编译配置（workspace paths） |
| `Dockerfile` | Chromium + Node.js 20 容器化 |

### 基础设施（5 文件）

| 文件 | 用途 |
|------|------|
| `lib/prisma.ts` | Prisma 客户端单例 |
| `lib/redis.ts` | Redis (ioredis) 连接管理 |
| `lib/redlock.ts` | Redlock 分布式锁 + WindowMutex 封装 |
| `lib/logger.ts` | Pino 结构化日志（自动注入 traceId） |
| `lib/oss.ts` | 阿里云 OSS 客户端 + 上传工具 |

### 平台发布器（10 文件）

| 文件 | 平台 | 状态 | 行数 |
|------|------|------|------|
| `platforms/types.ts` | - | 通用类型 | 60 |
| `platforms/BasePublisher.ts` | - | 模板方法基类 | 195 |
| `platforms/index.ts` | - | 发布器工厂 | 45 |
| `platforms/douyin.ts` | 抖音 | ✅ 完整 | 170 |
| `platforms/xiaohongshu.ts` | 小红书 | ✅ 完整 | 175 |
| `platforms/kuaishou.ts` | 快手 | ✅ 完整 | 160 |
| `platforms/tencent.ts` | 腾讯视频号 | ⚠️ 基础实现 | 55 |
| `platforms/baijiahao.ts` | 百家号 | ⚠️ 基础实现 | 50 |
| `platforms/bilibili.ts` | B站 | ✅ CLI 封装 | 70 |
| `platforms/tiktok.ts` | TikTok | ⚠️ Stub | 55 |

### 服务层（2 文件）

| 文件 | 用途 |
|------|------|
| `services/publishService.ts` | BullMQ 队列 + Worker + 超时监控 |
| `services/configService.ts` | Redis Pub/Sub 广播 + Prisma 持久化 |

### 路由层（3 文件）

| 文件 | 端点 | 用途 |
|------|------|------|
| `routes/publish.ts` | POST /api/v1/publish/video | 提交发布任务 |
| `routes/webhook.ts` | POST /api/v1/webhook/python-callback | Python 回调接收 |
| `routes/config.ts` | POST/GET /api/v1/config | 配置 CRUD |

### 中间件（2 文件）

| 文件 | 用途 |
|------|------|
| `middleware/trace.ts` | Trace ID 注入（已存在于 Phase 1） |
| `middleware/errorHandler.ts` | 全局错误处理 + 404 |

### 入口

| 文件 | 用途 |
|------|------|
| `index.ts` | Express 启动 + HealthCheck + 路由注册 |

---

## 三、核心架构决策

### 3.1 发布器模板方法模式

```
BasePublisher.publish(task)
  ├── WindowMutex.acquireWithBackoff(windowId)  ← Redlock 防撞
  ├── initBrowser()                             ← 连接指纹浏览器
  ├── doLogin()          [abstract]             ← 子类实现
  ├── goToPublishPage()  [abstract]             ← 子类实现
  ├── uploadVideo()      [abstract]             ← 子类实现
  ├── fillMetadata()     [abstract]             ← 子类实现
  ├── submitPublish()    [abstract]             ← 子类实现
  └── cleanup()                                 ← 释放锁 + 关闭浏览器
```

### 3.2 反检测规则遵守

所有平台发布器严格使用 `HumanActions.*` 方法：
- `cdpClick()` 替代 `element.click()`
- `cdpSmartScroll()` 替代 `window.scrollBy()`
- `safeCDPType()` 替代 `input.value = ...`
- `cdpFindScrollContainer()` 替代 `page.evaluate(selector)`
- `cdpGetBodyText()` 替代 `document.body.innerText`

### 3.3 Redlock 窗口锁

```
WindowMutex.acquireWithBackoff(windowId)
  ├── 尝试获取 Redis 锁
  ├── 失败 → 指数退避 (1min → 2min → 4min)
  └── 成功 → 返回锁，HTTPS 操作完成后释放
```

### 3.4 BullMQ 发布队列

```
Job Queue: 'publish'
  ├── Concurrency: 5 (最多5并发)
  ├── Rate Limit: 5/min
  ├── Retry: 3次指数退避
  └── Failure → 写入 operation_logs
```

---

## 四、API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/api/v1/publish/video` | 提交发布任务 (202 Accepted) |
| GET | `/api/v1/publish/status/:taskId` | 查询任务状态 |
| POST | `/api/v1/webhook/python-callback` | Python 回调接收 |
| POST | `/api/v1/config` | 更新配置 |
| GET | `/api/v1/config/:platform` | 获取平台配置 |

---

## 五、下一步

进入 **阶段 4：Python Worker 重构**
- 初始化 `apps/python-worker/` FastAPI 骨架
- 实现 ARQ 异步队列
- 搭��� AI/FFmpeg Worker
- 实现回调 TS Webhook 机制

---

> **审查状态**: 等待用户评审
