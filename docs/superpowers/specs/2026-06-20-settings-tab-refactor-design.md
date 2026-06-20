# 设置页 Tab 重构设计

> **子项目 1**（共 2 个子项目）
> 子项目 2：流程图 XState 状态机迁移（独立规格，后续编写）

## 背景

当前设置页 `settings/page.tsx` 是一个 1967 行的单体组件，包含 8 个面板（基础设施、LLM 凭证、LLM 参数、媒体渲染、自动化核心、网络代理、企微通知、权限安全），全部内联在一个文件中。另有独立的 `/settings/selectors` 页面承载流程图编辑器。

社媒矩阵功能已完善，设置页需按功能板块重新组织为 4 个 Tab 页面，并将部分硬编码配置外部化到 UI 中。

## 目标

1. 将 1967 行单文件拆分为 4 个 Tab 组件，按功能板块划分
2. 选择器与流程规则合并为一个整体板块（选择器在流程中工作）
3. AI 回复评论配置从 `prompts.ts` 硬编码外部化到 UI
4. 爬取模式按平台独立配置（已有 API，接入 UI）
5. 监控调度周期支持按平台覆盖（扩展后端 + 新建 UI）
6. 废弃 `/settings/selectors` 独立路由

## Tab 划分

### Tab 1: 通用设置 (`GeneralTab`)

4 个内部板块，每个用 `ConfigSection` 卡片容器包裹：

| 板块 | 内容 | 数据来源 |
|------|------|----------|
| 基础设施变量 | DB/Redis 环境变量 | `GET/PUT /api/v1/config-infra` |
| 网络路由与物理代理 | 下载代理 / RapidAPI / API 映射 | `GET/PUT /api/v1/config-network` |
| 企业微信与通知路由 | WeCom 配置 / 通知渠道 / 触发规则 | 现有通知配置 API |
| 权限安全与审计 | API 密钥 / RBAC / 审计日志 | 现有安全配置 API |

### Tab 2: 智能创作 (`CreationTab`)

| 板块 | 内容 | 数据来源 |
|------|------|----------|
| 智能创作与媒体渲染 | FFmpeg 参数 / 媒体引擎配置 | `GET/PUT /api/v1/config-media` |

### Tab 3: 大模型管理设置 (`LlmTab`)

| 板块 | 内容 | 数据来源 |
|------|------|----------|
| LLM 路由与凭证 | Groq / Gemini / 智谱 | `GET/PUT /api/v1/llm/groups` |
| 参数与工作组 | 视频/图片/文本路由 + 提示词模板 | `GET/PUT /api/v1/llm/groups` |

### Tab 4: 社媒矩阵设置 (`MatrixTab`)

| 板块 | 内容 | 数据来源 | 状态 |
|------|------|----------|------|
| 选择器与流程规则 | FlowGraphView（平台 tab + 流程 tab + 框架/API Pattern/DataSource 管理） | `GET/PUT /api/v1/config-automation/navigation-flows/:platform` 等 | 从 `/settings/selectors` 迁入 |
| 爬取模式 | 4 平台 deep/light 切换 | `GET/PUT /api/v1/matrix/monitor/crawl-settings/:platform` | 已有 API，提取组件 |
| 监控调度周期 | 全局默认 + 按平台覆盖 | `GET/PUT /api/v1/config-automation`（扩展 `monitor.platformOverrides`） | 🆕 新建 |
| AI 回复评论配置 | 模型名 / 系统提示词 / temperature / maxTokens | `GET/PUT /api/v1/config-ai-reply` | 🆕 新建 |

## 文件架构

```
apps/admin-dashboard/src/app/settings/
├── page.tsx                    # ~80行：Tab bar + 条件渲染
├── tabs/
│   ├── GeneralTab.tsx          # ~400行：4 个板块
│   ├── CreationTab.tsx         # ~150行：媒体渲染
│   ├── LlmTab.tsx              # ~350行：LLM 凭证 + 参数
│   └── MatrixTab.tsx           # ~500行：FlowGraphView + 3 个面板
├── components/
│   ├── ConfigSection.tsx       # 新建：板块容器（标题 + 描述 + 内容区）
│   ├── CrawlModePanel.tsx      # 提取：从 page.tsx 提取
│   ├── MonitorSchedulePanel.tsx# 新建：全局默认 + 按平台覆盖
│   └── AiReplyConfigPanel.tsx  # 新建：模型名/提示词/温度/Token
└── selectors/                  # 保留：FlowGraphView 及子组件不改动
    ├── FlowGraphView.tsx
    ├── FlowNodeCard.tsx
    ├── NodeDrawer.tsx
    ├── SelectorEditor.tsx
    ├── FrameworkManager.tsx
    ├── ApiPatternManager.tsx
    ├── DataSourceManager.tsx
    └── FieldMappingEditor.tsx
```

### 拆分原则

- **Tab 组件独立文件** — 每个 Tab 一个文件，内部板块用子组件或内联 JSX
- **共享子组件提取** — `BentoCard`、`StatusPill` 等从 1967 行文件提取到 `components/`
- **FlowGraphView 不改动** — 从 `selectors/` 目录导入，子项目 2 再改造
- **数据层不变** — `useApi.ts` hooks 不改动，Tab 组件直接调用现有 hooks

## 路由变更

### 侧边栏

`Sidebar.tsx` 当前有两个设置入口：
- `/settings/selectors` → 选择器配置
- `/settings` → 系统设置

变更后只保留一个入口：
- `/settings` → 系统设置

### 重定向

`/settings/selectors` → 301 重定向到 `/settings`。

实现方式：在 `settings/selectors/page.tsx` 中使用 Next.js `redirect()` 函数（App Router 原生方式），删除原有的 FlowGraphView 渲染逻辑。

### Tab 状态管理

使用 `useState` 管理（和社媒矩阵页面一致），不引入 URL query param。刷新回到默认第一个 Tab（通用设置）。

## 后端 API 变更

### 1. AI 回复评论配置（新增）

**新文件：** `apps/ts-api-gateway/src/routes/config-ai-reply.ts`

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v1/config-ai-reply` | GET | 获取 AI 回复配置 |
| `/api/v1/config-ai-reply` | PUT | 更新 AI 回复配置 |

**数据结构：**

```typescript
interface AiReplyConfig {
  model: string;           // 默认 "group-stable-text"
  systemPrompt: string;    // 默认 SIMPLE_CS_SYSTEM_PROMPT
  temperature: number;     // 默认 0.7
  maxTokens: number;       // 默认 300
}
```

**存储方式：** 内存（和现有 `config-automation` 一致），进程重启后回到默认值。

**后端消费：** `llmService.ts` 的 `CommentReplyGenerator` 读取时优先用外部配置（通过 `getAiReplyConfig()` 函数），fallback 到 `prompts.ts` 的 `LLM_DEFAULTS` 硬编码默认值。

**注册路由：** 在 `index.ts` 中 `app.use('/api/v1/config-ai-reply', configAiReplyRouter)`。

### 2. 按平台爬取模式（已有，无后端改动）

已有 API：
- `GET /api/v1/matrix/monitor/crawl-settings` — 获取所有平台
- `PUT /api/v1/matrix/monitor/crawl-settings/:platform` — 更新单个平台

`CrawlSetting` 表为空时 `getCrawlMode()` 返回默认 `'deep'`。前端 UI 需正确初始化所有平台为 `deep`。

### 3. 按平台监控调度周期（扩展）

**改动文件：** `apps/ts-api-gateway/src/routes/config-automation.ts`

在 `AUTOMATION.monitor` 下新增 `platformOverrides` 字段：

```typescript
let AUTOMATION = {
  monitor: {
    // 全局默认（保持不变）
    interval_active_min: 180, interval_active_max: 300,
    interval_idle_min: 900, interval_idle_max: 1200,
    idle_threshold: 4, sleep_start_hour: 2, sleep_end_hour: 8,
    // 新增：按平台覆盖
    platformOverrides: {} as Record<string, Partial<{
      interval_active_min: number; interval_active_max: number;
      interval_idle_min: number; interval_idle_max: number;
      idle_threshold: number;
    }>>,
  },
  browser: { max_tab_reuse: 20, enable_warmup: true },
};
```

`PUT /api/v1/config-automation` 的 body 中带 `monitor.platformOverrides` 即可更新。

**改动文件：** `apps/ts-api-gateway/src/services/monitorService.ts`

`getMonitorConfig()` 改为接受 `platform` 参数：

```typescript
function getMonitorConfig(platform?: string) {
  const config = getAutomationConfig();
  const overrides = platform ? config.monitor?.platformOverrides?.[platform] : undefined;
  return {
    activeMin: overrides?.interval_active_min ?? config.monitor?.interval_active_min ?? 180,
    activeMax: overrides?.interval_active_max ?? config.monitor?.interval_active_max ?? 300,
    idleMin: overrides?.interval_idle_min ?? config.monitor?.interval_idle_min ?? 900,
    idleMax: overrides?.interval_idle_max ?? config.monitor?.interval_idle_max ?? 1200,
    idleThreshold: overrides?.idle_threshold ?? config.monitor?.idle_threshold ?? 4,
  };
}
```

`getRandomIntervalForMode()` 改为接受 `platform` 参数，调用 `getMonitorConfig(platform)`。

所有调用 `getRandomIntervalForMode` 的地方传入当前平台的 platform 字符串。

## 前端组件设计

### ConfigSection（新建）

通用板块容器，所有 Tab 内部板块使用：

```tsx
interface ConfigSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;  // 右上角操作按钮
}
```

### CrawlModePanel（提取）

从 `settings/page.tsx` 的 `CrawlModePanel`（约 1884-1967 行）提取为独立组件。

功能：列出 4 个平台，每个平台有 deep/light 切换，保存按钮调用 `PUT /api/v1/matrix/monitor/crawl-settings/:platform`。

### MonitorSchedulePanel（新建）

两部分布局：

1. **全局默认** — 显示/编辑 `interval_active_min/max`、`interval_idle_min/max`、`idle_threshold`
2. **按平台覆盖** — 4 个平台各一行，可展开编辑覆盖值，或选择"使用全局"

数据通过 `GET/PUT /api/v1/config-automation` 读写 `monitor` 字段。

### AiReplyConfigPanel（新建）

4 个表单字段：

| 字段 | 类型 | 默认值 |
|------|------|--------|
| 回复用大模型名 | 文本输入 | `group-stable-text` |
| Temperature | 数字输入 | 0.7 |
| Max Tokens | 数字输入 | 300 |
| 系统提示词 | 多行文本 | `SIMPLE_CS_SYSTEM_PROMPT` 内容 |

数据通过 `GET/PUT /api/v1/config-ai-reply` 读写。

### MatrixTab 组合

```tsx
function MatrixTab() {
  return (
    <div className="space-y-6">
      <ConfigSection title="选择器与流程规则" description="CSS 选择器 + 流程图编辑器">
        <FlowGraphView />
      </ConfigSection>
      <div className="grid grid-cols-2 gap-6">
        <ConfigSection title="爬取模式" description="各平台 deep/light">
          <CrawlModePanel />
        </ConfigSection>
        <ConfigSection title="监控调度周期" description="全局默认 + 按平台覆盖">
          <MonitorSchedulePanel />
        </ConfigSection>
      </div>
      <ConfigSection title="AI回复评论配置" description="从硬编码外部化">
        <AiReplyConfigPanel />
      </ConfigSection>
    </div>
  );
}
```

## useApi.ts 新增 hooks

```typescript
// AI 回复配置
function useAiReplyConfig(): UseQueryResult<AiReplyConfig>;
function useUpdateAiReplyConfig(): UseMutationResult;

// 按平台调度覆盖（扩展现有 useAutomationConfig）
// 现有 useAutomationConfig 已返回 monitor 字段，前端直接读写 monitor.platformOverrides
```

## 不在范围内

以下内容属于子项目 2，不在本规格中：

- FlowGraphView 分支渲染改造
- selectors.json 中 navigationFlows 的 38+ 条件分支补全
- XState 状态机模型替换现有 flow 定义
- NodeDrawer 编辑能力增强

## 验收标准

1. `/settings` 页面显示 4 个 Tab，切换正常
2. 通用设置 Tab 包含 4 个板块（基础设施/网络/通知/安全），功能与重构前一致
3. 智能创作 Tab 包含媒体渲染配置，功能与重构前一致
4. 大模型管理 Tab 包含 LLM 凭证 + 参数工作组，功能与重构前一致
5. 社媒矩阵 Tab 包含 FlowGraphView + 爬取模式 + 调度周期 + AI回复配置
6. `/settings/selectors` 自动重定向到 `/settings`
7. 侧边栏只有一个"系统设置"入口
8. AI 回复配置（模型名/提示词/温度/Token）可在 UI 中编辑并保存
9. 修改 AI 回复配置后，`llmService.ts` 生成回复时使用新配置
10. 监控调度周期可按平台覆盖，修改后调度器使用新配置
11. 爬取模式按平台切换 deep/light 后，监控器使用新模式
12. `settings/page.tsx` 不再超过 100 行
