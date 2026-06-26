# 视频流程节点监控与维护调试系统设计规格

> **版本**: v1.1（Oracle 审核修正版）  
> **日期**: 2026-06-26  
> **状态**: 待审批  
> **方案**: 方案A（探针织入）— 当前落地；方案B（声明式引擎）— 未来重构方向

### 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| v1.0 | 2026-06-26 | 初始设计 |
| v1.1 | 2026-06-26 | Oracle 审核修正：C1 新增方法作为一级交付物、C2 PageProxy 移至核心包、C3 指定 Redis 传输通道、M1-M5 数据模型修正、m1-m5 次要修正、新增安全清洗层 |

---

## 一、目标与范围

### 1.1 核心目标

为社交媒体矩阵运营系统的三大流程（视频发布、视频监控、视频评论回复）构建企业级的**流程节点健康监控与维护调试系统**，实现：

1. **精细化健康监控** — 智能分层：子步骤红黄绿概览 → 展开看每个选择器/URL/响应字段的详细状态
2. **快捷修复与重试** — 单选择器验证 + 子步骤级重试，快速定位并修复失效点
3. **Debug 模式** — 手动开关，保存失效节点的 DOM 快照、URL 拦截数据、响应体内容
4. **自动降级建议** — 当 primary 选择器失效但 fallback 命中时，自动建议提升
5. **配置快照与回滚** — 修改前自动保存，改坏了可一键回滚（CAS 乐观锁）
6. **配置导出/导入** — 已验证的健康配置可在环境间迁移

### 1.2 当前平台覆盖

- **抖音（Douyin）**: v2 收口已完成（~99%），作为样板平台
- **快手/小红书/视频号/其他**: 后续按抖音样板逐步跟进

### 1.3 未来方向（方案B）

声明式工作流引擎——将流程定义为 YAML 配置文件，引擎自动执行和上报健康数据。本文档中不展开，作为下一阶段重构目标。

---

## 二、总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Admin Dashboard (新增 /maintenance)         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ 执行健康面板 │  │ 选择器健康详情 │  │ Debug快照查看        │ │
│  │ (子步骤红黄绿)│  │ (展开→字段级) │  │ (DOM + 响应体回放)   │ │
│  └─────────────┘  └──────────────┘  └──────────────────────┘ │
│  ┌─────────────┐  ┌──────────────────────────────────────┐   │
│  │ 配置管理面板 │  │ 单点验证 & 重试面板                   │   │
│  │ (快照/回滚)  │  │ (选择器测试/URL测试/子步骤重跑)        │   │
│  └─────────────┘  └──────────────────────────────────────┘   │
└──────────────────────┬───────────────────────────────────────┘
                       │ REST API
┌──────────────────────┴───────────────────────────────────────┐
│              TS API Gateway (新增 /api/v1/maintenance/*)       │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ MaintenanceAPI   │  │ ConfigAPI     │  │ VerifyAPI      │  │
│  │ (报告/列表/详情)  │  │ (快照/回滚)   │  │ (单点验证/重试) │  │
│  └──────────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────┬───────────────────────────────────────┘
                       │ Prisma ORM
┌──────────────────────┴───────────────────────────────────────┐
│                 新增 DB 表 (Prisma)                            │
│  maintenance_execution  maintenance_step  maintenance_selector │
│  maintenance_url_record  debug_snapshot  config_snapshot      │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────────────────┐
│              browser-core 探针层 (新增模块)                     │
│  ┌──────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ MaintenanceProbe  │  │ DebugCollector  │  │ PageProxy   │ │
│  │ (选择器/URL/响应)  │  │ (DOM快照/响应体) │  │ (旁路报警)   │ │
│  └──────┬───────────┘  └────────┬────────┘  └──────┬──────┘ │
│         │ 织入到 ↓              │ 条件触发          │ Proxy   │
│  ┌──────┴──────────────────────┴──────────────────┴───────┐ │
│  │ HumanActions + RequestInterceptor (现有,不改业务逻辑)    │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 数据流

1. 爬虫执行时，在每个子步骤入口调用 `MaintenanceProbe.enterStep(flow, platform, phase, step, subStep)`
2. 探针在 `HumanActions.clickWithFallback()` / `findInScope()` 和 `RequestInterceptor` 内部自动采集结果
3. 未收口代码通过 `PageProxy` 自动捕获旁路调用并记录
4. 采集数据异步批量写入 `maintenance_*` 表（正常模式写健康数据，debug 模式下额外写快照）
5. 执行完成后，`MaintenanceCollector` 计算健康摘要写入 `maintenance_execution`
6. Admin Dashboard 拉取报告展示

---

## 三、双引擎配置中心

> **配置文件统一管理**：DOM 选择器和 API 网络监控配置统一存放在 `selectors.json` 中，不创建独立文件。现有 `urlMonitors` 部分将按新结构升级。

### 3.1 DOM 选择器配置 (`selectors.json` — selectors 部分)

#### 选择器策略矩阵

| 策略 | 优先级 | 反爬安全性 | 适用场景 |
|------|--------|-----------|---------|
| **Text/Role** | ⭐1 | 🟢极高 | 首选。`getByText('发布')`、`getByRole('button', {name: '提交'})` |
| **Data-Attr** | ⭐2 | 🟢高 | 次选。`[data-testid="publish-btn"]` |
| **Scoped CSS** | ⭐3 | 🟡中 | 常规。`.comment-container > .submit-btn`，必须配合 fallback |
| **Relative/Proximity** | ⭐4 | 🟢高 | 奇招。"找到包含'张三'的节点，取其右侧'回复'按钮" |
| **XPath** | ⭐5 | 🔴低 | 禁用/慎用。仅腾讯视频号 wujie Shadow DOM 深层兜底 |

#### 配置结构（平台 → 模块 → 组件 → 降级链）

```json
{
  "douyin": {
    "monitor": {
      "menu_creator_home": {
        "strategy": "text_role",
        "primary": "getByRole('menuitem', {name: '首页'})",
        "fallbacks": [
          "#douyin-creator-master-menu-nav-home:visible",
          "css=.creator-menu .menu-item:first-child"
        ],
        "scope": ".creator-master-menu",
        "timeout": 5000,
        "description": "创作者首页菜单项"
      },
      "comment_reply_btn": {
        "strategy": "text_role",
        "scope": "[class*='comment-item-'][data-cid='{cid}']",
        "primary": "getByRole('button', {name: '回复'})",
        "fallbacks": [
          "css=[class*='operations-'] [class*='item-']",
          "text=回复"
        ],
        "anti_honeypot": {
          "min_width": 15,
          "min_height": 15,
          "must_be_in_viewport": true,
          "element_from_point": true
        },
        "timeout": 5000,
        "description": "评论回复按钮（作用域隔离）"
      },
      "video_list_item": {
        "strategy": "scoped_css",
        "chain": [
          "css=wujie-app",
          "shadow=.scroll-list__wrp",
          "css=.comment-feed-wrap[data-id='{videoId}']"
        ],
        "target": "css=.title-text",
        "timeout": 8000,
        "description": "视频号穿透 Shadow DOM 查找"
      }
    },
    "publish": {
      "submit_btn": {
        "strategy": "text_role",
        "primary": "getByRole('button', {name: '发布'})",
        "fallbacks": [
          "button[data-testid='publish']",
          "css=.btn-publish-container button"
        ],
        "scope": "form.publish-form",
        "timeout": 5000,
        "description": "发布提交按钮"
      }
    }
  }
}
```

#### Scope 作用域机制

- **单层 Scope**：`scope` 字段定义外层容器，`findInScope()` 先定位容器再在内部搜索目标
- **多级 Chain**：`chain` 数组定义穿透路径（主文档 → Shadow DOM → 内部容器），`target` 在最终容器内查找
- **动态变量**：`{cid}`、`{videoId}` 等占位符在运行时替换

#### 防蜜罐机制

`findInScope()` 内部三层过滤：

| 层级 | 检查内容 | 拦截的蜜罐类型 |
|------|---------|---------------|
| Scope 隔离 | 只在业务容器内搜索 | 全局隐藏诱饵 |
| 物理校验 | 尺寸 ≥ 15px + 在视口内 | 极小元素、屏幕外流放 |
| elementFromPoint | 坐标最顶层是否为目标 | 透明覆盖层、z-index 欺骗 |

### 3.2 API 网络监控配置 (`selectors.json` — apiMonitors 部分)

#### 配置结构

```json
{
  "douyin": {
    "video_list": {
      "description": "作品列表API",
      "url_patterns": [
        "\\/aweme\\/v1\\/web\\/aweme\\/post\\/?.*",
        "\\/aweme\\/v2\\/web\\/aweme\\/post\\/?.*"
      ],
      "method": "POST",
      "validation": {
        "required_url_params": ["sec_user_id"],
        "required_body_fields": ["data.aweme_list"],
        "success_indicator": {"path": "status_code", "value": 0}
      },
      "extraction": {
        "items_path": "data.aweme_list",
        "id_field": "aweme_id",
        "field_map": {
          "desc": "desc",
          "createTime": "create_time",
          "commentCount": "statistics.comment_count"
        }
      },
      "pagination": {
        "has_more_path": "data.has_more",
        "cursor_path": "data.cursor",
        "cursor_param_name": "cursor",
        "dedup_keys": ["cursor", "sec_user_id"]
      },
      "capture": {
        "request_params": true,
        "response_headers": false
      },
      "hooks": {}
    },
    "comment_list": {
      "description": "评论列表API",
      "url_patterns": [
        "\\/aweme\\/v1\\/web\\/comment\\/list\\/?.*"
      ],
      "method": "GET",
      "validation": {
        "required_body_fields": ["data.comments"],
        "success_indicator": {"path": "status_code", "value": 0}
      },
      "extraction": {
        "items_path": "data.comments",
        "id_field": "cid"
      },
      "pagination": {
        "has_more_path": "data.has_more",
        "cursor_path": "data.cursor"
      }
    }
  },
  "xiaohongshu": {
    "comment_list": {
      "description": "小红书根评论列表",
      "url_patterns": [
        "**/api/sns/web/v2/comment/page**",
        "**/api/sns/web/v1/comment/page**"
      ],
      "validation": {
        "required_url_params": ["note_id"],
        "required_body_fields": ["data.comments"],
        "success_indicator": {"path": "success", "value": true}
      },
      "extraction": {
        "items_path": "data.comments",
        "cursor_path": "data.cursor",
        "has_more_path": "data.has_more"
      },
      "pagination_key": ["note_id", "cursor"]
    }
  }
}
```

#### 核心字段说明

| 字段 | 用途 |
|------|------|
| `url_patterns` | URL 多路降级匹配（Glob/正则），平台升级 API 时在数组头部插入新路径 |
| `validation.required_url_params` | 过滤缺少关键参数的预检请求 |
| `validation.required_body_fields` | 防止拦截到 403/500 或风控"空壳 JSON" |
| `validation.success_indicator` | 响应成功标志字段 |
| `extraction.items_path` | JSON Path 点号语法提取数据列表 |
| `extraction.field_map` | 字段映射，消灭业务代码中的 `resp?.body?.data?.comments` |
| `pagination.dedup_keys` | 请求体去重键，替代硬编码的 `lastBuff \|\| pcursor` |
| `hooks` | 插件化 Hook（如 `decrypt_douyin_response`），应对加密响应体 |

#### 热更新机制

- **本地开发**: `chokidar` 监听文件变化，内存热更新
- **生产环境**: Redis Pub/Sub 频道，秒级全网生效
- `RequestInterceptor` 支持 `hotReloadRules()` 方法，无需断开 CDP 连接

---

## 四、探针层设计

### 4.1 `MaintenanceProbe` — 健康探针

**文件**: `packages/browser-core/src/maintenanceProbe.ts`

> **C1 修正**：`clickWithFallback()`、`findInScope()`、`attachByConfig()` 目前不存在，需作为一级可交付成果实现。

> **m1 修正**：使用 `AsyncLocalStorage` 替代静态字段，支持并发任务上下文隔离。

```typescript
import { AsyncLocalStorage } from 'async_hooks';

interface ProbeContext {
  flow: string
  platform: string
  phase: string
  step: string
  subStep?: string
  taskExecutionId?: string
}

class MaintenanceProbe {
  private static enabled = false
  private static contextStore = new AsyncLocalStorage<ProbeContext>()

  // 爬虫在每个子步骤入口调用
  static enterStep(flow: string, platform: string, phase: string, step: string, subStep?: string): void
  static exitStep(): void

  // 获取当前异步链的上下文（并发安全）
  static getContext(): ProbeContext | undefined

  // HumanActions 内部调用 — 选择器操作
  static recordSelectorOp(op: {
    selectorKey: string
    selectorUsed: string
    selectorSource: 'primary' | 'fallback_1' | 'fallback_2'
    result: 'found' | 'not_found' | 'timeout' | 'error' | 'honeypot_blocked' | 'scope_not_found'
    durationMs: number
    elementTag?: string
    elementText?: string
    isVisible?: boolean
    isHoneypotBlocked?: boolean
    honeypotReason?: 'off-screen' | 'obscured' | 'too-small'
    scopeSelector?: string
    scopeMatchTimeMs?: number
    errorMessage?: string
  }): void

  // RequestInterceptor 内部调用 — URL 拦截
  static recordUrlIntercept(op: {
    healthKey: string
    urlPattern: string
    actualUrl: string
    httpStatus: number
    result: 'matched' | 'no_match' | 'timeout' | 'extraction_failed' | 'validation_failed'
    validationStep?: string
    itemsFound?: number
    hasMore?: boolean
    cursorValue?: string
    extractionValid?: boolean
    missingFields?: string[]
    requestParams?: Record<string, unknown>
    durationMs: number
    responseSize: number
    videoId?: string       // m4: 关联的内容条目
    commentCid?: string    // m4: 关联的评论
  }): void

  // PageProxy 调用 — 旁路报警（m5: 使用 apply 拦截器）
  static recordBypass(method: string, stack: string | undefined, windowId: string): void

  // Debug 模式下保存快照（m5: 带安全清洗）
  static recordSnapshot(type: 'dom' | 'response' | 'network', data: {
    selectorKey?: string
    urlPattern?: string
    content: string
    mimeType: string
  }): void
}
```

### 4.2 `MaintenanceCollector` — 数据收集器

**文件**: `apps/ts-api-gateway/src/services/maintenanceCollector.ts`

> **C3 修正**：探针数据通过 Redis list 传输（`LPUSH` / `BRPOP`），已有基础设施。

```typescript
class MaintenanceCollector {
  private buffer: ProbeEvent[] = []

  // 由 MaintenanceProbe 通过 Redis LPUSH 推送
  // Collector 以 5 秒 BRPOP 消费
  async startConsuming(): Promise<void>

  // 定时 flush 到 DB（每 5 秒或满 50 条）
  private async flush(): Promise<void>

  // 执行完成后计算健康摘要
  async summarizeExecution(taskExecutionId: string): Promise<void>

  // 回退方案：Redis 不可用时静默丢弃事件
  private handleRedisFailure(event: ProbeEvent): void
}
```

### 4.3 `PageProxy` — 旁路报警器

**文件**: `packages/browser-core/src/pageProxy.ts`（C2 修正：移至核心包）

> **C2 修正**：PageProxy 放在 `packages/browser-core/src/`，在 `BrowserManager.connect()` 内部应用（`newPage()` 之后）。

> **m5 修正**：使用 `apply` 拦截器（仅在实际调用时触发），添加每步旁路上限（100 条），排除非选择器旁路（`waitForTimeout`、`screenshot`）。

```typescript
const PROXY_INTERCEPT_METHODS = ['evaluate', 'evaluateHandle', '$', '$$', 'locator'];
// 排除：goto（导航）、screenshot（调试）、waitForTimeout（等待）、keyboard（输入）

function createProxiedPage(rawPage: Page, windowId: string): Page {
  // 对返回函数的方法使用 apply 拦截器
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (PROXY_INTERCEPT_METHODS.includes(prop as string) && typeof value === 'function') {
        return new Proxy(value, {
          apply(fnTarget, thisArg, args) {
            // 仅在实际调用时记录旁路
            MaintenanceProbe.recordBypass(prop as string, new Error().stack, windowId);
            return Reflect.apply(fnTarget, thisArg, args);
          }
        });
      }
      return value;
    }
  };
  return new Proxy(rawPage, handler);
}
```

### 4.4 集成点（修改现有代码的位置）

| 文件 | 修改点 | 新增行数 |
|------|--------|---------|
| `humanActions.ts` | **新增** `clickWithFallback()` 方法（C1） | ~80 行 |
| `humanActions.ts` | **新增** `findInScope()` 方法（C1） | ~60 行 |
| `interceptor.ts` | **新增** `attachByConfig()` 方法（C1） | ~40 行 |
| `humanActions.ts` | `clickWithFallback()` 内部调用 `recordSelectorOp()` | ~20 行 |
| `humanActions.ts` | `findInScope()` 内部调用 `recordSelectorOp()`（含防蜜罐字段） | ~15 行 |
| `humanActions.ts` | `safeEvaluate()` 异常时调用 `recordSelectorOp()` | ~8 行 |
| `interceptor.ts` | `attachByConfig()` 后调用 `recordUrlIntercept()` | ~15 行 |
| `interceptor.ts` | `extractItems()` / validation 失败时调用 `recordUrlIntercept()` | ~10 行 |
| `browserManager.ts` | `createProxiedPage()` 替代直接返回 page（C2） | ~5 行 |
| 爬虫文件 | 每子步骤入口 `MaintenanceProbe.enterStep()` | ~1-2 行/子步骤 |

---

## 五、数据模型

### 5.1 表关系

```
TaskExecution (现有)          maintenance_execution (新增)
    │ 1:1                          │ 1:1
    ▼                              ▼
TaskExecutionStep (现有)       maintenance_step (新增)
                                    │ 1:N
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
          maintenance_selector  maintenance_url   debug_snapshot
              _record             _record          (新增)
              (新增)              (新增)

config_snapshot (独立，不关联执行)
```

### 5.2 `maintenance_execution` — 执行健康摘要

> **M1 修正**：添加与 `TaskExecution` 的 `@relation` + 级联删除。`isDebugMode` 以 `TaskExecution` 为准。

```prisma
model MaintenanceExecution {
  id              String    @id @default(cuid())
  taskExecutionId String    @unique @map("task_execution_id")
  platform        String    @db.VarChar(32)
  flowType        String    @map("flow_type") @db.VarChar(16)   // monitor | publish | reply
  windowId        String    @map("window_id") @db.VarChar(128)
  userId          Int?      @map("user_id")                     // M3: 操作员筛选
  overallHealth   String    @default("healthy") @db.VarChar(16) // healthy | degraded | failed
  totalSteps      Int       @default(0) @map("total_steps")
  healthySteps    Int       @default(0) @map("healthy_steps")
  degradedSteps   Int       @default(0) @map("degraded_steps")
  failedSteps     Int       @default(0) @map("failed_steps")
  totalSelectors  Int       @default(0) @map("total_selectors")
  passedSelectors Int       @default(0) @map("passed_selectors")
  failedSelectors Int       @default(0) @map("failed_selectors")
  totalUrlChecks  Int       @default(0) @map("total_url_checks")
  passedUrlChecks Int       @default(0) @map("passed_url_checks")
  startedAt       DateTime  @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")

  taskExecution TaskExecution @relation(fields: [taskExecutionId], references: [id], onDelete: Cascade)
  steps         MaintenanceStep[]

  @@index([platform, startedAt], name: "idx_maint_exec_platform_time")
  @@index([overallHealth], name: "idx_maint_exec_health")
  @@index([userId], name: "idx_maint_exec_user")                   // M3
  @@map("maintenance_executions")
}
```

### 5.3 `maintenance_step` — 子步骤健康详情

```prisma
model MaintenanceStep {
  id              String    @id @default(cuid())
  executionId     String    @map("execution_id")
  phase           String    @db.VarChar(64)
  stepName        String    @map("step_name") @db.VarChar(128)
  subStepName     String?   @map("sub_step_name") @db.VarChar(128)
  healthStatus    String    @default("healthy") @map("health_status") @db.VarChar(16)
  outcomeSuccess  Boolean   @default(true) @map("outcome_success")
  outcomeDetail   String?   @map("outcome_detail") @db.Text
  durationMs      Int?      @map("duration_ms")
  selectorCount   Int       @default(0) @map("selector_count")
  selectorPassed  Int       @default(0) @map("selector_passed")
  urlCount        Int       @default(0) @map("url_count")
  urlPassed       Int       @default(0) @map("url_passed")
  createdAt       DateTime  @default(now()) @map("created_at")

  execution       MaintenanceExecution @relation(fields: [executionId], references: [id], onDelete: Cascade)
  selectorRecords MaintenanceSelectorRecord[]
  urlRecords      MaintenanceUrlRecord[]
  snapshots       DebugSnapshot[]

  @@index([executionId, phase], name: "idx_maint_step_exec_phase")
  @@index([healthStatus], name: "idx_maint_step_health")
  @@map("maintenance_steps")
}
```

### 5.4 `maintenance_selector_record` — 选择器操作记录

> **M4 修正**：`selectorUsed` 改为 `@db.Text`，避免长 CSS/XPath 溢出。

```prisma
model MaintenanceSelectorRecord {
  id                 String    @id @default(cuid())
  stepId             String    @map("step_id")
  selectorKey        String    @map("selector_key") @db.VarChar(128)
  selectorUsed       String    @map("selector_used") @db.Text        // M4: 改为 Text
  selectorSource     String    @map("selector_source") @db.VarChar(20) // primary | fallback_1 | fallback_2 | bypass_detected
  result             String    @db.VarChar(20) // found | not_found | timeout | error | honeypot_blocked | scope_not_found | bypass_detected
  durationMs         Int?      @map("duration_ms")
  elementTag         String?   @map("element_tag") @db.VarChar(32)
  elementText        String?   @map("element_text") @db.VarChar(256)
  isVisible          Boolean?  @map("is_visible")
  isHoneypotBlocked  Boolean?  @map("is_honeypot_blocked")
  honeypotReason     String?   @map("honeypot_reason") @db.VarChar(32) // off-screen | obscured | too-small
  scopeSelector      String?   @map("scope_selector") @db.VarChar(256)
  scopeMatchTimeMs   Int?      @map("scope_match_time_ms")
  errorMessage       String?   @map("error_message") @db.Text
  createdAt          DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId], name: "idx_maint_sel_step")
  @@index([selectorKey, result], name: "idx_maint_sel_key_result")
  @@map("maintenance_selector_records")
}
```

### 5.5 `maintenance_url_record` — URL 拦截记录

> **m4 修正**：添加可空 `videoId` / `commentCid` 字段，关联内容条目。

```prisma
model MaintenanceUrlRecord {
  id              String    @id @default(cuid())
  stepId          String    @map("step_id")
  healthKey       String?   @map("health_key") @db.VarChar(128)
  urlPattern      String    @map("url_pattern") @db.VarChar(256)
  actualUrl       String?   @map("actual_url") @db.Text
  httpStatus      Int?      @map("http_status")
  result          String    @db.VarChar(24) // matched | no_match | timeout | extraction_failed | validation_failed
  validationStep  String?   @map("validation_step") @db.VarChar(64)
  itemsFound      Int?      @map("items_found")
  hasMore         Boolean?  @map("has_more")
  cursorValue     String?   @map("cursor_value") @db.VarChar(256)
  extractionValid Boolean?  @map("extraction_valid")
  missingFields   String?   @map("missing_fields") @db.Text
  requestParams   String?   @map("request_params") @db.Text
  videoId         String?   @map("video_id") @db.VarChar(64)     // m4: 关联视频
  commentCid      String?   @map("comment_cid") @db.VarChar(64)  // m4: 关联评论
  durationMs      Int?      @map("duration_ms")
  responseSize    Int?      @map("response_size")
  createdAt       DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId], name: "idx_maint_url_step")
  @@index([healthKey, result], name: "idx_maint_url_healthkey_result")
  @@index([videoId], name: "idx_maint_url_video")                  // m4
  @@map("maintenance_url_records")
}
```

### 5.6 `debug_snapshot` — Debug 快照

```prisma
model DebugSnapshot {
  id           String    @id @default(cuid())
  stepId       String    @map("step_id")
  snapshotType String    @map("snapshot_type") @db.VarChar(16) // dom | response | network
  selectorKey  String?   @map("selector_key") @db.VarChar(128)
  urlPattern   String?   @map("url_pattern") @db.VarChar(256)
  content      String    @db.Text
  contentSize  Int       @default(0) @map("content_size")
  mimeType     String?   @map("mime_type") @db.VarChar(32)
  expiresAt    DateTime  @map("expires_at")
  createdAt    DateTime  @default(now()) @map("created_at")

  step MaintenanceStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId, snapshotType], name: "idx_debug_snap_step_type")
  @@index([expiresAt], name: "idx_debug_snap_expires")
  @@map("debug_snapshots")
}
```

### 5.7 `config_snapshot` — 配置快照

> **m2 修正**：添加 `@@index([platform, createdAt])` 优化时间序列查询。
> **m3 修正**：CAS 使用 `UPDATE ... WHERE version = $v` 原子操作。

```prisma
model ConfigSnapshot {
  id           String    @id @default(cuid())
  snapshotName String    @map("snapshot_name") @db.VarChar(128)
  platform     String    @db.VarChar(32)
  configType   String    @map("config_type") @db.VarChar(32) // selectors | url_monitors | flow_rules
  configData   String    @map("config_data") @db.Text
  version      Int       @default(1)
  createdBy    String    @default("system") @map("created_by") @db.VarChar(32)
  description  String    @default("") @db.VarChar(255)
  isActive     Boolean   @default(false) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")

  @@index([platform, configType, isActive], name: "idx_config_snap_active")
  @@index([platform, createdAt], name: "idx_config_snap_platform_time")  // m2
  @@map("config_snapshots")
}
```

### 5.8 Debug 快照熔断机制

| 机制 | 参数 | 默认值 |
|------|------|--------|
| 采样率 | `debugSampleRate` | 20%（可配置 0-100%） |
| 连续失败触发 | `debugTriggerAfterN` | 连续 3 次失败后才保存快照 |
| 强制 TTL | `debugSnapshotTTL` | 7 天，pg_cron 自动清理 |
| 单次执行上限 | `debugMaxSnapshotsPerExec` | 50 条，超出丢弃最旧的 |

---

## 六、健康判定逻辑

### 6.1 层级判定规则

| 层级 | healthy | degraded | failed |
|------|---------|----------|--------|
| **选择器** | primary 命中 | fallback 命中 | 全未命中 / honeypot_blocked / scope_not_found |
| **URL 拦截** | 匹配 + 提取成功 | 匹配但 validation 部分失败 | 未匹配 / 提取失败 |
| **子步骤** | 结果检查通过 + 所有组件 healthy | 有 degraded 组件 | 有 failed 组件或结果检查失败 |
| **执行** | 全部子步骤 healthy | 有 degraded 子步骤 | 有 failed 子步骤 |

### 6.2 降级告警

当选择器触发 fallback 命中时：
1. 自动写入 `maintenance_selector_record`（`selectorSource: 'fallback_1'`）
2. 可选企业微信通知：`[抖音] menu_creator_home 主选择器失效，已降级使用 fallback_1`
3. UI 选择器健康面板显示降级率，超过阈值标红

### 6.3 API 变更告警

当 URL 拦截连续 N 次 validation 失败时：
1. 自动写入 `maintenance_url_record`（`result: 'validation_failed'`, `validationStep` 记录失败步骤）
2. 触发 "API 变更告警" 通知
3. UI 显示最近失败的 validation 步骤，辅助定位问题

---

## 七、API 设计

### 7.1 执行健康报告

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/v1/maintenance/executions` | 执行历史列表（筛选：platform, healthStatus, flowType, 时间范围） |
| `GET` | `/api/v1/maintenance/executions/:id` | 单次执行健康详情（子步骤列表 + 摘要） |
| `GET` | `/api/v1/maintenance/executions/:id/steps` | 子步骤详情（选择器/URL 记录） |

### 7.2 选择器健康

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/v1/maintenance/selectors/health` | 选择器健康统计（按平台/键名聚合，含降级率） |
| `GET` | `/api/v1/maintenance/selectors/:key/history` | 单个选择器历史趋势 |

### 7.3 Debug 数据

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/v1/system/debug-mode` | （已有）获取 debug 开关状态 |
| `PUT` | `/api/v1/system/debug-mode` | （已有）设置 debug 开关 |
| `GET` | `/api/v1/maintenance/snapshots/:stepId` | 获取某步骤的 debug 快照 |

### 7.4 配置管理

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/v1/maintenance/config/snapshots` | 创建配置快照 |
| `GET` | `/api/v1/maintenance/config/snapshots` | 快照列表 |
| `POST` | `/api/v1/maintenance/config/snapshots/:id/rollback` | 回滚到指定快照（CAS 乐观锁） |
| `POST` | `/api/v1/maintenance/config/export` | 导出配置 |
| `POST` | `/api/v1/maintenance/config/import` | 导入配置 |

### 7.5 单点验证 & 重试

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/v1/maintenance/verify/selector` | 单选择器验证（在指定页面测试选择器是否命中） |
| `POST` | `/api/v1/maintenance/verify/url` | 单 URL 验证（测试拦截规则是否匹配） |
| `POST` | `/api/v1/maintenance/retry/step` | 子步骤级重试（重跑某个子步骤） |

### 7.6 配置快照 CAS 乐观锁

```typescript
async rollbackConfig(platform: string, configType: string, snapshotId: string, currentVersion: number) {
  // 1. 读取目标快照
  const target = await prisma.configSnapshot.findUnique({ where: { id: snapshotId } });
  
  // 2. 检查当前活跃版本
  const active = await prisma.configSnapshot.findFirst({
    where: { platform, configType, isActive: true }
  });
  
  if (active && active.version !== currentVersion) {
    throw new ConflictError('配置已被其他人修改，请刷新后重试');
  }
  
  // 3. 回滚 = 创建新版本记录（不是物理覆盖）
  await prisma.configSnapshot.create({
    data: {
      platform,
      configType,
      configData: target.configData,
      version: (active?.version ?? 0) + 1,
      isActive: true,
      createdBy: 'rollback',
      description: `回滚到快照 ${snapshotId}`
    }
  });
  
  // 4. 将旧的 active 标记为 inactive
  if (active) {
    await prisma.configSnapshot.update({
      where: { id: active.id },
      data: { isActive: false }
    });
  }
}
```

---

## 八、UI 设计

### 8.1 Tab 1：执行健康（默认视图）

```
┌─────────────────────────────────────────────────────────┐
│  平台筛选: [全部] [抖音] [快手] [小红书] [视频号]           │
│  状态筛选: [全部] [✅健康] [⚠️降级] [❌失败]               │
│  时间范围: [最近24h] [最近7天] [自定义]                     │
├─────────────────────────────────────────────────────────┤
│  执行历史表格                                             │
│  ┌─────┬──────┬──────┬──────┬──────┬──────┬──────┐     │
│  │ 时间 │ 平台 │ 类型 │ 健康 │ 步骤 │ 选择器│ 操作  │     │
│  ├─────┼──────┼──────┼──────┼──────┼──────┼──────┤     │
│  │ 14:30│ 抖音 │ 监控 │ ✅  │ 5/5  │ 12/12│ [详情]│     │
│  │ 13:15│ 快手 │ 监控 │ ⚠️  │ 4/5  │ 10/12│ [详情]│     │
│  │ 12:00│ 抖音 │ 发布 │ ❌  │ 2/4  │ 6/10 │ [详情]│     │
│  └─────┴──────┴──────┴──────┴──────┴──────┴──────┘     │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Tab 2：执行详情（点击"详情"展开）

```
┌─────────────────────────────────────────────────────────┐
│  执行 #xxx — 抖音监控 — 2026-06-26 14:30 — ✅健康       │
├─────────────────────────────────────────────────────────┤
│  Phase 1: 扫描作品列表                                    │
│  ├─ ✅ 导航到作品管理页 (320ms)                           │
│  │   ├─ ✅ menu_creator_home → primary 命中 (45ms)       │
│  │   ├─ ✅ menu_sub_work_manage → fallback_1 命中 (38ms) │
│  │   └─ ✅ video_list (healthKey) → 12条数据 (180ms)     │
│  ├─ ⚠️ 滚动加载视频列表 (2.1s)                           │
│  │   ├─ ✅ region_work_list → primary 命中 (52ms)        │
│  │   └─ ⚠️ video_list → validation_failed (220ms)       │
│  │       └─ 失败步骤: required_body_fields               │
│  │       └─ [查看响应体] [修改提取规则] [重试]              │
│  ...                                                     │
├─────────────────────────────────────────────────────────┤
│  [🔄 重试整个执行] [📸 查看Debug快照] [📥 导出报告]       │
└─────────────────────────────────────────────────────────┘
```

### 8.3 Tab 3：选择器健康面板

```
┌─────────────────────────────────────────────────────────┐
│  选择器健康概览 — 抖音                                    │
├──────────┬──────┬──────┬──────┬──────┬─────────────────┤
│ 选择器键  │ 总次数│ 成功率│ 主选择器│ 降级率│ 操作           │
├──────────┼──────┼──────┼──────┼──────┼─────────────────┤
│ menu_    │ 120  │ 98%  │ 95%  │ 3%   │ [编辑] [测试]   │
│ creator  │      │      │      │      │                 │
│ _home    │      │      │      │      │                 │
├──────────┼──────┼──────┼──────┼──────┼─────────────────┤
│ region_  │ 85   │ 82%  │ 70%  │ 12%  │ [编辑] [测试]   │
│ work_    │      │      │      │      │ ⚠️ 建议提升      │
│ list     │      │      │      │      │ fallback_1      │
├──────────┼──────┼──────┼──────┼──────┼─────────────────┤
│ ⚠️ page  │ 15   │ N/A  │ N/A  │ N/A  │ [查看调用栈]    │
│ (bypass) │      │      │      │      │ 待收口盲区       │
└──────────┴──────┴──────┴──────┴──────┴─────────────────┘
│  [📥 导出健康报告] [🔄 批量测试选择器]                    │
└─────────────────────────────────────────────────────────┘
```

### 8.4 Tab 4：配置管理

```
┌─────────────────────────────────────────────────────────┐
│  配置快照                                                │
│  [📸 创建快照] [📥 导出配置] [📤 导入配置]                │
├─────────────────────────────────────────────────────────┤
│  ┌─────┬──────┬──────┬──────┬──────┬──────┬──────┐     │
│  │ 名称 │ 平台 │ 类型 │ 版本 │ 创建时间│ 状态 │ 操作  │     │
│  ├─────┼──────┼──────┼──────┼──────┼──────┼──────┤     │
│  │ 手动 │ 抖音 │ 全部 │ v3  │ 14:00 │ 生效中│ [回滚]│     │
│  │ 自动 │ 抖音 │ 选择器│ v2  │ 13:00 │ 历史 │ [回滚]│     │
│  └─────┴──────┴──────┴──────┴──────┴──────┴──────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## 九、执行模式实现

### 9.1 业务代码形态（最终版）

```typescript
// 1. 子步骤入口标记上下文
MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'expandMenu');

// 2. 选择器配置化 + 多路降级 + 防蜜罐
const menuConfig = SelectorRegistry.get('douyin.monitor.menu_creator_home');
await HumanActions.clickWithFallback(page, menuConfig, {
  onFallbackTriggered: (failedSel, successSel, selectorKey) => {
    AlertService.warn(`[抖音] ${selectorKey} 主选择器失效，已降级使用 ${successSel}`);
  }
});

// 3. URL 旁路收集 + 队列消费（无竞态）
interceptor.attachByConfig(page, 'douyin', ['video_list']);
// ... 滚动操作 ...
const videoData = await interceptor.waitForNext('video_list', 15000);

// 4. 子步骤退出，自动汇总健康数据
MaintenanceProbe.exitStep();
```

### 9.2 未收口代码的处理

对于尚未收口到 HumanActions 的平台代码（快手/小红书/视频号）：

1. `PageProxy` 自动捕获 `page.evaluate` / `page.$` 等旁路调用
2. 写入 `maintenance_selector_record`，标记 `selectorSource: 'bypass_detected'`
3. UI 上显示为 "⚠️ 待收口盲区"，附带调用栈
4. 不影响业务流程正常执行

---

## 十、补充能力

### 10.1 自动降级建议

- 选择器健康面板中，当 primary 成功率 < 80% 且 fallback_1 成功率 > 95% 时，自动显示 "建议提升 fallback_1 为 primary"
- 一键确认后自动更新 `selectors.json` 并创建配置快照

### 10.2 配置快照与回滚

- 修改 `selectors.json` 前自动保存快照
- CAS 乐观锁防止并发脏写
- 回滚 = 创建新版本记录（版本链，不物理覆盖）

### 10.3 配置导出/导入

- 导出：将指定平台的 selectors（含 apiMonitors）+ flow_rules 打包为 JSON
- 导入：校验格式后合并/覆盖，自动创建快照
- 用途：dev → prod 环境迁移

---

## 十一、范围与约束

### 11.1 当前范围

- 抖音平台作为样板，完整实现探针 + 维护 UI
- 其他平台通过 PageProxy 旁路报警兜底，后续按样板跟进
- Debug 快照有熔断机制（采样率 + TTL + 上限）

### 11.2 不在范围内

- 方案B（声明式工作流引擎）— 下一阶段
- 实时追踪（执行过程中实时看节点推进）— 当前仅事后查看
- 跨平台对比 — 各平台流程独立，无需对比

### 11.3 性能约束

- 探针开销 < 3%（JSON 序列化 + 异步写入）
- Debug 模式下额外开销 < 10%（快照采样率 20%）
- MaintenanceCollector 异步批量 flush，不阻塞主流程

### 11.4 安全约束（m5 修正）

> **m5 修正**：Debug 快照存储前必须进行令牌清洗。

Debug 快照（DOM HTML / 响应体 JSON）可能包含认证令牌（`csrf_token`、`session_key`、`authorization`、`ticket`）。存储前必须经过正则清洗层：

```typescript
const TOKEN_PATTERNS = [
  /csrf_token['":\s]*['"]([\w-]+)['"]/gi,
  /session_id['":\s]*['"]([\w-]+)['"]/gi,
  /authorization['":\s]*['"](Bearer\s+[\w-]+)['"]/gi,
  /ticket['":\s]*['"]([\w-]+)['"]/gi,
  /X-Token['":\s]*['"]([\w-]+)['"]/gi,
];

function sanitizeSnapshot(content: string, mimeType: string): string {
  let sanitized = content;
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => match.replace(/([\w-]{4})[\w-]+/, '$1***REDACTED***'));
  }
  return sanitized;
}
```

日志记录哪些模式被清洗，但不存储原始令牌。

### 11.5 selectors.json 迁移策略（M2 修正）

> **M2 修正**：现有 `selectors.json` 结构（`platforms.douyin.menus.menu_home`）与新结构（`douyin.monitor.menu_creator_home`）不兼容。

**迁移策略**：保留旧结构兼容层，逐步迁移：

1. 新字段（`strategy`、`anti_honeypot`、`scope`）作为可选字段添加到现有条目
2. 不进行破坏性重组，现有 `menus`/`buttons`/`regions`/`textboxes` 分类保留
3. 新增 `apiMonitors` 顶级键（与现有 `urlMonitors` 并存，逐步合并）
4. `SelectorReader` 同时支持新旧字段，优先读取新字段
5. 编写迁移脚本将旧结构逐步转换为新结构（可选，非阻塞）

### 11.6 探针数据传输通道（C3 修正）

```
MaintenanceProbe (浏览器进程)
    ↓ Redis LPUSH (probe_events list)
MaintenanceCollector (API Gateway 进程)
    ↓ BRPOP 消费 (5 秒轮询)
    ↓ 批量 flush
Prisma DB
```

回退方案：Redis 不可用时，`MaintenanceProbe` 静默丢弃事件（不阻塞业务流程）。

---

## 十二、关联文档

- 抖音 v2 反检测收口计划: `docs/superpowers/plans/2026-06-25-anti-detection-douyin-pilot-plan.md`
- 选择器提取脚本: `scripts/selectors-extracted.json`
- 现有选择器配置: `apps/ts-api-gateway/data/selectors.json`
- Prisma Schema: `prisma/schema.prisma`
