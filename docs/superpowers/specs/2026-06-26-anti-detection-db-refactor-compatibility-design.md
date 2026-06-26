# 反检测系统与数据库重构兼容性修复设计

## 背景

两个系统先后合并到 master：
1. **反检测系统** — HumanActions/RequestInterceptor/safeEvaluate + 抖音三功能双路径收口
2. **数据库重构** — prisma.user → platformAccount 重命名 + operator-window 关系改造

合并后 TypeScript 编译发现 19 个错误，全部在 `douyinCrawler.ts`。测试通过（86/86），但编译失败影响 IDE 和 CI。

## 问题清单

### 问题 1: safeEvaluate 返回类型不匹配（7 处）

`safeEvaluate` 返回 `unknown`，但调用方期望具体类型。

| 行号 | 期望类型 | 调用场景 |
|------|---------|---------|
| 1121 | `string` | rootCid = safeEvaluate(...) |
| 1175 | `boolean` | btnFound = safeEvaluate(...) |
| 1478 | `CommentNode[]` | result = safeEvaluate(...) |
| 1896 | `{ cidCount: number; textCount: number }` | result = safeEvaluate(...) |
| 2073 | `unknown` (×3) | btnDiagnostic 的属性访问 |

### 问题 2: 访问私有方法 withCDPContext（3 处）

| 行号 | 原代码 | 问题 |
|------|--------|------|
| 2803 | `HumanActions.withCDPContext(page, async (ctx) => ...)` | 私有方法不应外部调用 |
| 3337 | 同上 | 同上 |
| 3484 | 同上 | 同上 |

### 问题 3: NodeList 迭代（4 处）

| 行号 | 原代码 | 问题 |
|------|--------|------|
| 3140 | `containers.forEach(...)` | TypeScript target 不支持 NodeList 迭代 |
| 3148 | 同上 | 同上 |
| 3228 | 同上 | 同上 |
| 3265 | 同上 | 同上 |

### 问题 4: 空对象类型 `{}`（3 处）

| 行号 | 原代码 | 问题 |
|------|--------|------|
| 3300 | `btnDiagnostic.length` | `{}` 没有 `length` 属性 |
| 3301 | 同上 | 同上 |
| 3303 | 同上 | 同上 |
| 3485 | `btnDiagnostic.x`, `btnDiagnostic.y` | `{}` 没有 `x`/`y` 属性 |
| 3487 | 同上 | 同上 |

## 修复设计

### Fix 1: safeEvaluate 返回类型断言

为每个 `safeEvaluate` 调用添加 `as Type` 断言。

```typescript
// 模式
const result = await HumanActions.safeEvaluate(page, fn, opts) as ExpectedType;
```

**涉及 7 处，类型包括：** `string`, `boolean`, `CommentNode[]`, `{ cidCount: number; textCount: number }`

### Fix 2: 替换 withCDPContext 为 safeEvaluate

将私有方法调用替换为公共 API。

```typescript
// 原代码
const found = await HumanActions.withCDPContext(page, async (ctx) => {
  await ctx.dom.refreshDocument();
  const nodeId = await ctx.cdp.querySelector(selector);
  return nodeId !== null && nodeId > 0;
});

// 修复后
const found = await HumanActions.safeEvaluate(page, (sel: string) => {
  return document.querySelector(sel) !== null;
}, { reason: '检查元素存在性', world: 'main', args: [selector] }) as boolean;
```

**涉及 3 处。** 行为等价：CDP querySelector → document.querySelector。

### Fix 3: NodeList 迭代修复

用 `Array.from()` 包装 NodeList。

```typescript
// 原代码
containers.forEach((c: Element) => { ... });

// 修复后
Array.from(containers).forEach((c: Element) => { ... });
```

**涉及 4 处。**

### Fix 4: 空对象类型修复

为函数添加返回类型注解 + 类型断言。

```typescript
// 原代码
const btnDiagnostic = await HumanActions.safeEvaluate(page, () => {
  return btn ? { length: btn.textContent?.length || 0 } : {};
});
btnDiagnostic.length // 错误

// 修复后
const btnDiagnostic = await HumanActions.safeEvaluate(page, (): { length: number } | {} => {
  return btn ? { length: btn.textContent?.length || 0 } : {};
}) as { length: number } | {};
```

**涉及 5 处。**

## 修复范围

- **唯一修改文件：** `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- **总修改处：** 19 处
- **不涉及：** 数据库 schema、API 路由、前端代码、其他 crawler

## 验证标准

1. `npx tsc --noEmit` 零错误（仅允许预存问题）
2. `OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest` 86/86 通过
3. 运行时行为不变（类型断言不改变运行时逻辑）

## 不在范围内

- 不修改 `safeEvaluate` 的签名（保持返回 `unknown`）
- 不修改 `HumanActions` 类的可见性
- 不修复预存的 TypeScript 配置问题（NodeList 迭代的根本原因是 tsconfig target）
