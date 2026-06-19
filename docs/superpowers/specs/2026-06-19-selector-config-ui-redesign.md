# 前端选择器配置 UI 重构设计规格

> 日期：2026-06-19
> 范围：前端选择器配置界面重构为流程编排视图，新增 apiPatterns/dataSources/navigationFlows/frameworks 的可视化编辑

---

## 1. 流程图节点类型与数据模型

### 1.1 节点类型

流程图中的每个卡片节点对应 `navigationFlows` 中的一个步骤：

| 节点类型 | 图标 | 颜色 | 可配置内容 |
|---------|------|------|-----------|
| `check_url` | 🔗 | 蓝 | URL 匹配规则列表（urlContains → dataSource → 下一步ID） |
| `check_menu_state` | 📂 | 紫 | 选择器（primary+fallbacks）、aria-expanded 检查属性、分支（expanded/collapsed） |
| `click_menu` | 🖱️ | 绿 | 选择器（primary+fallbacks）、等待条件（attribute/urlContains/apiResponse） |
| `click_tab` | 📑 | 绿 | 选择器、preAction（开启旁路监控）、等待条件 |
| `enable_interceptor` | 👁️ | 橙 | API pattern key（引用 apiPatterns） |
| `refresh_page` | 🔄 | 青 | 等待条件（apiResponse） |
| `check_quantity` | 🔢 | 黄 | maxVideos、分支（enough/need_more_scroll/need_more_page） |
| `scroll_load` | ⬇️ | 灰 | scrollConfig（maxScrolls、scrollDelta） |
| `page_turn` | ➡️ | 灰 | 换页按钮选择器（CSS/XPath/文本）、等待条件 |
| `close_menu` | 📕 | 红 | 选择器 |
| `done` | ✅ | 绿 | 无 |

### 1.2 节点卡片展示信息

每个卡片节点在流程图上显示：
- 步骤 ID（如 `s04_click_content_analysis`）
- 描述文字（如"点击二级菜单作品分析"）
- 节点类型图标+颜色
- 关键配置摘要（如选择器前 30 字符、API pattern 名等）
- 连线箭头指向下一步（分支节点有多条连线，标注分支条件）

### 1.3 执行状态展示

节点卡片右上角显示上次执行状态色点：
- 🟢 绿：上次执行成功，主选择器命中
- 🟡 黄：上次执行成功，但回退到备用选择器
- 🔴 红：上次执行失败
- ⚪ 灰：从未执行过

卡片底部显示：
- 上次执行耗时（如 `2s`、`126045ms`）
- 执行时间戳
- 各选择器命中状态（✓主选择器 ✗备用1）

数据来源：后端 `TaskExecutionStep` 表，通过 `GET /navigation-flows/:platform/:flowName/last-run` API 查询。

### 1.4 数据模型

```typescript
interface FlowNode {
  id: string;                    // s04_click_content_analysis
  action: StepAction;            // click_menu
  description: string;           // 点击二级菜单"作品分析"
  selector?: SelectorConfig;     // DOM选择器（部分节点有）
  apiPatternKey?: string;        // 引用 apiPatterns（enable_interceptor 节点）
  waitFor?: {                    // 等待条件
    attribute?: { name: string; value: string; timeout: number };
    urlContains?: string;
    apiResponse?: string;
    timeout: number;
  };
  branches?: Record<string, { goto: string }>;
  next?: string;
  maxVideos?: number;            // check_quantity 特有
  scrollConfig?: { maxScrolls: number; scrollDelta: number }; // scroll_load 特有
  nextPageBtn?: { css?: string; xpath?: string; text?: string }; // page_turn 特有
}
```

### 1.5 流程图布局

- 纵向流水线（与现有 FlowView 一致方向）
- 分支节点（check_url、check_menu_state、check_quantity）有多条向右展开的连线
- 退出阶段（close_menu、done）用虚线连线区分
- 平台标签栏切换不同平台的流程图

---

## 2. 右侧抽屉编辑器

点击流程图中的节点卡片，右侧滑出抽屉面板（宽度 480px），编辑该节点的所有配置。

### 2.1 通用结构

- 顶部：返回按钮 + 步骤ID
- 节点类型标签 + 可编辑描述
- 折叠区：DOM 选择器、等待条件、分支/后续
- 底部：保存/取消

### 2.2 各节点类型的特有配置区

| 节点类型 | 特有配置区 |
|---------|-----------|
| `check_url` | URL 匹配规则表格：urlContains / dataSource / goto（下拉选择其他节点ID） |
| `enable_interceptor` | API Pattern 选择器（下拉引用 apiPatterns 中的 key）+ 展开编辑 pattern 详情 |
| `check_quantity` | maxVideos 输入框 + 分支配置 |
| `scroll_load` | maxScrolls + scrollDelta 输入框 |
| `page_turn` | 换页按钮配置：CSS / XPath / 按钮文本 + 等待条件 |

### 2.3 API Pattern 编辑区（enable_interceptor 节点）

点击 enable_interceptor 节点的抽屉中，除了选择引用哪个 apiPattern，还可展开编辑详情：
- Pattern 字符串（如 `/work_list`）
- 描述
- 响应数组路径（多个 JSON 路径按顺序探测）
- 分页配置（hasMore 字段路径、条件、cursor 字段路径）
- 私密过滤配置（启用开关、过滤字段路径、条件、动态剔除开关）
- 数据提取规则（字段映射表：字段名 ← 候选路径列表）

### 2.4 交互细节

- 自动保存（debounce 1 秒），顶部显示"已保存"状态
- 未保存警告：关闭抽屉时弹出确认
- 节点跳转：分支/后续区中的节点 ID 可点击链接，切换到目标节点抽屉
- 实时校验：JSON 路径格式、选择器格式实时校验，错误标红

---

## 3. 选择器类型与容器作用域

### 3.1 选择器类型（固定 4 种）

| 类型 | 语法示例 | 底层实现 |
|------|---------|---------|
| `role` | `getByRole("menuitem", name="评论管理")` | CDP + ARIA 属性匹配 |
| `text` | `getByText("span", "发布", {exact: true})` | CDP + textContent 匹配 |
| `xpath` | `//*[@id="container-wrap"]/div[2]` | Runtime.evaluate + document.evaluate |
| `css` | `#douyin-creator-master-menu-nav-data-center` | CDP DOM.querySelector |

### 3.2 平台大框架容器（frameworks）

在 `selectors.json` 中新增 `frameworks` 节点，集中配置每个平台的大框架容器，所有选择器共享引用。

示例（抖音）：
```json
{
  "frameworks": {
    "sidebar": { "label": "侧边栏菜单", "selector": "#douyin-creator-master" },
    "main_content": { "label": "主内容区域", "selector": ".douyin-creator-master-content" },
    "drawer": { "label": "选择作品抽屉", "selector": ".douyin-creator-interactive-sidesheet" },
    "comment_area": { "label": "评论区", "selector": ".douyin-creator-interactive-tabs-content" }
  }
}
```

### 3.3 选择器配置（每个选择器独立配置作用域）

```typescript
interface ScopedSelector {
  type: SelectorType;           // role | text | xpath | css
  value: string;                // 选择器表达式
  scopeMode?: 'none' | 'framework' | 'custom';
  frameworkKey?: string;        // scopeMode='framework' 时引用 frameworks 的 key
  subContainer?: string;        // framework 内的子容器 CSS（可选，两层嵌套）
  customContainer?: string;     // scopeMode='custom' 时的自定义 CSS 容器
  filterTag?: string;           // HTML 标签约束
  filterText?: string;          // 文本精确匹配
}

interface SelectorConfig {
  primary: ScopedSelector;
  fallbacks: ScopedSelector[];
}
```

### 3.4 四种作用域模式

| scopeMode | 含义 | 运行时行为 |
|-----------|------|-----------|
| `none` | 不使用任何容器 | `document.querySelectorAll(value)` 全局查找 |
| `framework` | 引用大框架容器 | `frameworks[frameworkKey].querySelector(subContainer).querySelectorAll(value)` |
| `custom` | 自定义外部容器 | `document.querySelector(customContainer).querySelectorAll(value)` |

每个主/备选择器独立选择是否用大框架以及用哪个——不是整个节点共享一个框架配置。

### 3.5 运行时查找逻辑

```javascript
function findInScope(document, selector, frameworks) {
  let root = document;

  if (selector.scopeMode === 'framework' && selector.frameworkKey) {
    const fw = frameworks[selector.frameworkKey];
    if (!fw) return [];
    root = document.querySelector(fw.selector);
    if (!root) return [];
    if (selector.subContainer) {
      root = root.querySelector(selector.subContainer);
      if (!root) return [];
    }
  } else if (selector.scopeMode === 'custom' && selector.customContainer) {
    root = document.querySelector(selector.customContainer);
    if (!root) return [];
  }

  // 按类型查找
  let elements;
  if (selector.type === 'xpath') {
    elements = document.evaluate(selector.value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    elements = Array.from({ length: elements.snapshotLength }, (_, i) => elements.snapshotItem(i));
  } else if (selector.type === 'role') {
    elements = root.querySelectorAll('[role]');
    elements = elements.filter(el => /* ARIA 属性匹配 */);
  } else if (selector.type === 'text') {
    elements = root.querySelectorAll('*');
    elements = elements.filter(el => /* textContent 匹配 */);
  } else {
    elements = root.querySelectorAll(selector.value);
  }

  // 过滤条件
  if (selector.filterTag || selector.filterText) {
    elements = elements.filter(el => {
      if (selector.filterTag && el.tagName !== selector.filterTag) return false;
      if (selector.filterText && el.textContent.trim() !== selector.filterText) return false;
      return true;
    });
  }

  return elements;
}
```

### 3.6 向后兼容

现有 `primary: string` + `selectorType: string` 格式自动识别为旧格式，运行时转换为 `{ type: selectorType, value: primary, scopeMode: 'none' }`。

---

## 4. 后端 API 设计

### 4.1 新增 API 端点

#### apiPatterns CRUD

| 方法 | 路径 |
|------|------|
| GET | `/config-automation/api-patterns/:platform` |
| PUT | `/config-automation/api-patterns/:platform/:key` |
| DELETE | `/config-automation/api-patterns/:platform/:key` |

#### dataSources CRUD

| 方法 | 路径 |
|------|------|
| GET | `/config-automation/data-sources/:platform` |
| PUT | `/config-automation/data-sources/:platform/:key` |
| DELETE | `/config-automation/data-sources/:platform/:key` |

#### navigationFlows CRUD

| 方法 | 路径 |
|------|------|
| GET | `/config-automation/navigation-flows/:platform` |
| PUT | `/config-automation/navigation-flows/:platform/:flowName` |
| DELETE | `/config-automation/navigation-flows/:platform/:flowName` |
| GET | `/config-automation/navigation-flows/:platform/:flowName/last-run` |

#### frameworks CRUD

| 方法 | 路径 |
|------|------|
| GET | `/config-automation/frameworks/:platform` |
| PUT | `/config-automation/frameworks/:platform/:key` |
| DELETE | `/config-automation/frameworks/:platform/:key` |

### 4.2 PUT 请求体格式

**apiPattern：** pattern, description, responseArrayPath[], hasMoreField, hasMoreCondition, cursorField, fieldMappings

**dataSource：** label, pageUrl, apiPatternKey, pagination, privateFilter, responseArrayPath[], hasMoreField, hasMoreCondition, cursorField

**navigationFlow（单节点）：** id, action, description, selector, apiPatternKey, waitFor, branches, next, maxVideos, scrollConfig, nextPageBtn

**framework：** label, selector, description

### 4.3 selectorStore 扩展

`VALID_CATEGORIES` 新增 `frameworks`。`sanitizeConfig` 透传。新增 `getFrameworks()` / `getFramework()` 函数。

### 4.4 last-run API

查询 `TaskExecutionStep` 表，返回最近一次执行该流程的步骤列表（状态、耗时、selectorTries）。

---

## 5. 前端组件架构

### 5.1 视图替换策略

完全替代现有的"列表/流程/URL监控"三视图。

### 5.2 组件清单

| 组件 | 文件 | 职责 |
|------|------|------|
| `FlowGraphView` | `selectors/FlowGraphView.tsx`（重构） | 流程图主视图 |
| `FlowNodeCard` | `selectors/FlowNodeCard.tsx`（新建） | 单个节点卡片 |
| `NodeDrawer` | `selectors/NodeDrawer.tsx`（新建） | 右侧抽屉编辑器 |
| `SelectorEditor` | `selectors/SelectorEditor.tsx`（新建） | DOM选择器编辑器 |
| `FrameworkManager` | `selectors/FrameworkManager.tsx`（新建） | 大框架管理弹窗 |
| `ApiPatternManager` | `selectors/ApiPatternManager.tsx`（新建） | API Pattern 管理弹窗 |
| `DataSourceManager` | `selectors/DataSourceManager.tsx`（新建） | DataSource 管理弹窗 |
| `FieldMappingEditor` | `selectors/FieldMappingEditor.tsx`（新建） | 字段映射编辑器 |

### 5.3 现有文件处理

| 文件 | 处理方式 |
|------|---------|
| `selectors/page.tsx` | 重构——删除三视图切换，替换为 FlowGraphView |
| `selectors/FlowView.tsx` | 删除——被 FlowGraphView 替代 |
| `lib/selectorFlows.ts` | 删除——navigationFlows 直接定义流程 |
| `hooks/useApi.ts` | 扩展——新增类型定义和 hooks |
| `settings/page.tsx` 选择器子面板 | 保留——作为简化版表格视图 |

---

## 6. 数据迁移与向后兼容

### 6.1 现有数据迁移策略

- **传统选择器（menus/buttons/regions/textboxes）**：不迁移，保留运行时兼容。流程图中引用传统条目时双向同步。
- **urlMonitors**：逐步迁移到 apiPatterns + dataSources。后端启动时自动合并。
- **flowRules**：保留，本次不迁移。navigationFlows 专注监控/评论回复流程。

### 6.2 选择器格式兼容

运行时自动检测：`primary` 是字符串→旧格式，是对象→新格式。旧格式自动转换为新格式（scopeMode='none'）。

### 6.3 selectors.json 初始化

四平台的 frameworks 节点初始化（基于 DOM 文件分析）：

**抖音：**
- `sidebar`: `#douyin-creator-master`
- `main_content`: `.douyin-creator-master-content`
- `drawer`: `.douyin-creator-interactive-sidesheet`
- `comment_area`: `.douyin-creator-interactive-tabs-content`

**快手/小红书/视频号：** 需在实现阶段从 DOM 文件确认精确选择器。

---

## 关键依赖

- 后端 selectorStore 已支持 apiPatterns/dataSources/navigationFlows（本分支已实现）
- selectors.json 已包含 apiPatterns/dataSources 数据（本分支已实现）
- 前端类型定义和 hooks 需要扩展
- frameworks 节点需新增到 selectorStore VALID_CATEGORIES
