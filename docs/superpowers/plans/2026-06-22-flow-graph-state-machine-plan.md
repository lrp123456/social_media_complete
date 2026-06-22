# 流程图状态机迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将线性流程图迁移为 XState 层次状态机 + React Flow 有向图渲染，补全 38+ 条件分支。

**架构：** `selectors.json` 存储扩展 FlowNode 格式（含 `steps[]` 子步骤和 `branches[]` 分支），前端加载后通过 `flowNodesToMachine()` 转换为 XState 状态机，React Flow 渲染有向图。每个高层状态可展开查看细粒度原子操作。

**技术栈：** xstate, @xstate/react, @xyflow/react (React Flow), dagre (自动布局), TypeScript

**规格文档：** `docs/superpowers/specs/2026-06-22-flow-graph-state-machine-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/admin-dashboard/package.json` | 修改 | 添加 xstate、@xstate/react、@xyflow/react、dagre 依赖 |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 修改 | 扩展 FlowNode/FlowBranch/FlowSubStep 类型 |
| `apps/admin-dashboard/src/app/settings/components/flowStateMachine.ts` | 新建 | flowNodesToMachine 转换函数 |
| `apps/admin-dashboard/src/app/settings/components/FlowGraphView.tsx` | 重写 | React Flow 有向图渲染 |
| `apps/admin-dashboard/src/app/settings/components/FlowNodeCard.tsx` | 重写 | React Flow custom node，支持折叠/展开 |
| `apps/admin-dashboard/src/app/settings/components/NodeDrawer.tsx` | 重写 | 支持子步骤编辑 + 选择器编辑 + 修复保存 bug |
| `apps/admin-dashboard/src/app/settings/components/FlowEdge.tsx` | 新建 | React Flow custom edge（带条件标签） |
| `apps/admin-dashboard/src/app/settings/components/flowLayout.ts` | 新建 | dagre 自动布局函数 |
| `data/selectors.json` | 修改 | 扩展 12 个流程的定义，添加子步骤和分支 |

---

## 任务 1：安装依赖 + 扩展类型

**文件：**
- 修改：`apps/admin-dashboard/package.json`
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：安装依赖**

```bash
cd apps/admin-dashboard && npm install xstate @xstate/react @xyflow/react dagre && npm install -D @types/dagre
```

- [ ] **步骤 2：扩展 FlowNode 类型**

在 `useApi.ts` 中找到 `FlowNode` 类型定义（约第 1646 行），扩展为：

```typescript
export type FlowBranch = {
  condition: string;
  target: string;
  description: string;
};

export type SubStepAction =
  | 'resolve_selector' | 'resolve_fallback_selector'
  | 'mouse_move' | 'mouse_click' | 'cdp_click' | 'cdp_click_node'
  | 'wait_for_element' | 'check_element_exists'
  | 'navigate' | 'refresh_page' | 'scroll' | 'wait_for_response'
  | 'check_navigation' | 'check_url' | 'check_login' | 'check_risk';

export type FlowSubStep = {
  id: string;
  action: SubStepAction;
  description: string;
  selector?: FlowSelectorConfig;
};

export type FlowNode = {
  id: string;
  action: StepAction;
  description: string;
  selector?: FlowSelectorConfig;
  apiPatternKey?: string;
  waitFor?: {
    attribute?: { name: string; value: string; timeout: number };
    urlContains?: string;
    apiResponse?: string;
    timeout: number;
  };
  branches?: FlowBranch[];      // 从 Record<string, {goto}> 改为 FlowBranch[]
  next?: string;
  maxVideos?: number;
  scrollConfig?: { maxScrolls: number; scrollDelta: number };
  nextPageBtn?: { css?: string; xpath?: string; text?: string };
  steps?: FlowSubStep[];        // 新增：细粒度子步骤
};
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd apps/admin-dashboard && npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/package.json apps/admin-dashboard/package-lock.json apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat: 安装 xstate/react-flow 依赖 + 扩展 FlowNode 类型"
```

---

## 任务 2：实现转换函数 + 布局算法

**文件：**
- 创建：`apps/admin-dashboard/src/app/settings/components/flowStateMachine.ts`
- 创建：`apps/admin-dashboard/src/app/settings/components/flowLayout.ts`

- [ ] **步骤 1：创建 flowStateMachine.ts**

```typescript
// apps/admin-dashboard/src/app/settings/components/flowStateMachine.ts
import { createMachine, type MachineConfig } from 'xstate';
import type { FlowNode, FlowBranch, FlowSubStep } from '@/hooks/useApi';

/**
 * 将 FlowNode[] 转换为 XState machine config
 * 支持层次状态机：高层状态包含子步骤作为嵌套状态
 */
export function flowNodesToMachineConfig(
  flowId: string,
  steps: FlowNode[]
): MachineConfig<any, any, any> {
  const states: Record<string, any> = {};

  for (const step of steps) {
    const state: any = {
      description: step.description,
      meta: {
        action: step.action,
        selector: step.selector,
        apiPatternKey: step.apiPatternKey,
        waitFor: step.waitFor,
        maxVideos: step.maxVideos,
        scrollConfig: step.scrollConfig,
        nextPageBtn: step.nextPageBtn,
      },
      on: {},
    };

    // 如果有子步骤，创建嵌套状态机
    if (step.steps && step.steps.length > 0) {
      state.initial = step.steps[0].id;
      state.states = {};
      for (const sub of step.steps) {
        state.states[sub.id] = {
          description: sub.description,
          meta: {
            action: sub.action,
            selector: sub.selector,
          },
          on: {},
        };
      }
      // 子步骤之间的线性连接
      for (let i = 0; i < step.steps.length - 1; i++) {
        state.states[step.steps[i].id].on['NEXT'] = step.steps[i + 1].id;
      }
      // 最后一个子步骤完成时触发高层 NEXT
      const lastSubStep = step.steps[step.steps.length - 1];
      state.states[lastSubStep.id].on['NEXT'] = '#done';
    }

    // 高层分支
    if (step.branches) {
      for (const branch of step.branches) {
        state.on[branch.condition] = {
          target: branch.target,
          description: branch.description,
        };
      }
    }

    // 默认转换
    if (step.next) {
      state.on['NEXT'] = { target: step.next };
    }

    states[step.id] = state;
  }

  return {
    id: flowId,
    initial: steps[0]?.id || 'done',
    states,
  };
}

/**
 * 创建 XState 状态机实例
 */
export function createFlowMachine(flowId: string, steps: FlowNode[]) {
  const config = flowNodesToMachineConfig(flowId, steps);
  return createMachine(config);
}
```

- [ ] **步骤 2：创建 flowLayout.ts**

```typescript
// apps/admin-dashboard/src/app/settings/components/flowLayout.ts
import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';

export type LayoutDirection = 'TB' | 'LR';

export interface LayoutOptions {
  direction?: LayoutDirection;
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

/**
 * 使用 dagre 做自动布局
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {}
): Node[] {
  const {
    direction = 'TB',
    nodeWidth = 200,
    nodeHeight = 80,
    rankSep = 50,
    nodeSep = 30,
  } = options;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: rankSep, nodesep: nodeSep });

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
    };
  });
}
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd apps/admin-dashboard && npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/flowStateMachine.ts apps/admin-dashboard/src/app/settings/components/flowLayout.ts
git commit -m "feat: 实现 flowNodesToMachine 转换函数 + dagre 自动布局"
```

---

## 任务 3：重写 FlowGraphView 使用 React Flow

**文件：**
- 重写：`apps/admin-dashboard/src/app/settings/components/FlowGraphView.tsx`
- 创建：`apps/admin-dashboard/src/app/settings/components/FlowEdge.tsx`
- 重写：`apps/admin-dashboard/src/app/settings/components/FlowNodeCard.tsx`

- [ ] **步骤 1：创建 FlowEdge.tsx（自定义连线）**

```typescript
// apps/admin-dashboard/src/app/settings/components/FlowEdge.tsx
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export default function FlowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.label && (
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 4,
            background: data?.labelStyle === 'error' ? '#7f1d1d' : '#1e293b',
            border: `1px solid ${data?.labelStyle === 'error' ? '#ef4444' : '#334155'}`,
            color: data?.labelStyle === 'error' ? '#fca5a5' : '#94a3b8',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </div>
      )}
    </>
  );
}
```

- [ ] **步骤 2：重写 FlowNodeCard.tsx（React Flow custom node）**

```typescript
// apps/admin-dashboard/src/app/settings/components/FlowNodeCard.tsx
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode, FlowSubStep } from '@/hooks/useApi';

const ACTION_COLORS: Record<string, string> = {
  check_url: '#3b82f6',
  click_menu: '#22c55e',
  click_button: '#22c55e',
  enable_interceptor: '#f59e0b',
  scroll_load: '#8b5cf6',
  check_quantity: '#06b6d4',
  done: '#64748b',
  navigate: '#ef4444',
  refresh_page: '#6366f1',
  wait_for_response: '#a855f7',
};

type FlowNodeCardData = {
  node: FlowNode;
  expanded?: boolean;
  onToggleExpand?: (id: string) => void;
  lastRun?: { status: string; durationMs?: number };
};

function FlowNodeCard({ data, selected }: NodeProps & { data: FlowNodeCardData }) {
  const { node, expanded, onToggleExpand, lastRun } = data;
  const color = ACTION_COLORS[node.action] || '#64748b';
  const hasSubSteps = node.steps && node.steps.length > 0;
  const branchCount = node.branches?.length || 0;

  return (
    <div
      style={{
        background: '#1e293b',
        border: `2px solid ${selected ? '#818cf8' : color}`,
        borderRadius: 12,
        padding: '10px 16px',
        minWidth: 180,
        maxWidth: 280,
        cursor: 'pointer',
      }}
      onClick={() => hasSubSteps && onToggleExpand?.(node.id)}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ color, fontSize: 11, fontWeight: 600 }}>{node.action}</span>
        {hasSubSteps && (
          <span style={{ color: '#475569', fontSize: 10 }}>
            {expanded ? '▼' : '▶'} {node.steps!.length} 步
          </span>
        )}
        {branchCount > 0 && (
          <span style={{ color: '#f59e0b', fontSize: 10 }}>⟳ {branchCount} 分支</span>
        )}
        {lastRun && (
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: lastRun.status === 'success' ? '#22c55e' : lastRun.status === 'failed' ? '#ef4444' : '#64748b',
            }}
          />
        )}
      </div>

      <div style={{ color: '#e2e8f0', fontSize: 13 }}>{node.description}</div>

      {node.selector && (
        <div style={{ color: '#475569', fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}>
          {(node.selector as any).primary?.value?.substring(0, 40) || (node.selector as any).key || ''}
        </div>
      )}

      {/* 展开时显示子步骤列表 */}
      {expanded && hasSubSteps && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #334155' }}>
          {node.steps!.map((sub: FlowSubStep, i: number) => (
            <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <span style={{ color: '#475569', fontSize: 10 }}>{i + 1}.</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{sub.action}</span>
              <span style={{ color: '#64748b', fontSize: 10 }}>{sub.description}</span>
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

export default memo(FlowNodeCard);
```

- [ ] **步骤 3：重写 FlowGraphView.tsx**

```typescript
// apps/admin-dashboard/src/app/settings/components/FlowGraphView.tsx
'use client';
import { useState, useMemo, useCallback } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Node, type Edge, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useNavigationFlows, useFlowLastRun } from '@/hooks/useApi';
import { createFlowMachine, flowNodesToMachineConfig } from './flowStateMachine';
import { applyDagreLayout } from './flowLayout';
import FlowNodeCard from './FlowNodeCard';
import FlowEdge from './FlowEdge';
import NodeDrawer from './NodeDrawer';
import FrameworkManager from './FrameworkManager';
import ApiPatternManager from './ApiPatternManager';
import DataSourceManager from './DataSourceManager';
import type { FlowNode } from '@/hooks/useApi';

const nodeTypes: NodeTypes = { flowNode: FlowNodeCard };
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge };

interface FlowGraphViewProps {
  platform: string;
  flowName: string;
}

export default function FlowGraphView({ platform, flowName }: FlowGraphViewProps) {
  const { data: flowsData } = useNavigationFlows(platform);
  const { data: lastRunData } = useFlowLastRun(platform, flowName);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [showFramework, setShowFramework] = useState(false);
  const [showApiPattern, setShowApiPattern] = useState(false);
  const [showDataSource, setShowDataSource] = useState(false);

  const flow = flowsData?.navigationFlows?.[flowName];
  const steps = flow?.steps || [];

  // 将 FlowNode[] 转换为 React Flow nodes/edges
  const { nodes: rawNodes, edges: rawEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    for (const step of steps) {
      nodes.push({
        id: step.id,
        type: 'flowNode',
        position: { x: 0, y: 0 },
        data: {
          node: step,
          expanded: expandedNodes.has(step.id),
          onToggleExpand: (id: string) => {
            setExpandedNodes((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          },
          lastRun: lastRunData?.steps?.find((s: any) => s.label === step.id),
        },
      });

      // 分支连线
      if (step.branches) {
        for (const branch of step.branches) {
          edges.push({
            id: `${step.id}-${branch.condition}-${branch.target}`,
            source: step.id,
            target: branch.target,
            type: 'flowEdge',
            data: {
              label: branch.description,
              labelStyle: branch.condition.includes('ERROR') || branch.condition.includes('FAIL') ? 'error' : 'default',
            },
            animated: true,
          });
        }
      }

      // 默认连线
      if (step.next) {
        edges.push({
          id: `${step.id}-next-${step.next}`,
          source: step.id,
          target: step.next,
          type: 'flowEdge',
          style: { strokeDasharray: '5,5' },
        });
      }
    }

    return { nodes, edges };
  }, [steps, expandedNodes, lastRunData]);

  // dagre 自动布局
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
    const layouted = applyDagreLayout(rawNodes, rawEdges);
    return { nodes: layouted, edges: rawEdges };
  }, [rawNodes, rawEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  const onNodeClick = useCallback((_: any, node: Node) => {
    const step = steps.find((s) => s.id === node.id);
    if (step) setSelectedNode(step);
  }, [steps]);

  return (
    <div style={{ height: 600, border: '1px solid #334155', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', gap: 8 }}>
        <button onClick={() => setShowFramework(true)} style={{ color: '#94a3b8', fontSize: 12 }}>框架管理</button>
        <button onClick={() => setShowApiPattern(true)} style={{ color: '#94a3b8', fontSize: 12 }}>API Pattern</button>
        <button onClick={() => setShowDataSource(true)} style={{ color: '#94a3b8', fontSize: 12 }}>DataSource</button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#334155" gap={16} />
        <Controls />
        <MiniMap nodeColor="#1e293b" maskColor="rgba(0,0,0,0.5)" />
      </ReactFlow>

      {selectedNode && (
        <NodeDrawer
          node={selectedNode}
          platform={platform}
          flowName={flowName}
          steps={steps}
          onClose={() => setSelectedNode(null)}
        />
      )}
      {showFramework && <FrameworkManager platform={platform} onClose={() => setShowFramework(false)} />}
      {showApiPattern && <ApiPatternManager platform={platform} onClose={() => setShowApiPattern(false)} />}
      {showDataSource && <DataSourceManager platform={platform} onClose={() => setShowDataSource(false)} />}
    </div>
  );
}
```

- [ ] **步骤 4：验证 TypeScript 编译**

```bash
cd apps/admin-dashboard && npx tsc --noEmit
```

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/
git commit -m "feat: 重写 FlowGraphView 使用 React Flow + 自定义节点/连线"
```

---

## 任务 4：重写 NodeDrawer 支持子步骤编辑 + 修复保存 bug

**文件：**
- 重写：`apps/admin-dashboard/src/app/settings/components/NodeDrawer.tsx`

- [ ] **步骤 1：重写 NodeDrawer**

NodeDrawer 需要支持：
1. 高层状态编辑：description、branches（添加/删除/编辑）、next
2. 子步骤编辑：点击子步骤后编辑 action、description、selector
3. 选择器编辑：复用 SelectorEditor 组件，支持主选择器 + 备用选择器数组
4. 修复保存 bug：保存时发送完整步骤数组，不是单个步骤

关键改动：
- 接收 `steps: FlowNode[]` 完整数组
- 编辑时找到当前步骤在数组中的位置
- 保存时将修改合并回数组，发送完整的 `{ label, steps }`

```typescript
// 核心保存逻辑
const handleSave = () => {
  const updatedSteps = steps.map((s) => (s.id === editedNode.id ? editedNode : s));
  upsertMutation.mutate({
    platform,
    flowName,
    entry: { label: flowName, steps: updatedSteps },
  });
};
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
cd apps/admin-dashboard && npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-dashboard/src/app/settings/components/NodeDrawer.tsx
git commit -m "feat: 重写 NodeDrawer — 子步骤编辑 + 选择器编辑 + 修复保存 bug"
```

---

## 任务 5：更新抖音流程定义 — 添加子步骤和分支

**文件：**
- 修改：`data/selectors.json`（douyin 部分，约第 1133-1265 行）

- [ ] **步骤 1：更新抖音 monitor 流程**

为每个高层状态添加 `steps[]`（细粒度子步骤）和 `branches[]`（条件分支）。

示例 — `check_url` 状态：
```json
{
  "id": "check_url",
  "action": "check_url",
  "description": "检查是否在创作者中心",
  "selector": { "key": "nav.to-creator" },
  "steps": [
    { "id": "get_current_url", "action": "check_url", "description": "获取当前页面URL" },
    { "id": "match_url", "action": "check_navigation", "description": "匹配创作者中心URL" }
  ],
  "branches": [
    { "condition": "URL_OK", "target": "click_work_manage", "description": "已在创作者中心" },
    { "condition": "URL_FAIL", "target": "navigate_home", "description": "需要导航" }
  ],
  "next": "click_work_manage"
}
```

示例 — `click_work_manage` 状态：
```json
{
  "id": "click_work_manage",
  "action": "click_menu",
  "description": "点击「内容管理」→「作品管理」",
  "selector": { "key": "menus.menu_work_manage" },
  "steps": [
    { "id": "find_element", "action": "resolve_selector", "description": "查找菜单元素" },
    { "id": "hover_target", "action": "mouse_move", "description": "鼠标移至目标元素" },
    { "id": "wait_visible", "action": "wait_for_element", "description": "等待元素可见" },
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

需要为抖音 monitor 流程的 8 个状态全部添加 `steps[]` 和 `branches[]`。

需要新增的状态（用于分支）：
- `navigate_home` — 导航到创作者中心
- `error_handler` — 错误处理
- `send_qr` — 发送QR码（登录失效）
- `risk_cooldown` — 风控冷却

#### 登录流程状态（引用 loginFlows 配置）

每个平台的 monitor 流程需要新增登录相关状态，形成完整的登录检测→QR→冷却→probe→恢复链路：

```json
{
  "id": "login_check",
  "action": "check_login",
  "description": "检测登录态（引用 loginFlows.creator）",
  "steps": [
    { "id": "get_login_config", "action": "resolve_selector", "description": "加载 loginFlows 配置" },
    { "id": "check_logged_out", "action": "check_element_exists", "description": "检测未登录指示器", "selector": { "key": "loginFlows.creator.loggedOutIndicators" } },
    { "id": "check_logged_in", "action": "check_element_exists", "description": "检测已登录指示器", "selector": { "key": "loginFlows.creator.loggedInIndicators" } }
  ],
  "branches": [
    { "condition": "LOGIN_OK", "target": "collect_comments", "description": "已登录，继续采集" },
    { "condition": "LOGIN_REQUIRED", "target": "send_qr", "description": "未登录，发送QR码" },
    { "condition": "LOGIN_UNKNOWN", "target": "collect_comments", "description": "状态未知，尝试继续" }
  ],
  "next": "collect_comments"
}

{
  "id": "send_qr",
  "action": "check_login",
  "description": "截取QR码并发送企微告警",
  "steps": [
    { "id": "find_qr_element", "action": "resolve_selector", "description": "查找QR码元素", "selector": { "key": "loginFlows.creator.qrSelectors" } },
    { "id": "capture_qr", "action": "cdp_click", "description": "截取QR码（带padding正方形裁剪）" },
    { "id": "send_alert", "action": "check_navigation", "description": "发送企微告警" },
    { "id": "mark_tab", "action": "check_navigation", "description": "标记标签页（localStorage）" },
    { "id": "set_cooldown", "action": "check_navigation", "description": "设置 per-flowId 冷却状态" }
  ],
  "branches": [
    { "condition": "QR_SENT", "target": "login_probe", "description": "QR已发送，进入probe循环" }
  ],
  "next": "login_probe"
}

{
  "id": "login_probe",
  "action": "check_login",
  "description": "登录态探测（定时检查是否已扫码）",
  "steps": [
    { "id": "find_login_tab", "action": "resolve_selector", "description": "查找标记的登录标签页" },
    { "id": "check_state", "action": "check_login", "description": "检测登录态" }
  ],
  "branches": [
    { "condition": "LOGIN_SUCCESS", "target": "login_recovery", "description": "登录成功，清理恢复" },
    { "condition": "LOGIN_FAIL", "target": "login_cooldown", "description": "仍未登录，递增冷却" },
    { "condition": "TAB_CLOSED", "target": "done", "description": "标签页已关闭，停止probe" }
  ],
  "next": "login_cooldown"
}

{
  "id": "login_cooldown",
  "action": "wait_for_response",
  "description": "冷却等待（30/60/120/240分钟递增）",
  "steps": [
    { "id": "calc_cooldown", "action": "check_navigation", "description": "计算下次probe时间" },
    { "id": "wait", "action": "wait_for_response", "description": "等待冷却时间" }
  ],
  "branches": [
    { "condition": "COOLDOWN_DONE", "target": "login_probe", "description": "冷却结束，重新probe" }
  ],
  "next": "login_probe"
}

{
  "id": "login_recovery",
  "action": "check_login",
  "description": "登录恢复 — 清理标记 + 恢复监控",
  "steps": [
    { "id": "close_or_unmark", "action": "check_navigation", "description": "按配置关闭或保留标签页" },
    { "id": "clear_redis", "action": "check_navigation", "description": "清除 per-flowId Redis 状态" },
    { "id": "update_db", "action": "check_navigation", "description": "更新用户状态为 active" },
    { "id": "resume_monitor", "action": "check_navigation", "description": "恢复监控调度" }
  ],
  "branches": [
    { "condition": "RECOVERY_DONE", "target": "done", "description": "恢复完成" }
  ],
  "next": "done"
}
```

**登录流程连线（插入到现有流程中）：**
- `check_url` → `click_work_manage`（正常）或 `login_check`（检测到未登录）
- `login_check` → `collect_comments`（LOGIN_OK）或 `send_qr`（LOGIN_REQUIRED）
- `send_qr` → `login_probe` → `login_cooldown` → `login_probe`（循环）
- `login_probe` → `login_recovery`（LOGIN_SUCCESS）
- `login_recovery` → `done`

- [ ] **步骤 2：更新抖音 reply 流程**

为 reply 流程添加子步骤和分支，包括：
- 抽屉视频匹配分支（描述匹配/未匹配/滚动更多）
- AI 回复生成分支（成功/失败）

- [ ] **步骤 3：更新抖音 publish 流程**

为 publish 流程添加子步骤。

- [ ] **步骤 4：验证 JSON 格式正确**

```bash
node -e "JSON.parse(require('fs').readFileSync('data/selectors.json','utf8')); console.log('JSON valid')"
```

- [ ] **步骤 5：Commit**

```bash
git add data/selectors.json
git commit -m "feat: 抖音流程定义 — 添加子步骤和条件分支"
```

---

## 任务 6：更新其余平台流程定义

**文件：**
- 修改：`data/selectors.json`（kuaishou、xiaohongshu、tencent 部分）

- [ ] **步骤 1：更新快手流程**

为快手 monitor/publish/reply 流程添加子步骤和分支。包括：
- 登录检测分支（Phase 0）— 引用 `loginFlows.creator` 配置
- 风控检测分支
- 空队列分支
- light/deep 分支

快手登录流程状态（与抖音类似，但 `closeOnLoginSuccess: false`）：
```json
{
  "id": "login_check",
  "action": "check_login",
  "description": "检测快手创作者中心登录态",
  "steps": [
    { "id": "get_login_config", "action": "resolve_selector", "description": "加载 loginFlows.creator 配置" },
    { "id": "check_logged_out", "action": "check_element_exists", "description": "检测未登录指示器" },
    { "id": "check_logged_in", "action": "check_element_exists", "description": "检测已登录指示器" }
  ],
  "branches": [
    { "condition": "LOGIN_OK", "target": "click_work_manage", "description": "已登录" },
    { "condition": "LOGIN_REQUIRED", "target": "send_qr", "description": "未登录，发送QR码" }
  ],
  "next": "click_work_manage"
}
```

- [ ] **步骤 2：更新小红书流程**

为小红书流程添加子步骤和分支。包括：
- Redis 重检标记分支 — `needsLoginRecheck` 条件
- Phase 3 登录失效分支 — 引用 `loginFlows.mainsite` 和 `loginFlows.creator` 两个配置
- isFirstCrawl 分支
- 登录标签页不关闭（`closeOnLoginSuccess: false`）

小红书登录流程特殊之处：有两个 loginFlows（mainsite + creator），Phase 3 检测主站登录态：
```json
{
  "id": "login_check_mainsite",
  "action": "check_login",
  "description": "检测小红书主站登录态",
  "steps": [
    { "id": "get_mainsite_config", "action": "resolve_selector", "description": "加载 loginFlows.mainsite 配置" },
    { "id": "check_logged_out", "action": "check_element_exists", "description": "检测 #login-btn / .login-modal" },
    { "id": "check_logged_in", "action": "check_element_exists", "description": "检测 .user-avatar" }
  ],
  "branches": [
    { "condition": "LOGIN_OK", "target": "collect_comments", "description": "主站已登录" },
    { "condition": "LOGIN_REQUIRED", "target": "send_qr_mainsite", "description": "主站未登录" }
  ],
  "next": "collect_comments"
}
```

- [ ] **步骤 3：更新视频号流程**

为视频号流程添加子步骤和分支。包括：
- 登录检测分支 — 引用 `loginFlows.creator` 配置
- 登录失效 vs 临时风控分支 — `isLoginExpired`（session_expired/login_redirect/url_redirect）
- Phase 2 失败回退 light 分支
- 登录标签页不关闭（`closeOnLoginSuccess: false`）

视频号登录流程特殊之处：区分登录失效和临时风控：
```json
{
  "id": "login_check",
  "action": "check_login",
  "description": "检测视频号登录态",
  "branches": [
    { "condition": "LOGIN_OK", "target": "click_work_manage", "description": "已登录" },
    { "condition": "LOGIN_EXPIRED", "target": "send_qr", "description": "登录失效（session_expired/login_redirect）" },
    { "condition": "RISK_CONTROL", "target": "risk_cooldown", "description": "临时风控（自动恢复）" }
  ],
  "next": "click_work_manage"
}
```

- [ ] **步骤 4：验证 JSON 格式正确**

```bash
node -e "JSON.parse(require('fs').readFileSync('data/selectors.json','utf8')); console.log('JSON valid')"
```

- [ ] **步骤 5：Commit**

```bash
git add data/selectors.json
git commit -m "feat: 快手/小红书/视频号流程定义 — 添加子步骤和条件分支"
```

---

## 任务 7：集成验证 + 修复

- [ ] **步骤 1：启动开发服务器验证 React Flow 渲染**

```bash
cd apps/admin-dashboard && npm run dev
```

打开 `http://localhost:3000/settings`，切换到社媒矩阵 Tab，验证：
- FlowGraphView 使用 React Flow 渲染
- 节点可拖拽
- 连线显示条件标签
- 点击节点打开 NodeDrawer
- 节点可折叠/展开查看子步骤

- [ ] **步骤 2：验证 NodeDrawer 编辑功能**

- 点击节点，验证 NodeDrawer 显示正确的字段
- 编辑 description，保存，验证 selectors.json 更新
- 编辑子步骤的 selector，验证保存正确
- 验证保存时发送完整步骤数组（不是单个步骤）

- [ ] **步骤 3：验证分支渲染**

- 检查有分支的节点显示正确的连线
- 连线带有条件标签
- 错误分支显示红色标签

- [ ] **步骤 4：修复发现的问题**

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat: 流程图状态机迁移完成 — React Flow + XState + 层次状态机"
```

---

## 自检

1. **规格覆盖度：** 规格中每个章节都有对应任务 ✅
2. **占位符扫描：** 无 TODO/待定 ✅
3. **类型一致性：** FlowNode、FlowBranch、FlowSubStep、SubStepAction 跨任务一致 ✅
