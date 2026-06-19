# 前端选择器配置 UI 重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将前端选择器配置界面从三视图重构为统一流程编排视图，新增 apiPatterns/dataSources/navigationFlows/frameworks 的可视化编辑

**架构：** 后端新增 4 组 CRUD API + selectorStore 扩展 frameworks；前端 FlowGraphView 替代三视图，点击节点弹出右侧抽屉，每个选择器独立配置 4 种类型 + 3 种作用域模式

**技术栈：** Next.js 14, React 18, TypeScript, TanStack Query, Tailwind CSS

**设计文档：** `docs/superpowers/specs/2026-06-19-selector-config-ui-redesign.md`

---

## 文件结构

| 文件 | 职责 | 变更 |
|------|------|------|
| `apps/ts-api-gateway/src/lib/selectorStore.ts` | 配置存储 | 修改 — 新增 frameworks |
| `apps/ts-api-gateway/src/routes/config-automation.ts` | API 路由 | 修改 — 新增 4 组 CRUD |
| `apps/admin-dashboard/src/hooks/useApi.ts` | API Hooks | 修改 — 新增类型和 hooks |
| `apps/admin-dashboard/src/app/settings/selectors/page.tsx` | 主页面 | 重构 |
| `apps/admin-dashboard/src/app/settings/selectors/FlowGraphView.tsx` | 流程图 | 重构(覆盖FlowView) |
| `apps/admin-dashboard/src/app/settings/selectors/FlowNodeCard.tsx` | 节点卡片 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/NodeDrawer.tsx` | 右侧抽屉 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/SelectorEditor.tsx` | 选择器编辑器 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/FrameworkManager.tsx` | 框架管理 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/ApiPatternManager.tsx` | API Pattern管理 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/DataSourceManager.tsx` | DataSource管理 | 新建 |
| `apps/admin-dashboard/src/app/settings/selectors/FieldMappingEditor.tsx` | 字段映射 | 新建 |
| `data/selectors.json` | 配置文件 | 修改 — 新增 frameworks |

---

## Phase 1：后端基础

### 任务 1：selectorStore + PlatformSelectors 扩展 frameworks 支持

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/selectorStore.ts`
- 修改：`packages/browser-core/src/selectorConfig.ts`（PlatformSelectors 接口）

- [ ] **步骤 0：** 在 `packages/browser-core/src/selectorConfig.ts` 的 `PlatformSelectors` 接口中，`navigationFlows?` 之后新增：
```typescript
frameworks?: Record<string, Record<string, unknown>>;
```

- [ ] **步骤 1：** selectorStore.ts L81 VALID_CATEGORIES 数组末尾新增 `'frameworks'`
- [ ] **步骤 2：** selectorStore.ts L218 sanitizeConfig out 初始化对象中直接新增 `frameworks: {}`（不要仅在外部赋值）；L237 之后新增 `out.frameworks = (p.frameworks || {}) as Record<string, unknown>;`
- [ ] **步骤 3：** selectorStore.ts L60-69 FALLBACK_CONFIG **每个平台**（douyin/kuaishou/xiaohongshu/tencent）新增 `frameworks: {}`。注意：tencent 平台当前可能不在 FALLBACK_CONFIG 中，如果缺失需要补全整个平台对象
- [ ] **步骤 4：** selectorStore.ts 文件末尾新增 `getFrameworks(platform)` 和 `getFramework(platform, key)` 函数（模式同 getApiPattern）
- [ ] **步骤 5：** selectorStore.ts L322 现有 `saveSelectorConfig()` 函数改为接受可选参数：
```typescript
export function saveSelectorConfig(config?: SelectorConfig): void {
  if (config) {
    saveToDisk(config);
    instance = new SelectorReader(config);
  } else if (instance) {
    saveToDisk(instance.getConfig());
  }
}
```
- [ ] **步骤 6：** 验证编译：`npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep -E "selectorStore|selectorConfig"`
- [ ] **步骤 7：** Commit `feat(config): add frameworks support to selectorStore and PlatformSelectors`

### 任务 2：后端 CRUD API

**文件：** `apps/ts-api-gateway/src/routes/config-automation.ts`

- [ ] **步骤 1：** 确保头部导入 `saveSelectorConfig`。selectorStore.ts L322 已存在 `saveSelectorConfig()` 无参版本（任务1步骤5已改为可选参数版本 `saveSelectorConfig(config?: SelectorConfig)`），确认 `config-automation.ts` L2 导入语句包含 `saveSelectorConfig`。

- [ ] **步骤 2：** 在 L478（`router.get('/selectors/full'` 之前）插入 frameworks CRUD。**注意：每组 CRUD 需要两个 GET 端点**——列表 `GET /frameworks/:platform` 和单条 `GET /frameworks/:platform/:key`，以及 PUT 和 DELETE：
```
GET    /frameworks/:platform           → 返回 { platform, frameworks: {所有frameworks} }
GET    /frameworks/:platform/:key      → 返回 { platform, key, entry: {单个framework} }
PUT    /frameworks/:platform/:key      → 新增/更新，body: { label, selector, description }
DELETE /frameworks/:platform/:key      → 删除
```

- [ ] **步骤 3：** 紧接插入 apiPatterns CRUD，同样需要列表端点：
```
GET    /api-patterns/:platform         → 返回 { platform, apiPatterns: {所有} }
GET    /api-patterns/:platform/:key    → 返回单条
PUT    /api-patterns/:platform/:key    → body: ApiPatternEntry
DELETE /api-patterns/:platform/:key
```

- [ ] **步骤 4：** 紧接插入 dataSources CRUD，同样需要列表端点：
```
GET    /data-sources/:platform         → 返回 { platform, dataSources: {所有} }
GET    /data-sources/:platform/:key    → 返回单条
PUT    /data-sources/:platform/:key    → body: DataSourceEntry
DELETE /data-sources/:platform/:key
```

- [ ] **步骤 5：** 紧接插入 navigationFlows CRUD + last-run，同样需要列表端点：
```
GET    /navigation-flows/:platform              → 返回 { platform, navigationFlows: {所有} }
GET    /navigation-flows/:platform/:flowName    → 返回单条
PUT    /navigation-flows/:platform/:flowName    → body: NavigationFlowEntry
DELETE /navigation-flows/:platform/:flowName
GET    /navigation-flows/:platform/:flowName/last-run → 查询 TaskExecutionStep 表
```
last-run 查询逻辑：`prisma.taskExecution.findFirst({ where: { platform, taskType: 'monitor' }, orderBy: { startedAt: 'desc' }, include: { steps: { orderBy: { stepIndex: 'asc' } } } })`，返回步骤列表（stepIndex/label/status/durationMs/selectorTries/extra）

- [ ] **步骤 6：** 验证编译
- [ ] **步骤 7：** Commit `feat(api): add CRUD endpoints for frameworks/apiPatterns/dataSources/navigationFlows`

### 任务 3：selectors.json 初始化 frameworks 节点

**文件：** `data/selectors.json`

- [ ] **步骤 1：** 用 Python 脚本为四平台添加 frameworks 节点：
  - 抖音：sidebar(`#douyin-creator-master`)、main_content(`.douyin-creator-master-content`)、drawer(`.douyin-creator-interactive-sidesheet`)、comment_area(`.douyin-creator-interactive-tabs-content`)
  - 快手：sidebar(`.side-nav`)、main_content(`.main-content`)、drawer(`.el-drawer`)
  - 小红书：sidebar(`.creator-sidebar`)、main_content(`.creator-content`)、note_list(`.note-list`)
  - 视频号：sidebar(`.weui-desktop-nav`)、main_content(`.weui-desktop-block`)、video_list(`.feeds-container`)
- [ ] **步骤 2：** 验证 JSON 格式
- [ ] **步骤 3：** Commit `feat(config): initialize frameworks nodes for all platforms`

### 任务 3b：selectorStore 加载时自动合并 urlMonitors → apiPatterns/dataSources

**文件：** `apps/ts-api-gateway/src/lib/selectorStore.ts`（`loadFromDisk` 函数内）

- [ ] **步骤 1：** 在 `loadFromDisk` 函数返回 config 之前，新增自动合并逻辑：遍历每个平台的 `urlMonitors`，如果某个 urlMonitor 的 URL pattern 在 `apiPatterns` 中不存在，自动创建对应的 apiPattern 条目（pattern 从 urlMonitors.urlPatterns[0] 提取）。同时如果 urlMonitor 有 extraction/pagination 配置，映射到 apiPatterns 的 responseArrayPath/hasMoreField/cursorField。

- [ ] **步骤 2：** 验证编译
- [ ] **步骤 3：** Commit `feat(config): auto-merge urlMonitors to apiPatterns on load`

### 任务 3c：旧选择器格式运行时兼容

**文件：** `packages/browser-core/src/selectorConfig.ts`

- [ ] **步骤 1：** 新增 `normalizeSelector(entry: any): ScopedSelector` 函数，自动检测旧格式（`primary` 是字符串）并转换为新格式：
```typescript
export function normalizeSelector(entry: any): ScopedSelector {
  if (typeof entry.primary === 'object') return entry.primary as ScopedSelector;
  return {
    type: (entry.selectorType as SelectorType) || 'css',
    value: entry.primary as string,
    scopeMode: 'none',
    frameworkKey: entry.scopeKey,
    filterTag: entry.filterTag,
    filterText: entry.filterText,
  };
}
```

- [ ] **步骤 2：** 验证编译
- [ ] **步骤 3：** Commit `feat(core): add normalizeSelector for backward compatibility`

---

## Phase 2：前端类型与 Hooks

### 任务 4：useApi.ts 扩展

**文件：** `apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：** 在 UrlMonitorEntry 类型之后新增类型定义：`SelectorType`、`ScopeMode`、`ScopedSelector`、`SelectorConfig`、`StepAction`（14种）、`FlowNode`、`NavigationFlowEntry`、`FrameworkEntry`、`ApiPatternEntry`、`DataSourceEntry`、`LastRunStep`（完整定义见设计文档第3节）

- [ ] **步骤 1b：** 扩展 useApi.ts 中已有的 `PlatformSelectors` 类型（约L1420），新增 `apiPatterns?`、`dataSources?`、`navigationFlows?`、`frameworks?` 字段

- [ ] **步骤 2：** 在 useDeleteUrlMonitor 之后新增 hooks：`useFrameworks`、`useUpsertFramework`、`useDeleteFramework`、`useApiPatterns`、`useUpsertApiPattern`、`useDeleteApiPattern`、`useDataSources`、`useUpsertDataSource`、`useDeleteDataSource`、`useNavigationFlows`、`useUpsertNavigationFlow`、`useDeleteNavigationFlow`、`useFlowLastRun`（模式参考现有 useUrlMonitors/useUpsertUrlMonitor）

- [ ] **步骤 3：** 验证编译
- [ ] **步骤 4：** Commit `feat(frontend): add types and hooks for v2.5+ config`

---

## Phase 3：前端组件实现

### 任务 5：FlowNodeCard 组件

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/FlowNodeCard.tsx`

- [ ] **步骤 1：** 创建组件，接收 `node: FlowNode`、`lastRun?: LastRunStep`、`selected: boolean`、`onClick: () => void`
  - ACTION_CONFIG 映射：14 种 action 各有 icon + 颜色（11 种设计文档定义 + 3 种代码补充：`click_button`、`disable_interceptor`、`wait_for_response`）
  - 执行状态色点：绿(成功)/黄(回退)/红(失败)/灰(未执行)
  - 显示：步骤ID、描述、选择器摘要(前50字符)、API Pattern引用、执行耗时+选择器命中状态
- [ ] **步骤 2：** Commit `feat(frontend): add FlowNodeCard component`

### 任务 6：SelectorEditor 组件

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/SelectorEditor.tsx`

- [ ] **步骤 1：** 创建组件，接收 `label`、`selector: ScopedSelector`、`frameworks: Record<string, FrameworkEntry>`、`onChange`
  - 类型下拉（CSS/Role/Text/XPath）+ 值输入框
  - 作用域单选（无/大框架/自定义）
  - 大框架模式：framework 下拉 + subContainer 输入框
  - 自定义模式：customContainer 输入框
  - 过滤条件：filterTag + filterText 输入框
- [ ] **步骤 2：** Commit `feat(frontend): add SelectorEditor component`

### 任务 7：FieldMappingEditor 组件

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/FieldMappingEditor.tsx`

- [ ] **步骤 1：** 创建组件，接收 `mappings: Record<string, string[]>`、`onChange`
  - 每行：字段名 ← 候选路径 chips（可删除）+ 添加路径输入框
- [ ] **步骤 2：** Commit `feat(frontend): add FieldMappingEditor component`

### 任务 8：FrameworkManager 弹窗

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/FrameworkManager.tsx`

- [ ] **步骤 1：** 创建弹窗组件，接收 `platform`、`onClose`
  - 列表展示：label + key + selector + 编辑/删除按钮
  - 新增/编辑表单：label、selector、description 输入框
  - 使用 useFrameworks/useUpsertFramework/useDeleteFramework hooks
- [ ] **步骤 2：** Commit `feat(frontend): add FrameworkManager component`

### 任务 9：ApiPatternManager 弹窗

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/ApiPatternManager.tsx`

- [ ] **步骤 1：** 创建弹窗组件，接收 `platform`、`onClose`
  - 列表展示：key + pattern + description
  - 编辑表单：pattern、description、responseArrayPath[]（多路径）、hasMoreField、hasMoreCondition、cursorField
  - 嵌入 FieldMappingEditor 编辑 fieldMappings
  - **注意：privateFilter 不在 ApiPatternManager 中编辑**，privateFilter 属于 DataSource 配置（因为不同数据源可能对同一 API 有不同的过滤策略）
- [ ] **步骤 2：** Commit `feat(frontend): add ApiPatternManager component`

### 任务 10：DataSourceManager 弹窗

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/DataSourceManager.tsx`

- [ ] **步骤 1：** 创建弹窗组件，接收 `platform`、`onClose`
  - 列表展示：key + label + pageUrl + apiPatternKey
  - 编辑表单：label、pageUrl、apiPatternKey（下拉引用apiPatterns）、pagination配置（type下拉scroll/page + maxScrolls/maxPages + 换页按钮选择器）、privateFilter配置（启用开关 + field + condition + dynamicRemove开关）
- [ ] **步骤 2：** Commit `feat(frontend): add DataSourceManager component`

### 任务 11：NodeDrawer 右侧抽屉

**文件：** 创建 `apps/admin-dashboard/src/app/settings/selectors/NodeDrawer.tsx`

- [ ] **步骤 1：** 创建组件，接收 `node: FlowNode`、`frameworks`、`apiPatterns`、`onClose`、`onSave`
  - 顶部：返回按钮 + 步骤ID + 节点类型标签 + 描述输入框
  - DOM选择器区：主选择器 SelectorEditor + 备用选择器列表（动态增删）+ 添加按钮
  - API Pattern区（enable_interceptor节点）：下拉选择apiPatternKey + 展开编辑详情
  - 等待条件区：attribute/urlContains/apiResponse 单选 + timeout输入框
  - 分支/后续区：next 下拉选择其他节点ID 或 branches 表格
  - 特有配置区：check_quantity(maxVideos)、scroll_load(maxScrolls+scrollDelta)、page_turn(css+xpath+text)
  - 底部：自动保存（debounce 1s）
- [ ] **步骤 2：** Commit `feat(frontend): add NodeDrawer component`

### 任务 12：FlowGraphView 流程图主视图

**文件：** 重构 `apps/admin-dashboard/src/app/settings/selectors/FlowGraphView.tsx`（覆盖现有 FlowView）

- [ ] **步骤 1：** 重构组件，接收 `platform`、`flowName`、`onClose`
  - 使用 useNavigationFlows + useFlowLastRun 获取数据
  - 纵向流水线布局：节点卡片列表 + 连线
  - 分支节点：多条向右展开的连线，标注分支条件
  - 点击节点弹出 NodeDrawer
  - 顶部工具栏：[框架管理] [API Pattern管理] [DataSource管理] 按钮
- [ ] **步骤 2：** Commit `feat(frontend): refactor FlowGraphView with node cards and drawer`

### 任务 13：page.tsx 主页面重构

**文件：** 重构 `apps/admin-dashboard/src/app/settings/selectors/page.tsx`

- [ ] **步骤 1：** 删除三视图切换逻辑（列表/流程/URL监控）
- [ ] **步骤 2：** 替换为：平台标签栏 + 工作流标签栏（监控/发布/评论回复）+ FlowGraphView
- [ ] **步骤 3：** 删除 `FlowView.tsx` 文件和 `selectorFlows.ts` 文件，并从 `page.tsx` 中移除 `import FlowView from './FlowView'`。确认无其他文件引用这两个文件
- [ ] **步骤 4：** Commit `feat(frontend): refactor selector config page to flow graph view`

---

## Phase 4：验证

### 任务 14：全量编译验证

- [ ] **步骤 1：** 后端编译：`npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
- [ ] **步骤 2：** 前端编译：`npx tsc --noEmit -p apps/admin-dashboard/tsconfig.json`
- [ ] **步骤 3：** 验证 selectors.json 加载：`python3 -c "import json; d=json.load(open('data/selectors.json')); [print(p, len(d['platforms'][p].get('frameworks',{}))) for p in d['platforms']]"`
- [ ] **步骤 4：** Commit `chore: selector config UI redesign — all phases complete`

---

## 自检

| 检查项 | 结果 |
|-------|------|
| 规格覆盖度 — 第1节节点类型与数据模型 | ✅ 任务5(FlowNodeCard, 14种action) + 任务11(NodeDrawer) + 任务12(FlowGraphView) |
| 规格覆盖度 — 第2节右侧抽屉编辑器 | ✅ 任务11(NodeDrawer) |
| 规格覆盖度 — 第3节选择器类型与容器作用域 | ✅ 任务6(SelectorEditor) + 任务8(FrameworkManager) + 任务3c(normalizeSelector兼容) |
| 规格覆盖度 — 第4节后端API | ✅ 任务1-3b（含列表端点+last-run） |
| 规格覆盖度 — 第5节前端组件架构 | ✅ 任务5-13（8个组件+page重构） |
| 规格覆盖度 — 第6节数据迁移 | ✅ 任务3(frameworks初始化) + 任务3b(urlMonitors自动合并) + 任务3c(旧格式兼容) + 任务4(前端类型扩展) |
| 占位符扫描 | ✅ 无TODO/待定 |
| 类型一致性 | ✅ ScopedSelector/FlowNode/FrameworkEntry 在任务4定义，任务5-13使用；PlatformSelectors 在任务1步骤0扩展 |
| privateFilter 归属 | ✅ 在 DataSourceManager(任务10) 中编辑，不在 ApiPatternManager(任务9) 中 |
| saveSelectorConfig 兼容 | ✅ 任务1步骤5 改为可选参数，兼容现有8处无参调用 |
| FALLBACK_CONFIG tencent | ✅ 任务1步骤3 补全 tencent 平台 |
