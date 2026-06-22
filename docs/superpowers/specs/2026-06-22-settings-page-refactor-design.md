# 设置页重构设计文档

> **日期**: 2026-06-22
> **状态**: 已批准（设计阶段）
> **子项目**: 子项目1 — 设置页重构（子项目2: 流程图状态机迁移后续进行）

## 1. 背景与问题

当前设置页 `apps/admin-dashboard/src/app/settings/page.tsx` 是一个 1967 行的单体组件，包含 8 个面板全部内联在一个文件中。此外还有一个独立的 `/settings/selectors` 路由（102 行）用于流程图编辑。

问题：
- 单文件过大，难以维护和导航
- 选择器配置分散在两个页面（settings 内联表格 + selectors 独立流程图）
- AI 回复评论参数（模型名、提示词、温度、Token）硬编码在 `prompts.ts`，无法通过 UI 调整
- 监控调度周期是全局配置，无法按平台区分
- 爬取模式虽有 API 但 UI 散落在 settings 内联

## 2. 目标

将设置页重构为 4 个 Tab 页面，按功能域划分，同时将关键硬编码配置外部化到 UI 可管理的位置。

## 3. Tab 划分

### Tab 1: 通用设置 (GeneralTab)
4 个内部板块，用 `ConfigSection` 卡片容器包裹：
- **基础设施变量** — DB/Redis 环境变量（从现有 panel-infra 提取）
- **网络路由与物理代理** — 下载代理 / RapidAPI / API 映射（从 panel-network 提取）
- **企业微信与通知路由** — WeCom 配置 / 通知渠道 / 触发规则（从 panel-notification 提取）
- **权限安全与审计** — API 密钥 / RBAC / 审计日志（从 panel-security 提取）

### Tab 2: 智能创作 (CreationTab)
- **智能创作与媒体渲染** — FFmpeg 参数 / 媒体引擎配置（从 panel-media 提取）

### Tab 3: 大模型管理设置 (LlmTab)
- **LLM 路由与凭证** — Groq / Gemini / 智谱（从 panel-llm-creds 提取）
- **参数与工作组** — 视频/图片/文本路由 + 提示词模板（从 panel-llm-workspace 提取）

### Tab 4: 社媒矩阵设置 (MatrixTab)
- **选择器与流程规则** — FlowGraphView 组件从 `/settings/selectors` 迁入（合并为一个整体，选择器在流程中工作）
- **爬取模式** — 各平台 deep/light，默认全选 deep（从现有 CrawlModePanel 提取）
- **监控调度周期** — 全局默认 + 按平台覆盖（新建，外部化）
- **AI 回复评论配置** — 模型名 / 系统提示词 / temperature / maxTokens（新建，从 prompts.ts 外部化）

## 4. 文件架构

### 4.1 目录结构

```
apps/admin-dashboard/src/app/settings/
├── page.tsx                      # ~80行，Tab bar + 条件渲染
├── tabs/
│   ├── GeneralTab.tsx            # ~400行，4 个板块
│   ├── CreationTab.tsx           # ~150行，FFmpeg/媒体渲染
│   ├── LlmTab.tsx                # ~350行，LLM 凭证 + 参数工作组
│   └── MatrixTab.tsx             # ~500行，FlowGraphView + 3 个面板
└── components/
    ├── ConfigSection.tsx         # 新建，板块容器组件（标题 + 内容区 + 折叠）
    ├── FlowGraphView.tsx         # 从 selectors/page.tsx 迁入
    ├── FlowNodeCard.tsx          # 从 selectors/ 迁入
    ├── NodeDrawer.tsx            # 从 selectors/ 迁入
    ├── FrameworkManager.tsx      # 从 selectors/ 迁入
    ├── ApiPatternManager.tsx     # 从 selectors/ 迁入
    ├── DataSourceManager.tsx     # 从 selectors/ 迁入
    ├── SelectorEditor.tsx        # 从 selectors/ 迁入
    ├── FieldMappingEditor.tsx    # 从 selectors/ 迁入
    ├── CrawlModePanel.tsx        # 从 settings/page.tsx 提取
    ├── MonitorSchedulePanel.tsx  # 新建
    └── AiReplyConfigPanel.tsx    # 新建
```

### 4.2 settings/page.tsx 结构

```tsx
// ~80行
'use client';
import { useState } from 'react';
import GeneralTab from './tabs/GeneralTab';
import CreationTab from './tabs/CreationTab';
import LlmTab from './tabs/LlmTab';
import MatrixTab from './tabs/MatrixTab';

type TabKey = 'general' | 'creation' | 'llm' | 'matrix';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <div>
      {/* Tab bar — 与社媒矩阵页面风格一致 */}
      <div className="inline-flex gap-1 p-1 rounded-xl bg-surface-container">
        <TabButton active={activeTab === 'general'} onClick={() => setActiveTab('general')}
          icon="settings" label="通用设置" />
        <TabButton active={activeTab === 'creation'} onClick={() => setActiveTab('creation')}
          icon="movie" label="智能创作" />
        <TabButton active={activeTab === 'llm'} onClick={() => setActiveTab('llm')}
          icon="smart_toy" label="大模型管理" />
        <TabButton active={activeTab === 'matrix'} onClick={() => setActiveTab('matrix')}
          icon="smartphone" label="社媒矩阵" />
      </div>

      {/* 条件渲染 */}
      {activeTab === 'general' && <GeneralTab />}
      {activeTab === 'creation' && <CreationTab />}
      {activeTab === 'llm' && <LlmTab />}
      {activeTab === 'matrix' && <MatrixTab />}
    </div>
  );
}
```

Tab 切换使用 `useState`（与社媒矩阵页面一致），不引入 URL query param。刷新回到默认第一个 Tab（通用设置）。

### 4.3 路由变更

- `/settings/selectors` → 301 重定向到 `/settings`（在 `next.config.js` 的 `redirects()` 中配置）
- 侧边栏（`Sidebar.tsx`）移除 `选择器配置` 条目，只保留 `系统设置`（`/settings`）

### 4.4 数据层不变

`useApi.ts` 中的 hooks 不改动。各 Tab 组件直接调用现有 hooks：
- GeneralTab: `useConfigInfra`, `useConfigNetwork`, `useConfigNotification`, `useConfigSecurity`
- CreationTab: `useConfigMedia`
- LlmTab: `useLlmConfig`, `useLlmGroups`
- MatrixTab: `useNavigationFlows`, `useFrameworks`, `useApiPatterns`, `useDataSources`, `useCrawlSettings`, `useAutomationConfig`

新增 hooks（在 `useApi.ts` 中添加）：
- `useAiReplyConfig()` — GET/PUT `/api/v1/config-ai-reply`

## 5. 后端 API 变更

### 5.1 新增：AI 回复评论配置 API

**文件**: `apps/ts-api-gateway/src/routes/config-ai-reply.ts`（新建）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v1/config-ai-reply` | GET | 获取 AI 回复配置 |
| `/api/v1/config-ai-reply` | PUT | 更新 AI 回复配置 |

**数据结构**:
```typescript
interface AiReplyConfig {
  model: string;           // 默认 "group-stable-text"
  systemPrompt: string;    // 默认 SIMPLE_CS_SYSTEM_PROMPT
  temperature: number;     // 默认 0.7
  maxTokens: number;       // 默认 300
}
```

**存储**: 内存变量（与 config-automation 一致），重启后回到 prompts.ts 硬编码默认值。

**读取方**: `llmService.ts` 中 `CommentReplyGenerator` 改为读取外部配置，fallback 到 `prompts.ts` 的 `LLM_DEFAULTS`：

```typescript
// llmService.ts 修改
import { getAiReplyConfig } from '../routes/config-ai-reply';

class CommentReplyGenerator {
  private getConfig() {
    try {
      return getAiReplyConfig(); // 优先读外部配置
    } catch {
      return LLM_DEFAULTS; // fallback 到硬编码
    }
  }
}
```

**注册路由**: 在 `index.ts` 中 `app.use('/api/v1/config-ai-reply', configAiReplyRouter)`。

### 5.2 扩展：按平台监控调度周期

**文件**: `apps/ts-api-gateway/src/routes/config-automation.ts`（修改）

在现有 `AUTOMATION.monitor` 下新增 `platformOverrides` 字段：

```typescript
let AUTOMATION = {
  monitor: {
    // 全局默认（保持不变）
    interval_active_min: 180, interval_active_max: 300,
    interval_idle_min: 900, interval_idle_max: 1200,
    idle_threshold: 4, sleep_start_hour: 2, sleep_end_hour: 8,
    // 新增：按平台覆盖（可选字段，不设置则使用全局默认）
    platformOverrides: {} as Record<string, Partial<{
      interval_active_min: number;
      interval_active_max: number;
      interval_idle_min: number;
      interval_idle_max: number;
      idle_threshold: number;
    }>>,
  },
  browser: { max_tab_reuse: 20, enable_warmup: true },
};
```

**PUT 端点变更**: `PUT /api/v1/config-automation` 的 body 可带 `monitor.platformOverrides`，触发 `restartMonitorScheduler()`。

### 5.3 修改：monitorService.ts 调度器读取按平台配置

**文件**: `apps/ts-api-gateway/src/services/monitorService.ts`（修改）

`getMonitorConfig()` 改为接受 `platform` 参数：

```typescript
function getMonitorConfig(platform?: string) {
  try {
    const { getAutomationConfig } = require('../routes/config-automation');
    const config = getAutomationConfig();
    const overrides = platform ? config.monitor?.platformOverrides?.[platform] : undefined;
    return {
      activeMin: overrides?.interval_active_min ?? config.monitor?.interval_active_min ?? 180,
      activeMax: overrides?.interval_active_max ?? config.monitor?.interval_active_max ?? 300,
      idleMin: overrides?.interval_idle_min ?? config.monitor?.interval_idle_min ?? 900,
      idleMax: overrides?.interval_idle_max ?? config.monitor?.interval_idle_max ?? 1200,
      idleThreshold: overrides?.idle_threshold ?? config.monitor?.idle_threshold ?? 4,
    };
  } catch {
    return { activeMin: 180, activeMax: 300, idleMin: 900, idleMax: 1200, idleThreshold: 4 };
  }
}
```

`getRandomIntervalForMode()` 改为接受 `platform` 参数并传递给 `getMonitorConfig(platform)`。

调用点（每个平台的调度循环中）传入对应的 platform 名称。

### 5.4 已有：爬取模式 API（无改动）

已有 `GET/PUT /matrix/monitor/crawl-settings/:platform`。`CrawlSetting` 表为空时返回默认 `'deep'`。前端 UI 初始化时确保所有平台默认显示 `deep`。

## 6. 新建组件规格

### 6.1 ConfigSection.tsx

通用板块容器，用于 GeneralTab 内部的 4 个板块：

```typescript
interface ConfigSectionProps {
  title: string;
  description?: string;
  icon?: string;        // Material Icon name
  defaultExpanded?: boolean;
  children: React.ReactNode;
}
```

功能：可折叠的卡片容器，标题 + 描述 + 展开/折叠按钮 + 内容区。

### 6.2 MonitorSchedulePanel.tsx

```typescript
// 示意
function MonitorSchedulePanel() {
  const { data: automation } = useAutomationConfig();
  const updateMutation = useUpdateAutomationConfig();

  // 全局默认编辑（active min/max, idle min/max, idle_threshold）
  // 按平台覆盖编辑（4 个平台，每个可设置独立覆盖或"使用全局"）
  // 保存时 PUT /api/v1/config-automation { monitor: { platformOverrides: {...} } }
}
```

UI 结构：
- 顶部：全局默认参数编辑区（4 个数字输入框 + idle_threshold）
- 下方：4 个平台行，每行显示当前生效值（覆盖值或"使用全局"），点击展开可编辑覆盖值

### 6.3 AiReplyConfigPanel.tsx

```typescript
function AiReplyConfigPanel() {
  const { data, isLoading } = useAiReplyConfig();
  const updateMutation = useUpdateAiReplyConfig();

  // 4 个字段：model (text input), systemPrompt (textarea), temperature (number), maxTokens (number)
  // 保存按钮 → PUT /api/v1/config-ai-reply
  // 重置按钮 → 恢复到 prompts.ts 硬编码默认值
}
```

UI 结构：
- 模型名：文本输入框
- Temperature / Max Tokens：数字输入框（并排）
- 系统提示词：多行文本框（min-height 200px）
- 底部：保存 + 重置按钮

## 7. 迁移策略

### 7.1 从 settings/page.tsx 提取到各 Tab

1. 先创建 `tabs/` 目录和 4 个 Tab 文件骨架
2. 逐个面板提取：将 panel-infra 的 JSX + 相关状态/handlers 移入 GeneralTab
3. 保留原有的 hooks 调用方式，不改变数据流
4. 提取共享子组件（BentoCard、StatusPill 等）到 components/

### 7.2 从 selectors/page.tsx 迁入 FlowGraphView

1. 将 FlowGraphView.tsx 及其子组件（FlowNodeCard、NodeDrawer、FrameworkManager、ApiPatternManager、DataSourceManager、SelectorEditor、FieldMappingEditor）移到 `settings/components/`
2. MatrixTab 中直接 import 使用
3. 删除 `settings/selectors/page.tsx`
4. 在 `next.config.js` 添加重定向

### 7.3 迁移顺序

1. 创建目录结构和 Tab 骨架
2. 提取 GeneralTab（最大量但最机械）
3. 提取 CreationTab（最简单）
4. 提取 LlmTab
5. 迁入 FlowGraphView + 提取 CrawlModePanel → MatrixTab 骨架
6. 新建 MonitorSchedulePanel + AiReplyConfigPanel
7. 后端：新建 config-ai-reply 路由 + 修改 config-automation + 修改 monitorService
8. 路由重定向 + 侧边栏修改
9. 删除旧文件

## 8. 范围边界

### 本子项目包含
- 设置页 4-Tab 拆分
- FlowGraphView 从 /settings/selectors 迁入 MatrixTab（不改动 FlowGraphView 内部逻辑）
- 新增 AI 回复配置外部化（config-ai-reply API + AiReplyConfigPanel）
- 新增按平台监控调度周期（platformOverrides + MonitorSchedulePanel）
- 爬取模式 UI 从 settings 内联提取为独立组件

### 本子项目不包含
- 流程图分支补全（38+ 条件分支）— 子项目2
- FlowGraphView 的 XState 状态机迁移 — 子项目2
- FlowGraphView 渲染逻辑改造 — 子项目2
- 后端爬虫/监控逻辑改动（除 getMonitorConfig 按平台读取外）
- 数据库 schema 变更
- useApi.ts 中已有 hooks 的重构

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 提取过程中遗漏状态/handlers | 逐面板提取，每提取一个 Tab 后在浏览器中验证功能正常 |
| FlowGraphView 迁入后 import 路径断裂 | 移动文件时使用 IDE 重构功能，批量更新 import |
| config-ai-reply 内存存储重启丢失 | 设计如此，与 config-automation 一致；prompts.ts 作为 fallback 保证可用 |
| platformOverrides 影响调度器行为 | 调度器 fallback 逻辑保证未配置平台使用全局默认 |
| 旧 /settings/selectors 书签失效 | 301 重定向到 /settings |
