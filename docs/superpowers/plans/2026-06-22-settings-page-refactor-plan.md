# 设置页重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 1966 行单文件设置页拆分为 4 个 Tab 组件，迁入 FlowGraphView，外部化 AI 回复配置和按平台调度周期。

**架构：** 前端 CSS display 切换保持 Tab 挂载；后端新增 `lib/aiReplyConfig.ts` 独立配置存储 + `config-ai-reply` 路由；`config-automation` 扩展 `platformOverrides`；`monitorService` 按平台读取调度配置；`llmService` 两处读取外部配置。

**技术栈：** Next.js 14 App Router, Tailwind CSS, React Query v5, Express, TypeScript

**规格文档：** `docs/superpowers/specs/2026-06-22-settings-page-refactor-design.md`

---

## 文件结构

### 前端（admin-dashboard）

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/app/settings/page.tsx` | 重写（1966→~80行） | Tab bar + CSS display 切换 |
| `src/app/settings/tabs/GeneralTab.tsx` | 新建 | 基础设施/网络/通知/安全 4 板块 |
| `src/app/settings/tabs/CreationTab.tsx` | 新建 | FFmpeg/媒体渲染 |
| `src/app/settings/tabs/LlmTab.tsx` | 新建 | LLM 凭证 + 参数工作组 |
| `src/app/settings/tabs/MatrixTab.tsx` | 新建 | FlowGraphView + 6 个面板 |
| `src/app/settings/shared/` | 新建目录 | 7 个共享子组件 + constants.ts |
| `src/app/settings/components/` | 新建目录 | FlowGraphView + 子组件 + 新建面板 |
| `src/hooks/useApi.ts` | 修改 | 新增 2 个 hooks |
| `src/app/settings/selectors/page.tsx` | 删除 | 迁移到 components/ |
| `src/components/layout/Sidebar.tsx` | 修改 | 移除 selectors 入口 |
| `next.config.js` | 修改 | 添加 redirects() |

### 后端（ts-api-gateway）

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/lib/aiReplyConfig.ts` | 新建 | AI 回复配置存储（独立模块） |
| `src/routes/config-ai-reply.ts` | 新建 | GET/PUT AI 回复配置 |
| `src/routes/config-automation.ts` | 修改 | platformOverrides + 重启触发 |
| `src/services/monitorService.ts` | 修改 | getMonitorConfig 按平台读取 |
| `src/services/llmService.ts` | 修改 | LLMClient + CommentReplyGenerator 读外部配置 |
| `src/index.ts` | 修改 | 注册 config-ai-reply 路由 |

---

## 任务 1：创建目录结构和 Tab 骨架

**文件：**
- 创建：`apps/admin-dashboard/src/app/settings/shared/constants.ts`
- 创建：`apps/admin-dashboard/src/app/settings/shared/StrategyBadge.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/PanelSkeleton.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/QueryError.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/KeyValueEditor.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/ProviderCard.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/RbacPanel.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/NotificationChannelsPanel.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/shared/utils.ts`
- 创建：`apps/admin-dashboard/src/app/settings/tabs/GeneralTab.tsx`（骨架）
- 创建：`apps/admin-dashboard/src/app/settings/tabs/CreationTab.tsx`（骨架）
- 创建：`apps/admin-dashboard/src/app/settings/tabs/LlmTab.tsx`（骨架）
- 创建：`apps/admin-dashboard/src/app/settings/tabs/MatrixTab.tsx`（骨架）
- 修改：`apps/admin-dashboard/src/app/settings/page.tsx`

- [ ] **步骤 1：提取共享常量到 `shared/constants.ts`**

从 `page.tsx` 第 627-652 行提取以下常量到 `shared/constants.ts`，添加 `export`：
- `INFRA_KEYS`（第 627 行）
- `GROUP_ORDER`（第 628 行）
- `FFMPEG_FIELDS`（第 629-636 行）
- `HOUR_OPTIONS`（第 637 行）
- `MONITOR_FIELDS`（第 638-646 行）
- `BROWSER_FIELDS`（第 647-650 行）
- `RAPIDAPI_PRESEED`（第 651 行）
- `HOSTS_PRESEED`（第 652 行）

- [ ] **步骤 2：提取共享子组件到 `shared/`**

从 `page.tsx` 提取以下内联组件，每个到独立文件，添加 `export`：
- `StrategyBadge`（第 108-139 行）→ `shared/StrategyBadge.tsx`
- `PanelSkeleton`（第 141-156 行）→ `shared/PanelSkeleton.tsx`
- `QueryError`（第 158-165 行）→ `shared/QueryError.tsx`
- `KeyValueEditor`（第 167-234 行）→ `shared/KeyValueEditor.tsx`
- `ProviderCard`（第 240-321 行）→ `shared/ProviderCard.tsx`
- `RbacPanel`（第 327-492 行）→ `shared/RbacPanel.tsx`
- `NotificationChannelsPanel`（第 498-614 行）→ `shared/NotificationChannelsPanel.tsx`
- `statusPillFor`（第 616-620 行）+ `maskKey`（第 622-625 行）→ `shared/utils.ts`

- [ ] **步骤 3：创建 4 个 Tab 骨架文件**

```tsx
// tabs/GeneralTab.tsx（CreationTab/LlmTab/MatrixTab 同理）
'use client';
export default function GeneralTab() {
  return <div className="space-y-6 p-6"><p>通用设置（待提取）</p></div>;
}
```

- [ ] **步骤 4：重写 `settings/page.tsx` 为 Tab 架构**

将 `page.tsx` 完整替换为以下代码（~80行）：

```tsx
'use client';
import { useState } from 'react';
import GeneralTab from './tabs/GeneralTab';
import CreationTab from './tabs/CreationTab';
import LlmTab from './tabs/LlmTab';
import MatrixTab from './tabs/MatrixTab';

type TabKey = 'general' | 'creation' | 'llm' | 'matrix';

function TabButton({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: string; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all ${
        active ? 'bg-primary/10 text-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      <span className="material-symbols-rounded text-icon-sm">{icon}</span>
      {label}
    </button>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-outline-variant px-6 pt-4 pb-2">
        <h1 className="text-headline-sm font-bold mb-3">系统设置中心</h1>
        <div className="inline-flex gap-1 p-1 rounded-xl bg-surface-container">
          <TabButton active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon="settings" label="通用设置" />
          <TabButton active={activeTab === 'creation'} onClick={() => setActiveTab('creation')} icon="movie" label="智能创作" />
          <TabButton active={activeTab === 'llm'} onClick={() => setActiveTab('llm')} icon="smart_toy" label="大模型管理" />
          <TabButton active={activeTab === 'matrix'} onClick={() => setActiveTab('matrix')} icon="smartphone" label="社媒矩阵" />
        </div>
      </div>
      {/* CSS display 切换 — 保持所有 Tab 挂载，避免表单状态丢失 */}
      <div className="flex-1 overflow-y-auto">
        <div style={{ display: activeTab === 'general' ? 'block' : 'none' }}><GeneralTab /></div>
        <div style={{ display: activeTab === 'creation' ? 'block' : 'none' }}><CreationTab /></div>
        <div style={{ display: activeTab === 'llm' ? 'block' : 'none' }}><LlmTab /></div>
        <div style={{ display: activeTab === 'matrix' ? 'block' : 'none' }}><MatrixTab /></div>
      </div>
    </div>
  );
}
```

- [ ] **步骤 5：验证页面可加载**

运行：`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/settings`
预期：200

- [ ] **步骤 6：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/
git commit -m "refactor: 设置页 Tab 骨架 + 共享子组件提取"
```

---

## 任务 2：提取 GeneralTab

**文件：**
- 修改：`apps/admin-dashboard/src/app/settings/tabs/GeneralTab.tsx`
- 参考：`page.tsx` 第 892-937行(panel-infra)、1631-1677行(panel-network)、1678-1751行(panel-notification)、1752-1925行(panel-security)

- [ ] **步骤 1：提取 panel-infra**

从 `page.tsx` 第 892-937 行的 JSX 移入 `GeneralTab.tsx`。包括：`infraQuery`/`updateInfra` hooks、`infraInitRef` 守卫、`infraForm` 状态、`handleInfraSave` handler。从 `shared/` 导入 `INFRA_KEYS`、`PanelSkeleton`、`QueryError`。

- [ ] **步骤 2：提取 panel-network**

从 `page.tsx` 第 1631-1677 行移入。包括：`networkQuery`/`updateNetwork` hooks、`networkInitRef`、`networkForm` 状态、`handleNetworkSave`、`KeyValueEditor`（从 `shared/` 导入）、`RAPIDAPI_PRESEED`/`HOSTS_PRESEED`（从 `shared/constants.ts` 导入）。

- [ ] **步骤 3：提取 panel-notification**

从 `page.tsx` 第 1678-1751 行移入。包括：`notificationQuery`/`updateNotification` hooks、`notificationInitRef`、`notificationForm` 状态、`NotificationChannelsPanel`（从 `shared/` 导入）。

- [ ] **步骤 4：提取 panel-security**

从 `page.tsx` 第 1752-1925 行移入。包括：`securityQuery`/`updateSecurity`、`apiKeyQuery`/`rotateApiKey`、`rbacQuery`/`createUser`/`deleteUser`、`auditLogQuery` hooks、`RbacPanel`（从 `shared/` 导入）。

- [ ] **步骤 5：验证浏览器中 4 个板块功能正常**

- [ ] **步骤 6：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/tabs/GeneralTab.tsx
git commit -m "refactor: 提取 GeneralTab — 基础设施/网络/通知/安全"
```

---

## 任务 3：提取 CreationTab

**文件：**
- 修改：`apps/admin-dashboard/src/app/settings/tabs/CreationTab.tsx`
- 参考：`page.tsx` 第 1046-1106 行(panel-media)

- [ ] **步骤 1：提取 panel-media**

从 `page.tsx` 第 1046-1106 行移入。包括：`mediaQuery`/`updateMedia` hooks、`mediaInitRef`、`mediaForm` 状态、`handleMediaSave`、`FFMPEG_FIELDS`（从 `shared/constants.ts` 导入）。

- [ ] **步骤 2：验证浏览器中功能正常**

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/tabs/CreationTab.tsx
git commit -m "refactor: 提取 CreationTab — FFmpeg/媒体渲染"
```

---

## 任务 4：提取 LlmTab

**文件：**
- 修改：`apps/admin-dashboard/src/app/settings/tabs/LlmTab.tsx`
- 参考：`page.tsx` 第 938-954行(panel-llm-creds)、955-1045行(panel-llm-workspace)

- [ ] **步骤 1：提取 panel-llm-creds**

从 `page.tsx` 第 938-954 行移入。包括：`llmConfigQuery`/`updateLlmConfig` hooks、`llmCredsInitRef`、`llmCredsForm` 状态、`ProviderCard`（从 `shared/` 导入）。

- [ ] **步骤 2：提取 panel-llm-workspace**

从 `page.tsx` 第 955-1045 行移入。包括：`llmGroupsQuery`/`updateLlmGroups` hooks、`groupsInitRef`、`groupsForm` 状态、`GROUP_ORDER`（从 `shared/constants.ts` 导入）、提示词模板编辑。

- [ ] **步骤 3：验证浏览器中功能正常**

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/tabs/LlmTab.tsx
git commit -m "refactor: 提取 LlmTab — LLM 凭证 + 参数工作组"
```

---

## 任务 5：后端 — AI 回复配置 + 按平台调度

**文件：**
- 创建：`apps/ts-api-gateway/src/lib/aiReplyConfig.ts`
- 创建：`apps/ts-api-gateway/src/routes/config-ai-reply.ts`
- 修改：`apps/ts-api-gateway/src/routes/config-automation.ts`
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`
- 修改：`apps/ts-api-gateway/src/services/llmService.ts`
- 修改：`apps/ts-api-gateway/src/index.ts`

- [ ] **步骤 1：创建 `lib/aiReplyConfig.ts`**

```typescript
import { LLM_DEFAULTS, SIMPLE_CS_SYSTEM_PROMPT } from '../config/prompts';

export interface AiReplyConfig {
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

let aiReplyConfig: AiReplyConfig = {
  model: LLM_DEFAULTS.model,
  systemPrompt: SIMPLE_CS_SYSTEM_PROMPT,
  temperature: LLM_DEFAULTS.temperature,
  maxTokens: LLM_DEFAULTS.maxTokens,
};

export function getAiReplyConfig(): AiReplyConfig {
  return { ...aiReplyConfig };
}

export function setAiReplyConfig(cfg: Partial<AiReplyConfig>): AiReplyConfig {
  if (cfg.model !== undefined) aiReplyConfig.model = cfg.model;
  if (cfg.systemPrompt !== undefined) aiReplyConfig.systemPrompt = cfg.systemPrompt;
  if (cfg.temperature !== undefined) aiReplyConfig.temperature = cfg.temperature;
  if (cfg.maxTokens !== undefined) aiReplyConfig.maxTokens = cfg.maxTokens;
  return getAiReplyConfig();
}
```

- [ ] **步骤 2：创建 `routes/config-ai-reply.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { getAiReplyConfig, setAiReplyConfig } from '../lib/aiReplyConfig';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: getAiReplyConfig() });
});

router.put('/', (req: Request, res: Response) => {
  const { model, systemPrompt, temperature, maxTokens } = req.body;
  const updated = setAiReplyConfig({ model, systemPrompt, temperature, maxTokens });
  res.json({ success: true, data: updated, message: 'AI 回复配置已更新' });
});

export default router;
```

- [ ] **步骤 3：在 `index.ts` 注册路由**

在第 105 行后添加 `import configAiReplyRouter from './routes/config-ai-reply';` 和 `app.use('/api/v1/config-ai-reply', configAiReplyRouter);`

- [ ] **步骤 4：修改 `config-automation.ts` — 添加 platformOverrides**

在第 24-30 行的 `AUTOMATION.monitor` 对象中添加 `platformOverrides` 字段：

```typescript
platformOverrides: {} as Record<string, Partial<{
  interval_active_min: number; interval_active_max: number;
  interval_idle_min: number; interval_idle_max: number;
  idle_threshold: number;
}>>,
```

- [ ] **步骤 5：修改 `config-automation.ts` — 扩展重启触发**

将第 56 行的重启判断扩展为同时检查 `platformOverrides`：

```typescript
if (req.body.monitor && (
  req.body.monitor.interval_idle_min ||
  req.body.monitor.interval_idle_max ||
  req.body.monitor.platformOverrides
)) {
```

- [ ] **步骤 6：修改 `monitorService.ts` — getMonitorConfig 按平台**

将第 1393-1412 行的 `getMonitorConfig` 改为接受 `platform` 参数，优先读取 `platformOverrides[platform]`，fallback 到全局默认。返回值增加 `sleepStartHour`/`sleepEndHour`。详见规格文档第 5.3 节代码。

- [ ] **步骤 7：修改 `monitorService.ts` — getRandomIntervalForMode 传 platform**

将第 1415-1421 行改为接受 `platform` 参数并传递给 `getMonitorConfig(platform)`。更新所有调用点（`getOrCreateSchedulerState` 第 1387 行附近、`scheduleNext` 第 1622 行附近）传入 platform。

- [ ] **步骤 8：修改 `llmService.ts` — LLMClient 读外部配置**

添加 `import { getAiReplyConfig } from '../lib/aiReplyConfig';`。修改 `LLMClient.chatCompletion()`（第 70-91 行附近），将 `LLM_DEFAULTS.temperature`/`maxTokens` 改为 `getAiReplyConfig().temperature`/`maxTokens`。

- [ ] **步骤 9：修改 `llmService.ts` — CommentReplyGenerator 读外部配置**

在 `CommentReplyGenerator` 类中添加 `getConfig()` 方法读取 `getAiReplyConfig()`，fallback 到 `LLM_DEFAULTS`。修改 `generateReply()` 使用 `cfg.model` 和 `cfg.systemPrompt`。

- [ ] **步骤 10：验证后端 API**

```bash
curl -s http://localhost:3001/api/v1/config-ai-reply | jq .
# 预期: { success: true, data: { model: "group-stable-text", ... } }
curl -s http://localhost:3001/api/v1/config-automation | jq .data.monitor.platformOverrides
# 预期: {}
```

- [ ] **步骤 11：Commit**

```bash
git add apps/ts-api-gateway/src/
git commit -m "feat: AI回复配置外部化 + 按平台调度周期"
```

---

## 任务 6：新增前端 hooks

**文件：**
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：添加 hooks**

在 `useApi.ts` 末尾添加：

```typescript
export function useAiReplyConfig() {
  return useQuery({
    queryKey: ['ai-reply-config'],
    queryFn: async () => {
      const res = await api.get('/api/v1/config-ai-reply');
      return res.data.data as { model: string; systemPrompt: string; temperature: number; maxTokens: number; };
    },
  });
}

export function useUpdateAiReplyConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: Partial<{ model: string; systemPrompt: string; temperature: number; maxTokens: number; }>) => {
      const res = await api.put('/api/v1/config-ai-reply', cfg);
      return res.data.data;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-reply-config'] }); },
  });
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat: 添加 useAiReplyConfig + useUpdateAiReplyConfig hooks"
```

---

## 任务 7：提取 MatrixTab — FlowGraphView 迁入 + 面板提取

**文件：**
- 移动：`selectors/` 下 8 个文件 → `components/`
- 创建：`components/CrawlModePanel.tsx`（从 page.tsx 第 1884-1966 行提取）
- 创建：`components/FlowRulesPanel.tsx`（从 page.tsx 第 1506-1628 行提取）
- 创建：`components/BrowserWarmupPanel.tsx`（从 page.tsx 第 1159-1181 行提取）
- 创建：`components/DynamicSelectorPanel.tsx`（从 page.tsx 第 1183-1501 行提取）
- 修改：`tabs/MatrixTab.tsx`

- [ ] **步骤 1：迁入 FlowGraphView 及子组件**

将 `src/app/settings/selectors/` 下 8 个文件移动到 `src/app/settings/components/`：FlowGraphView、FlowNodeCard、NodeDrawer、FrameworkManager、ApiPatternManager、DataSourceManager、SelectorEditor、FieldMappingEditor。相对 import（`./FlowNodeCard` 等）保持不变。

- [ ] **步骤 2：提取 CrawlModePanel**

从 `page.tsx` 第 1884-1966 行提取到 `components/CrawlModePanel.tsx`。包括 `useCrawlSettings`/`useUpdateCrawlSetting` hooks。

- [ ] **步骤 3：提取 FlowRulesPanel**

从 `page.tsx` 第 1506-1628 行提取到 `components/FlowRulesPanel.tsx`。包括 `flowRulesQuery`/`updateFlowRules`/`resetFlowRules` hooks 和 `flowRulesEdit` 状态。

- [ ] **步骤 4：提取 BrowserWarmupPanel**

从 `page.tsx` 第 1159-1181 行提取到 `components/BrowserWarmupPanel.tsx`。包括 `BROWSER_FIELDS`（从 `shared/constants.ts` 导入）。

- [ ] **步骤 5：提取 DynamicSelectorPanel**

从 `page.tsx` 第 1183-1501 行提取到 `components/DynamicSelectorPanel.tsx`（~320 行）。包括 `selectorsQuery`/`upsertSelector`/`deleteSelector` hooks、筛选状态、展开行、模态框表单。

- [ ] **步骤 6：组装 MatrixTab**

```tsx
'use client';
import FlowGraphView from '../components/FlowGraphView';
import DynamicSelectorPanel from '../components/DynamicSelectorPanel';
import FlowRulesPanel from '../components/FlowRulesPanel';
import BrowserWarmupPanel from '../components/BrowserWarmupPanel';
import CrawlModePanel from '../components/CrawlModePanel';
// import MonitorSchedulePanel from '../components/MonitorSchedulePanel';  // 任务 8 取消注释
// import AiReplyConfigPanel from '../components/AiReplyConfigPanel';      // 任务 8 取消注释

export default function MatrixTab() {
  return (
    <div className="space-y-6 p-6">
      <FlowGraphView />
      <DynamicSelectorPanel />
      <FlowRulesPanel />
      <BrowserWarmupPanel />
      <CrawlModePanel />
      {/* <MonitorSchedulePanel /> */}
      {/* <AiReplyConfigPanel /> */}
    </div>
  );
}
```

- [ ] **步骤 7：验证 MatrixTab 在浏览器中功能正常**

- [ ] **步骤 8：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/
git commit -m "refactor: 提取 MatrixTab — FlowGraphView 迁入 + 5 个面板提取"
```

---

## 任务 8：新建 MonitorSchedulePanel + AiReplyConfigPanel

**文件：**
- 创建：`apps/admin-dashboard/src/app/settings/components/MonitorSchedulePanel.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/components/AiReplyConfigPanel.tsx`
- 修改：`apps/admin-dashboard/src/app/settings/tabs/MatrixTab.tsx`

- [ ] **步骤 1：创建 MonitorSchedulePanel**

面板包含：全局默认编辑区（active min/max, idle min/max, idle_threshold, sleep_start_hour, sleep_end_hour 下拉选择）+ 4 个平台覆盖编辑行。使用 `useAutomationConfig`/`useUpdateAutomationConfig` hooks。从 `shared/constants.ts` 导入 `HOUR_OPTIONS`。详见规格文档第 6.2 节。

- [ ] **步骤 2：创建 AiReplyConfigPanel**

面板包含：模型名（text input）、Temperature（number）、Max Tokens（number）、系统提示词（textarea min-height 200px）、保存 + 重置按钮。使用 `useAiReplyConfig`/`useUpdateAiReplyConfig` hooks。详见规格文档第 6.3 节。

- [ ] **步骤 3：取消 MatrixTab 中两个 import 的注释**

- [ ] **步骤 4：验证两个面板在浏览器中功能正常**

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/MonitorSchedulePanel.tsx apps/admin-dashboard/src/app/settings/components/AiReplyConfigPanel.tsx apps/admin-dashboard/src/app/settings/tabs/MatrixTab.tsx
git commit -m "feat: 新建 MonitorSchedulePanel + AiReplyConfigPanel"
```

---

## 任务 9：路由重定向 + 侧边栏修改

**文件：**
- 修改：`apps/admin-dashboard/next.config.js`
- 修改：`apps/admin-dashboard/src/components/layout/Sidebar.tsx`

- [ ] **步骤 1：在 `next.config.js` 添加 redirects()**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: '/settings/selectors', destination: '/settings', permanent: true },
    ];
  },
};

module.exports = nextConfig;
```

- [ ] **步骤 2：修改 `Sidebar.tsx` 移除 selectors 入口**

移除 `/settings/selectors` 导航条目，只保留 `/settings` → `系统设置`。

- [ ] **步骤 3：验证重定向生效**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/settings/selectors
# 预期: 301（重定向到 /settings）
```

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/next.config.js apps/admin-dashboard/src/components/layout/Sidebar.tsx
git commit -m "refactor: /settings/selectors 重定向 + 侧边栏合并"
```

---

## 任务 10：删除旧文件 + 最终验证

- [ ] **步骤 1：删除 `settings/selectors/page.tsx`**

```bash
rm apps/admin-dashboard/src/app/settings/selectors/page.tsx
rmdir apps/admin-dashboard/src/app/settings/selectors/ 2>/dev/null || true
```

- [ ] **步骤 2：验证所有 Tab 功能正常**

打开 `http://localhost:3000/settings`，逐个切换 4 个 Tab 验证：
- 通用设置：基础设施/网络/通知/安全 4 板块可显示可保存
- 智能创作：FFmpeg 配置可显示可保存
- 大模型管理：LLM 凭证/参数工作组可显示可保存
- 社媒矩阵：FlowGraphView/选择器表格/流程规则/浏览器养号/爬取模式/调度周期/AI回复配置 全部可显示

- [ ] **步骤 3：验证 Tab 切换不丢失表单状态**

在通用设置 Tab 编辑基础设施表单（不保存），切换到智能创作 Tab，再切回通用设置，验证表单内容仍在。

- [ ] **步骤 4：Commit**

```bash
git add -A apps/admin-dashboard/src/app/settings/
git commit -m "refactor: 删除旧 selectors 页面，设置页重构完成"
```
