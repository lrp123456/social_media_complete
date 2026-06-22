# 流程图状态机迁移设计文档

> **日期**: 2026-06-22
> **状态**: 已批准（设计阶段）
> **子项目**: 2/2（子项目1: 设置页重构已完成）

## 1. 背景与问题

子项目1 完成后，FlowGraphView 已迁入 MatrixTab。但流程图存在根本性问题：

- **全部线性** — 所有流程（4平台×3流程=12个）都是线性步骤序列，没有任何条件分支
- **缺少38+分支** — 实际爬虫代码中有38+个条件分支（登录检测、风控、light/deep、空队列等），流程图完全不反映
- **无细粒度** — 只显示高层操作（如"点击菜单"），不显示具体原子操作（查找元素→鼠标移动→等待→点击→验证）
- **NodeDrawer bug** — 保存时只发送单个步骤，会覆盖整个流程

## 2. 目标

- 引入 XState 状态机模型替换现有线性流程定义
- 使用 React Flow 渲染有向图，支持节点拖拽、连线路由、缩放平移
- 实现层次状态机（HSM）— 高层状态可展开查看细粒度子步骤
- 补全 4 平台 × 3 流程 = 12 个状态机中的 38+ 条件分支
- 每个原子操作可编辑主/备用选择器

## 3. 架构

### 3.1 数据流

```
selectors.json
└─ navigationFlows[platform][flowName]
   └─ { label, initial, steps: FlowNode[] }
   └─ 每个 step 有 steps[]（子步骤）和 branches[]（分支）

↓ useNavigationFlows() hook

FlowGraphView.tsx
└─ flowNodesToMachine(steps) 转换函数
└─ createMachine(config) 创建 XState 状态机
└─ interpret(machine) 运行状态机

↓

React Flow
└─ nodes: 从 states 生成
└─ edges: 从 on/branches 生成
└─ FlowNodeCard 作为 custom node 组件
└─ NodeDrawer 作为 node detail panel
```

### 3.2 双格式共存

- `selectors.json` 存储扩展 FlowNode 格式（保持后端 API 兼容）
- 前端加载时转换为 XState machine config
- 后端和 hooks 不改动

## 4. 扩展 FlowNode 格式

### 4.1 当前格式

```typescript
type FlowNode = {
  id: string;
  action: StepAction;
  description: string;
  selector?: FlowSelectorConfig;
  apiPatternKey?: string;
  waitFor?: WaitForConfig;
  branches?: Record<string, { goto: string }>;
  next?: string;
  maxVideos?: number;
  scrollConfig?: ScrollConfig;
  nextPageBtn?: PageBtnConfig;
};
```

### 4.2 扩展格式

```typescript
type FlowNode = {
  id: string;
  action: StepAction;
  description: string;
  selector?: FlowSelectorConfig;
  apiPatternKey?: string;
  waitFor?: WaitForConfig;
  branches?: FlowBranch[];      // 从 Record 改为数组
  next?: string;
  maxVideos?: number;
  scrollConfig?: ScrollConfig;
  nextPageBtn?: PageBtnConfig;
  steps?: FlowSubStep[];        // 新增：细粒度子步骤
};

type FlowBranch = {
  condition: string;             // 事件名（如 "LOGIN_OK", "RISK_DETECTED"）
  target: string;                // 目标状态 ID
  description: string;           // 人类可读描述
};

type FlowSubStep = {
  id: string;
  action: SubStepAction;         // 细粒度操作类型
  description: string;
  selector?: FlowSelectorConfig; // 每个子步骤可有自己的选择器
};
```

### 4.3 示例

```json
{
  "id": "click_menu",
  "action": "click_menu",
  "description": "点击「内容管理」→「作品管理」",
  "selector": { "key": "menus.menu_work_manage" },
  "steps": [
    { "id": "find_element", "action": "resolve_selector", "description": "查找菜单元素" },
    { "id": "hover_target", "action": "mouse_move", "description": "鼠标移至目标元素" },
    { "id": "wait_visible", "action": "wait_for_element", "description": "等待元素可见可点击" },
    { "id": "click", "action": "cdp_click", "description": "执行点击" },
    { "id": "verify_response", "action": "check_navigation", "description": "验证页面响应" }
  ],
  "branches": [
    { "condition": "SUCCESS", "target": "enable_interceptor", "description": "菜单已打开" },
    { "condition": "ERROR", "target": "error_handler", "description": "点击失败" }
  ],
  "next": "enable_interceptor"
}
```

## 5. 层次状态机（HSM）

### 5.1 XState 嵌套状态

每个高层状态（如 `click_menu`）在 XState 中是一个包含子状态的状态：

```typescript
const machine = createMachine({
  id: 'douyin_monitor',
  initial: 'check_url',
  states: {
    check_url: {
      description: '检查是否在创作者中心',
      initial: 'find_element',
      states: {
        find_element: { on: { FOUND: 'hover_target', NOT_FOUND: 'try_fallback' } },
        try_fallback: { on: { FOUND: 'hover_target', ALL_FAILED: '#error' } },
        hover_target: { on: { HOVERED: 'wait_visible' } },
        wait_visible: { on: { VISIBLE: 'click', TIMEOUT: 'retry_click' } },
        click: { on: { CLICKED: 'verify_response' } },
        verify_response: { on: { SUCCESS: '#done', FAILED: '#error' } }
      },
      on: { URL_OK: 'click_menu', URL_FAIL: 'navigate' }
    },
    click_menu: { /* ... */ },
    // ...
  }
});
```

### 5.2 转换函数

```typescript
function flowNodesToMachine(steps: FlowNode[]): StateMachineConfig {
  const states: Record<string, any> = {};
  for (const step of steps) {
    const state: any = {
      description: step.description,
      action: step.action,
      selector: step.selector,
      on: {}
    };
    // 如果有子步骤，创建嵌套状态机
    if (step.steps && step.steps.length > 0) {
      state.initial = step.steps[0].id;
      state.states = {};
      for (const sub of step.steps) {
        state.states[sub.id] = {
          description: sub.description,
          action: sub.action,
          selector: sub.selector,
          on: {}
        };
      }
      // 子步骤之间的线性连接
      for (let i = 0; i < step.steps.length - 1; i++) {
        state.states[step.steps[i].id].on['NEXT'] = step.steps[i + 1].id;
      }
    }
    // 高层分支
    if (step.branches) {
      for (const branch of step.branches) {
        state.on[branch.condition] = {
          target: branch.target,
          description: branch.description
        };
      }
    }
    if (step.next) {
      state.on['NEXT'] = { target: step.next };
    }
    states[step.id] = state;
  }
  return { initial: steps[0]?.id, states };
}
```

## 6. React Flow 渲染

### 6.1 依赖

需要安装：
- `xstate` — 状态机核心库
- `@xstate/react` — React hooks 集成
- `@xyflow/react` — React Flow 图渲染

### 6.2 节点渲染

- **折叠视图**（默认）— 每个高层状态渲染为一个节点，显示名称、描述、子步骤数量
- **展开视图**（点击展开）— 显示所有细粒度子步骤及其连线
- **自定义节点组件** — 复用现有 FlowNodeCard，扩展支持折叠/展开

### 6.3 连线渲染

- **高层分支** — 状态之间的连线，带条件标签（如 "LOGIN_OK → send_qr"）
- **子步骤连线** — 子步骤之间的线性连接
- **自动布局** — 使用 dagre 或 elkjs 做自动布局，避免手动定位

### 6.4 NodeDrawer 改造

- 点击节点打开 NodeDrawer
- 高层状态：编辑 description、branches、next
- 子步骤：编辑 action、description、selector（主/备用选择器）
- 选择器编辑：复用现有 SelectorEditor 组件

## 7. 选择器分类

### 7.1 四大类

| 类别 | 用途 | 示例 |
|------|------|------|
| `menus` | 菜单导航选择器 | `menus.menu_work_manage` |
| `buttons` | 按钮点击选择器 | `buttons.btn_publish` |
| `regions` | 区域/容器选择器 | `regions.video_list` |
| `textboxes` | 输入框选择器 | `textboxes.search_input` |

### 7.2 选择器配置

每个选择器有：
- **主选择器** — primary selector（CSS/Role/Text/XPath）
- **备用选择器** — fallback selectors 数组（按优先级排列）
- **选择器类型** — CSS / Role / Text / XPath
- **作用域** — none / framework / custom（关联 FrameworkManager 中的大框架容器）

### 7.3 子步骤选择器

每个子步骤可以有自己的选择器：
- `resolve_selector` — 使用高层选择器
- `try_fallback` — 使用备用选择器
- `mouse_move` — 使用高层选择器定位目标
- `cdp_click` — 使用高层选择器执行点击

## 8. 38+ 条件分支

### 8.1 跨平台分支（所有平台共有）

| # | 分支名 | 条件 | 来源 |
|---|--------|------|------|
| 1 | 连接超时 | 60s 超时 | monitorService.ts:704-718 |
| 2 | 风控检测（Phase 1） | riskControlDetected | monitorService.ts:784-792 |
| 3 | 空队列 | commentsQueue.length === 0 | monitorService.ts:795-799 |
| 4 | 爬取模式 light | crawlMode === 'light' | monitorService.ts:804-824 |
| 5 | Phase 2 导航失败 | !navSuccess | monitorService.ts:832-836 |
| 6 | 风控检测（Phase 3） | riskDetected | monitorService.ts:843-852 |
| 7 | 帧分离异常 | 'Frame was detached' | monitorService.ts:750-754 |

### 8.2 平台特有分支

| 平台 | 分支 | 条件 | 来源 |
|------|------|------|------|
| 快手 | 登录检测 | !loginSuccess | monitorService.ts:913-917 |
| 视频号 | 登录检测 | !loggedIn | monitorService.ts:1222-1226 |
| 视频号 | 登录失效vs临时风控 | isLoginExpired | monitorService.ts:1241-1248 |
| 视频号 | Phase2失败回退light | !navSuccess | monitorService.ts:1287-1298 |
| 小红书 | Redis重检标记 | needsLoginRecheck | monitorService.ts:1054-1057 |
| 小红书 | Phase3登录失效 | hasLoginRequired | monitorService.ts:1124-1146 |
| 抖音 | 抽屉视频匹配 | 描述匹配 | douyinCrawler.ts:findAndClickVideoInDrawer |

### 8.3 分支实现方式

每个分支在 selectors.json 中对应一个 `FlowBranch`：
```json
{
  "condition": "LOGIN_REQUIRED",
  "target": "send_qr",
  "description": "登录失效，发送QR码"
}
```

在 XState 中对应一个状态转换：
```typescript
on: {
  LOGIN_REQUIRED: { target: 'send_qr', description: '登录失效，发送QR码' },
  LOGIN_OK: { target: 'collect_comments', description: '登录正常' }
}
```

## 9. NodeDrawer Bug 修复

当前 NodeDrawer 保存时只发送单个步骤（`[form]`），会覆盖整个流程。需要修复为发送完整步骤数组。

修复方案：
- NodeDrawer 编辑时接收完整步骤数组
- 保存时将修改的步骤合并回数组
- 发送完整的 `steps` 数组

## 10. 范围边界

### 本子项目包含
- 安装 xstate、@xstate/react、@xyflow/react 依赖
- 扩展 FlowNode 类型（添加 steps[]、修改 branches 为数组）
- 实现 flowNodesToMachine 转换函数
- 重写 FlowGraphView 使用 React Flow 渲染
- 改造 FlowNodeCard 支持折叠/展开
- 改造 NodeDrawer 支持子步骤编辑和选择器编辑
- 修复 NodeDrawer 保存 bug
- 更新 selectors.json 中 12 个流程的定义，添加细粒度子步骤
- 补全 38+ 条件分支

### 本子项目不包含
- 后端 API 改动（保持兼容）
- 数据库 schema 变更
- 爬虫/监控逻辑改动
- 子项目1 的任何改动

## 11. 风险与缓解

| 风险 | 严重性 | 缓解 |
|------|--------|------|
| React Flow 学习曲线 | 中 | 使用官方示例，custom node 组件复用现有 FlowNodeCard |
| 自动布局算法复杂 | 中 | 使用 dagre 做布局计算，不需要手动定位 |
| XState 嵌套状态调试困难 | 中 | 使用 XState Inspector 工具可视化状态机 |
| selectors.json 格式变更影响后端 | 低 | 后端 API 不改动，前端做转换 |
| 12 个流程全部重写工作量大 | 高 | 先完成 1 个平台（抖音）的 3 个流程，验证方案后再扩展 |
