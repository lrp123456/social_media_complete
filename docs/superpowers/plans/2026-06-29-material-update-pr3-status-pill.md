# PR3: 运行状态 StatusPill + 页面跳转

## 概述

PR3 在 PR1 基础上，为素材更新管线添加运行健康度检测和可视化：

- **后端**：`computeRunHealth` 纯函数 + `runState.warnings` + `/status` endpoint 返回 `runHealth`
- **前端**：运行状态面板每个平台行 + 整体 StatusPill + PlatformCard 红点角标 + 跳转

## 关键约束

1. `runState` 新增 `warnings: Array<{kind, platformId, platformName, message}>`，不修改其他字段
2. `computeRunHealth` 抽成纯函数便于单测
3. 不修改 `runMaterialUpdate` 主流程（PR1 已完成）
4. StatusPill 使用现有组件：`tone="error"`（no_keys）/ `tone="warning"`（其他）

---

## Task 1: 新建 `computeRunHealth` 纯函数 + 单测

**文件**：`apps/ts-api-gateway/src/services/materialRunHealth.ts`

```typescript
export type RunHealthKind = 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch' | 'ok';

export interface PlatformHealth {
  platformId: string;
  platformName: string;
  health: RunHealthKind;
  message: string;
}

export interface RunHealthResult {
  overall: RunHealthKind;
  platforms: PlatformHealth[];
  warnings: PlatformHealth[];  // 仅包含非 ok 的平台
}
```

**计算逻辑**（按平台）:
- `no_keys`: `platformKeyCount === 0`
- `all_keys_cooldown`: 所有 key 冷却中（`availableKeyCount === 0`）
- `parse_mismatch`: key 可用但采集到 0 视频（`fetched === 0`）
- `ok`: 以上均不满足

**整体**：取最差状态（`no_keys > parse_mismatch > all_keys_cooldown > ok`）

**测试**：`apps/ts-api-gateway/src/services/__tests__/materialRunHealth.test.ts`
- 各状态至少一个 case
- 混合平台场景
- 全部 ok 场景

## Task 2: 集成到 `materialUpdateService.ts`

### 2a. `runState` 增加 `warnings` 字段

```typescript
interface Warning {
  kind: 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch';
  platformId: string;
  platformName: string;
  message: string;
}

interface RunState {
  running: boolean;
  lastRunAt: number | null;
  lastResult: Record<string, { fetched: number; newCandidates: number; errors: string[] }>;
  warnings: Warning[];
  runHealth: RunHealthKind;
}
```

### 2b. 在 `runMaterialUpdate` 末尾计算并存储

在 `runMaterialUpdate` 函数末尾（`runState.running = false` 之前），调用 `computeRunHealth` 写入 `runState.warnings` 和 `runState.runHealth`。

需要传递：
- 各平台 key 是否冷却的信息（可从 `config.keyCooldownState` 获取）
- 各平台采集结果（`runState.lastResult` 中已有 `fetched` 信息）
- 各平台 key 配置（从 `config.platforms` 获取）

### 2c. 导出 `warnings` 和 `runHealth`

`getRunState` 已返回 `runState` spread，新字段自动暴露。

## Task 3: `/material-update/status` 返回 `runHealth`

在 `GET /status` 响应中增加：

```typescript
{
  success: true,
  data: {
    running: ...,
    lastRunAt: ...,
    lastResult: ...,
    platforms: [...],
    candidateCounts: {...},
    runHealth: 'ok' | 'no_keys' | 'all_keys_cooldown' | 'parse_mismatch',
    warnings: [{ kind, platformId, platformName, message }],
  }
}
```

TypeScript 类型检查确保通过。

## Task 4: MaterialTab.tsx 运行状态面板增强

### 4a. 整体 StatusPill

在「运行状态」面板 header 区域，根据 `statusQuery.data.runHealth` 显示：

| runHealth | tone | icon | 文本 |
|-----------|------|------|------|
| ok | success | check_circle | 运行正常 |
| no_keys | error | key_off | 存在未配置 Key 的平台 |
| all_keys_cooldown | warning | timer_off | 所有 Key 均冷却中 |
| parse_mismatch | warning | warning | 存在解析异常的平台 |

### 4b. 每个平台行的 StatusPill

当前「运行状态」面板已有平台行，在行末尾添加 StatusPill：

- 获取 `statusQuery.data.warnings` 中匹配 `platformId` 的 warning
- `no_keys` → `tone="error"` → 文字 "未配置 Key"
- `all_keys_cooldown` → `tone="warning"` → 文字 "Key 冷却中"
- `parse_mismatch` → `tone="warning"` → 文字 "解析异常"
- 无 warning → `tone="success"` → 文字 "正常"

### 4c. 设置 `data-platform-id` 属性

每个平台行添加 `data-platform-id={p.platformId}` 供跳转定位。

## Task 5: PlatformCard.tsx 红点角标

### 5a. 新增 `hasWarning` prop

```typescript
interface PlatformCardProps {
  // ... 现有 props
  hasWarning?: boolean;
}
```

### 5b. 红点渲染

当 `hasWarning === true` 时，在卡片右上角（`AccentBar` 同侧）显示红点：

```
<div className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-error" />
```

### 5c. `data-platform-id` 锚点

卡片根元素添加 `data-platform-id={platform.id}`。

## Task 6: 「前往设置」跳转逻辑

### 6a. 警告行添加跳转链接

在「运行状态」面板中，对有 warning 的平台行，在 StatusPill 旁添加"前往设置"链接：

```tsx
<button onClick={() => scrollToPlatform(p.platformId)} className="text-xs text-primary hover:underline">
  前往设置
</button>
```

### 6b. `scrollToPlatform` 函数

```typescript
const scrollToPlatform = (platformId: string) => {
  const el = document.querySelector(`[data-platform-id="${platformId}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
```

## Task 7: 类型检查 + 测试 + Commit

- 后端 `npx tsc --noEmit`
- 前端 `npx tsc --noEmit`
- 运行 `computeRunHealth` 单测
- 提交 commit

---

## 冒烟测试清单

- [ ] `computeRunHealth` 单测通过（4 种状态 + 混合场景）
- [ ] 后端 tsc 无报错
- [ ] 前端 tsc 无报错
- [ ] `/status` 返回 `runHealth` 和 `warnings`
- [ ] MaterialTab 运行状态面板显示每个平台健康状态
- [ ] 整体 StatusPill 根据 runHealth 变化
- [ ] PlatformCard 显示红点角标
- [ ] 点击"前往设置"滚动到对应 PlatformCard
