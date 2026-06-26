# 反检测系统与数据库重构兼容性修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 douyinCrawler.ts 中反检测系统引入的 19 个 TypeScript 编译错误，确保与数据库重构兼容

**架构：** 逐处修复类型断言、替换私有方法调用、修复 NodeList 迭代，不改变运行时行为

**技术栈：** TypeScript, HumanActions.safeEvaluate, Prisma

**规格：** `docs/superpowers/specs/2026-06-26-anti-detection-db-refactor-compatibility-design.md`

**测试运行命令：**
```bash
cd apps/ts-api-gateway
OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest --config jest.config.js --verbose
```

**TypeScript 编译检查：**
```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler"
```

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 唯一修改文件，修复 19 处 TypeScript 错误 |

---

### 任务 1: 修复 safeEvaluate 返回类型断言（行 1121, 1175）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1121,1175`

- [ ] **步骤 1: 读取行 1115-1130 和 1170-1180 的代码**

```bash
sed -n '1115,1130p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '1170,1180p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 为行 1121 添加 `as string` 断言**

找到类似：
```typescript
rootCid = await HumanActions.safeEvaluate(page, (sel: string) => {
  ...
}, { reason: '...', world: 'main', args: [containerCss] });
```

改为：
```typescript
rootCid = await HumanActions.safeEvaluate(page, (sel: string) => {
  ...
}, { reason: '...', world: 'main', args: [containerCss] }) as string;
```

- [ ] **步骤 3: 为行 1175 添加 `as boolean` 断言**

找到类似：
```typescript
btnFound = await HumanActions.safeEvaluate(page, () => {
  ...
}, { reason: '...', world: 'main' });
```

改为：
```typescript
btnFound = await HumanActions.safeEvaluate(page, () => {
  ...
}, { reason: '...', world: 'main' }) as boolean;
```

- [ ] **步骤 4: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "douyinCrawler.ts(1121\|douyinCrawler.ts(1175"
```
预期：0 个匹配（这两行的错误已修复）

- [ ] **步骤 5: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: safeEvaluate 类型断言行 1121,1175"
```

---

### 任务 2: 修复 safeEvaluate 返回类型断言（行 1478, 1896）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1478,1896`

- [ ] **步骤 1: 读取行 1473-1483 和 1891-1901 的代码**

```bash
sed -n '1473,1483p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '1891,1901p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 为行 1478 添加 `as CommentNode[]` 断言**

找到类似：
```typescript
result = await HumanActions.safeEvaluate(page, (sel: string) => {
  ...
}, { reason: '...', world: 'main', args: [containerCss] });
```

改为：
```typescript
result = await HumanActions.safeEvaluate(page, (sel: string) => {
  ...
}, { reason: '...', world: 'main', args: [containerCss] }) as CommentNode[];
```

- [ ] **步骤 3: 为行 1896 添加 `as { cidCount: number; textCount: number }` 断言**

找到类似：
```typescript
const result = await HumanActions.safeEvaluate(page, () => {
  ...
}, { reason: '...', world: 'main' });
```

改为：
```typescript
const result = await HumanActions.safeEvaluate(page, () => {
  ...
}, { reason: '...', world: 'main' }) as { cidCount: number; textCount: number };
```

- [ ] **步骤 4: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "douyinCrawler.ts(1478\|douyinCrawler.ts(1896"
```
预期：0 个匹配

- [ ] **步骤 5: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: safeEvaluate 类型断言行 1478,1896"
```

---

### 任务 3: 修复 safeEvaluate 返回类型断言（行 2073）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:2073`

- [ ] **步骤 1: 读取行 2068-2078 的代码**

```bash
sed -n '2068,2078p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 为 safeEvaluate 调用添加类型断言**

找到类似：
```typescript
const btnDiagnostic = await HumanActions.safeEvaluate(page, () => {
  ...
}, { reason: '...', world: 'main' });
```

改为（添加返回类型注解和断言）：
```typescript
const btnDiagnostic = await HumanActions.safeEvaluate(page, (): { length: number; text: string } | {} => {
  ...
}, { reason: '...', world: 'main' }) as { length: number; text: string } | {};
```

- [ ] **步骤 3: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "douyinCrawler.ts(2073"
```
预期：0 个匹配

- [ ] **步骤 4: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: safeEvaluate 类型断言行 2073"
```

---

### 任务 4: 替换 withCDPContext 为 safeEvaluate（行 2803）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:2803`

- [ ] **步骤 1: 读取行 2798-2815 的代码**

```bash
sed -n '2798,2815p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 替换 withCDPContext 为 safeEvaluate**

找到类似：
```typescript
const found = await HumanActions.withCDPContext(page, async (ctx) => {
  await ctx.dom.refreshDocument();
  const nodeId = await ctx.cdp.querySelector(selector);
  return nodeId !== null && nodeId > 0;
});
```

改为：
```typescript
const found = await HumanActions.safeEvaluate(page, (sel: string) => {
  return document.querySelector(sel) !== null;
}, { reason: '检查元素存在性', world: 'main', args: [selector] }) as boolean;
```

- [ ] **步骤 3: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "douyinCrawler.ts(2803.*withCDPContext"
```
预期：0 个匹配

- [ ] **步骤 4: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: 替换 withCDPContext 为 safeEvaluate 行 2803"
```

---

### 任务 5: 替换 withCDPContext 为 safeEvaluate（行 3337, 3484）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:3337,3484`

- [ ] **步骤 1: 读取行 3332-3345 和 3479-3492 的代码**

```bash
sed -n '3332,3345p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '3479,3492p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 按任务 4 的模式替换两处 withCDPContext**

每处替换模式相同：`withCDPContext(page, async (ctx) => ...)` → `safeEvaluate(page, () => ..., { reason: '...', world: 'main', args: [...] })`

- [ ] **步骤 3: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "withCDPContext"
```
预期：0 个匹配

- [ ] **步骤 4: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: 替换 withCDPContext 为 safeEvaluate 行 3337,3484"
```

---

### 任务 6: 修复 NodeList 迭代（行 3140, 3148, 3228, 3265）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:3140,3148,3228,3265`

- [ ] **步骤 1: 读取四处代码的上下文**

```bash
sed -n '3135,3155p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '3223,3235p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '3260,3272p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 为每处 NodeList 添加 Array.from()**

找到类似：
```typescript
containers.forEach((c: Element) => { ... });
```

改为：
```typescript
Array.from(containers).forEach((c: Element) => { ... });
```

- [ ] **步骤 3: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "NodeList.*iterator"
```
预期：0 个匹配（douyinCrawler 相关）

- [ ] **步骤 4: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: NodeList 迭代 Array.from() 行 3140,3148,3228,3265"
```

---

### 任务 7: 修复空对象类型（行 3300, 3301, 3303, 3485, 3487）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:3300,3301,3303,3485,3487`

- [ ] **步骤 1: 读取行 3295-3310 和 3480-3492 的代码**

```bash
sed -n '3295,3310p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
sed -n '3480,3492p' apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

- [ ] **步骤 2: 为 safeEvaluate 添加返回类型注解和断言**

找到类似：
```typescript
const btnDiagnostic = await HumanActions.safeEvaluate(page, () => {
  return { length: ..., text: ... };
});
btnDiagnostic.length // 错误
```

改为：
```typescript
const btnDiagnostic = await HumanActions.safeEvaluate(page, (): { length: number; text: string } => {
  return { length: ..., text: ... };
}) as { length: number; text: string };
```

- [ ] **步骤 3: 验证编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -c "douyinCrawler.ts(330[0-3]\|douyinCrawler.ts(348[57]"
```
预期：0 个匹配

- [ ] **步骤 4: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: 空对象类型断言行 3300,3301,3303,3485,3487"
```

---

### 任务 8: 最终验证

- [ ] **步骤 1: 运行 TypeScript 编译检查**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler" | wc -l
```
预期：0（所有 douyinCrawler 相关错误已修复）

- [ ] **步骤 2: 运行全量测试**

```bash
cd apps/ts-api-gateway && OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest --config jest.config.js --verbose 2>&1 | grep -E "Test Suites|Tests:"
```
预期：86/86 通过

- [ ] **步骤 3: 运行审计脚本**

```bash
npx tsx scripts/anti-detection/audit-blindspots.ts
```
预期：输出正常，无新增裸调用

- [ ] **步骤 4: 最终 Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: douyinCrawler 全部 19 处 TypeScript 编译错误修复完成"
```

---

## 自检

1. **规格覆盖度：** 4 类问题（类型断言、withCDPContext、NodeList、空对象）全部有对应任务 ✅
2. **占位符扫描：** 无 TODO/待定 ✅
3. **类型一致性：** 所有断言类型与规格一致 ✅
