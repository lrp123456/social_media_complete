# 项目架构规则 - 社交媒体矩阵智能运营系统

> **作用**: 本文件是 AI 编码助手的强制性架构指南。任何 AI 在修改本项目代码时，**必须严格遵循本文档定义的所有规则、模块边界和接口约定**。

---

## 一、项目身份

本项目是一个**社交媒体矩阵智能运营系统**，包含：
- 评论监控与发现（抖音、快手、小红书）
- 一键多平台发布（小红书、抖音、快手、腾讯视频号、百家号、B站、TikTok）
- AI 智能创作工作台（视频合成、风格识别、TTS）
- 系统配置管理（LLM Keys、RBAC、审计日志）

**核心约束**: 所有浏览器操作必须通过 patchright + CDP 底层协议执行，**严禁使用 Playwright 标准高层 API 进行 DOM 操作**，以确保对抗各平台风控系统。

---

## 二、技术栈与框架配置

### 2.1 浏览器自动化框架

| 层级 | 框架 | 包管理 | 作用 |
|------|------|--------|------|
| **生产代码** | patchright | `patchright: ^1.59.0` | 浏览器自动化（反检测分支） |
| **指纹浏览器** | RoxyBrowser + BitBrowser | 同时支持，通过配置切换 | 窗口级浏览器环境 |
| E2E 测试 | @playwright/test | `@playwright/test: ^1.60.0` | 仅用于 E2E 测试执行 |
| 单元测试 | Jest | `jest: ^29.7.0` | 后端逻辑单元测试 |

### 2.2 Monorepo 结构

```
/
├── apps/
│   ├── ts-api-gateway/      # Express + BullMQ + Patchright + Prisma
│   ├── python-worker/       # FastAPI + ARQ + asyncpg
│   └── admin-dashboard/     # Next.js 14 + shadcn/ui
├── packages/
│   ├── shared-config/       # 环境变量 + 7 平台常量
│   ├── selectors/           # 动态选择器注册表
│   └── browser-core/        # CDP 工具链（HumanActions 封装）
├── services/
│   └── litellm/             # LiteLLM Proxy 配置
├── prisma/
│   └── schema.prisma        # PostgreSQL 15 张表
└── docker-compose.yml       # 全栈容器编排
```

---

## 三、中间件运行机制

### 3.1 PostgreSQL（持久化真理之源）

- 存储 TS 的 15 张核心应用业务表
- 存储 Python 的任务记录、BGM 元数据表
- 存储 `custom_selectors` 选���器表（支持热更新）
- LiteLLM Proxy 模型路由表（含多渠道 API Key）

### 3.2 Redis（高速事件与锁总线）

- **Distributed Lock**: 基于 Redlock 锁定 `window_id`，防止多个任务冲突开启同一个指纹浏览器环境
- **Pub/Sub Channel**: TS 独裁写入配置后，通过 `config:updates` 频道广播，Python 接收即刻热重载内存
- **Task Broker**: 相互隔离地作为 TS 内部 BullMQ 队列和 Python 内部 ARQ 异步队列的底层数据驱动底座

### 3.3 OSS 对象存储

- 全栈唯一的媒体流文件传输媒介
- Node.js 采集到的原始素材、Python 渲染出的成品视频全部存储于此
- TS 与 Python 跨网络通信、入队 Payload 中只能传递规范的 OSS URL

---

## 四、架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  TS API Gateway (Express + BullMQ)                         │
│  核心配置独裁官 + 发布器全量重写 + Webhook 接收             │
├───────────────────────────────────────────────────────────��─┤
│  Python Worker (FastAPI + ARQ)                             │
│  纯无状态 API + AI 编排 + FFmpeg 渲染                       │
├─────────────────────────────────────────────────────────────┤
│  Admin Dashboard (Next.js 14)                              │
│  Stitch UI 对接 + 57 个 REST API                           │
├─────────────────────────────────────────────────────────────┤
│  packages/browser-core/                                     │
│  HumanActions 委托层（CDP 上下文缓存 + 安全操作封装）       │
├─────────────────────────────────────────────────────────────┤
│  packages/selectors/                                        │
│  7 平台三级降级动态 DOM 选择器注册表                        │
└─────────────────────────────────────────────────────��───────┘
```

---

## 五、三端职责与技术栈契约

### 5.1 TS 后端：大脑与自动化执行官

| 职责 | 说明 |
|------|------|
| **核心配置独裁官** | 全栈配置唯一写入入口，管理 PostgreSQL 15 张表、动态选择器、大模型元数据，通过 Redis Pub/Sub 广播变更 |
| **发布器全量重写** | 所有 7 平台发布器必须在 TS 端使用 patchright 重写，禁止 Python 端保留 uploaders/ 代码 |
| **工作流调度** | BullMQ Worker 驱动监控与发布流，通过 Redlock 锁定 window_id 防撞 |
| **自动化爬虫** | 操控指纹浏览器执行反风控人类行为模拟、评论数据抓取 |
| **Webhook 接收** | 提供 `POST /api/v1/webhook/python-callback` 接收端点 |

**🚫 绝对禁忌**：
- 禁止执行任何耗时的多媒体转码与视频剪辑（FFmpeg）
- 禁止直接调用大模型 API（必须委派给 Python）
- 禁止在本地内存中缓存或拼接大量原始视频文件

### 5.2 Python 后端：肌肉与算力中心

| 职责 | 说明 |
|------|------|
| **纯无状态 API** | 对外暴露 `POST /api/v1/tasks/material` 和 `POST /api/v1/tasks/render`，校验后立即返回 `202 Accepted` |
| **多模态 AI 编排** | 通过 ARQ 队列消费任务，统一调用 LiteLLM Proxy 执行视频内容分析、图像风格识别 |
| **重型媒体渲染** | 调用本地 FFmpeg 进程执行多视频无损拼接、音频混合、标准化重编码（1080x1920, 30fps, yuv420p） |
| **结果异步回调** | 媒体处理完成后上传 OSS，携带 `X-Trace-Id` 主动回调 TS Webhook |

**🚫 绝对禁忌**：
- 禁止保留任何 `uploaders/` 代码
- 禁止触碰任何浏览器自动化依赖
- 禁止使用 `while True` + `BRPOP` 阻塞死循环
- 禁止向本地磁盘写入任何 `.json` 配置文件

### 5.3 前端：Admin Dashboard

| 职责 | 说明 |
|------|------|
| **严格基于 Stitch UI** | 参考设计图落地管理面板页面布局与交互 |
| **业务表单校验** | 配置修改、动态选择器、大模型 Prompt 模板的校验与提交 |
| **全面对接 TS 后端** | 替换所有 Mock 数据，对接 57 个标准 RESTful API |

**🚫 绝对禁忌**：
- 禁止包含任何后端业务逻辑
- 禁止直接操作 PostgreSQL/Redis

---

## 六、反检测原则（强制规则）

### 6.1 绝对禁止的高风险操作

以下操作**绝对不能出现在任何生产代码中**：

| 禁止操作 | 风控风险 | 替换方案 |
|----------|---------|----------|
| `element.click()` | `isTrusted=false`，无鼠标轨迹 | `HumanActions.cdpClick()` |
| `window.scrollBy()` / `window.scrollTo()` | JS 层滚动，无滚轮物理事件 | `HumanActions.cdpSmartScroll()` / `HumanActions.humanScroll()` |
| `input.value = ...` | 无逐字输入延迟 | `HumanActions.safeCDPType()` |
| `page.evaluate(() => document.querySelector(...))` | JS 上下文暴露 | `HumanActions.cdpFindScrollContainer()` / CDP `DOM.querySelector` |
| `page.evaluate(() => document.body.innerText)` | 触发 getter 代理 | `HumanActions.cdpGetBodyText()` |
| `page.keyboard.press('F5')` | Playwright API | `HumanActions.cdpF5Refresh()` |
| `page.mouse.move/down/up/wheel` | Playwright API 层 | `HumanActions.cdpIdleMove/cdpIdleWheel` |

### 6.2 鼠标事件安全规则

1. **连续性**: 鼠标移动必须沿贝塞尔曲线
2. **点击拆解**: 点击必须拆分为 `mousePressed` + 随机延迟 + `mouseReleased`
3. **物理模拟**: 滚动通过 `mouseWheel` CDP 事件触发
4. **高斯偏移**: 所有点击位置加入高斯分布噪声

---

## 七、核心可复用类

### 7.1 HumanActions（★ 核心入口 ★）

所有浏览器操作必须通过 `HumanActions` 静态方法：

| 方法 | 用途 |
|------|------|
| `cdpClick(page, selector, options?)` | 安全点击（贝塞尔+高斯偏移+物理按压） |
| `humanScroll(page, amount, options?)` | 安全滚动（分段+过冲回弹） |
| `cdpSmartScroll(page, selectors, amount, dir)` | 智能容器检测+滚动 |
| `cdpFindScrollContainer(page, selectors)` | 零 JS 执行查找滚动容器 |
| `cdpF5Refresh(page)` | 安全刷新 |
| `safeCDPType(page, text, selector?)` | 逐字符安全输入 |
| `cdpGetBodyText(page)` | 零 JS 执行获取页面文本 |

### 7.2 CDP 底层工具链

| 类 | 职责 |
|------|------|
| `CDPClient` | CDP 协议底层客户端 |
| `CDPDomNavigator` | 零 JS 执行的安全元素查找 |
| `CDPHumanMouse` | 贝塞尔曲线轨迹 + 高斯偏移 |
| `CDPScroller` | 容器检测 + 物理惯性滚动 |
| `TrajectoryGenerator` | 贝塞尔曲线 + Fitts 定律 |
| `BehaviorNoise` | 行为噪声注入 |

---

## 八、架构不可变规则

### 8.1 模块边界

| 规则 | 说明 |
|------|------|
| **发布器层只能通过 HumanActions 操作浏览器** | 所有平台发布器必须走 `HumanActions.*` 方法 |
| **禁止在发布器层创建 CDPSession** | 只允许在 `HumanActions.getCDPContext()` 中出现 |
| **browserManager 只负责连接管理** | 不直接参与 DOM 操作 |

### 8.2 API 使用限制

| 禁止 | 允许的替代 |
|------|-----------|
| `import { chromium } from 'playwright'` | `import { chromium } from 'patchright'` |
| `page.evaluate(() => ...)` 操作 DOM | CDP `DOM.*` 命令（通过 HumanActions） |
| `page.keyboard.press()` | `HumanActions.cdpKeyPress()` |
| `element.click()` | `HumanActions.cdpClick()` |

---

## 九、通用开发规则

### 日志
- TS 端：`pino` 结构化日志，注入 Trace ID
- Python 端：`python-json-logger` + `contextvars` 绑定 trace_id
- 日志级别：debug < info < warn < error

### 类型安全
- 全局类型定义在各模块顶部
- CDP 层类型在各模块定义
- 使用 TypeScript 严格模式

### 错误处理
- 捕获异常后记录 warn/error，不应阻断调度循环
- CDP session 失效时 `HumanActions.withCDPContext` 自动重试
- 风控检测到异常时，立即暂停 + 通知告警

---

## 十、窗口-平台映射规则

| 概念 | 映射关系 |
|------|---------|
| User | 指纹浏览器中的一个窗口（Window） |
| Window | 通过 RoxyBrowser/BitBrowser 分配的唯一窗口 ID |
| Platform | 一个 Window 可以托管多个平台账号 |

**防撞锁机制**：
- 每次操作指纹浏览器前，通过 Redlock 锁定 `window_id`
- 如果锁被占用，通过 BullMQ 指数退避机制延迟 1-2 分钟重试
- 任务完成后自动释放锁

---

## 十一、跨端通信协议

### 11.1 TS → Python（任务下发）

```
POST /api/v1/tasks/material
POST /api/v1/tasks/render

Header: X-Trace-Id: {uuid-v4}
Payload: {
  "oss_url": "https://xxx.oss/video.mp4",
  "task_type": "material_analyze",
  "options": {...}
}
```

### 11.2 Python → TS（回调）

```
POST /api/v1/webhook/python-callback

Header: X-Trace-Id: {原请求的trace_id}
Payload: {
  "task_id": "xxx",
  "status": "completed",
  "result": {
    "oss_url": "https://xxx.oss/result.mp4",
    "analysis": {...}
  }
}
```

---

## 十二、OSS 配置

| 参数 | 值 |
|------|-----|
| region | cn-beijing |
| bucketName | naite-mes |
| endpoint | img.naite.cc |
| accessKeyId | your_oss_access_key_id |
| accessKeySecret | your_oss_access_key_secret |

---

## 十三、文件索引速查

| 文件路径 | 模块 | 作用 |
|---------|------|------|
| `apps/ts-api-gateway/src/index.ts` | 入口 | TS 后端入口 |
| `apps/ts-api-gateway/src/platforms/BasePublisher.ts` | 发布器基类 | 所有发布器的抽象基类 |
| `apps/ts-api-gateway/src/platforms/*.ts` | 发布器 | 7 平台发布实现 |
| `apps/ts-api-gateway/src/middleware/trace.ts` | Trace | Trace ID 中间件 |
| `apps/python-worker/app/main.py` | 入口 | FastAPI 入口 |
| `apps/python-worker/app/middleware/trace.py` | Trace | Trace ID 中间件 |
| `packages/browser-core/src/humanActions.ts` | 核心 | CDP 操作唯一入口 |
| `prisma/schema.prisma` | 数据库 | PostgreSQL 15 张表 |

---

> **本文件最后更新**: 2026-06-02