# 视频监控系统重构设计规格

> 日期：2026-06-19
> 范围：数据源调研（A）、选择器配置系统重构（B）、非公开视频过滤（C）、抽屉匹配重构（D）

---

## A 章：数据源调研与 JSON 结构分析

### A.1 数据源清单与分页方式

| 平台 | 数据源 | API Pattern | 数据源页面 URL | 分页方式 | has_more 语义 |
|------|--------|------------|---------------|---------|--------------|
| 抖音 | work_list（内容管理） | `/work_list` | `creator.douyin.com/creator-micro/content/manage` | 滚动加载 | `body.has_more===true` |
| 抖音 | item_list（作品分析） | `/item/list` | `creator.douyin.com/creator-micro/data-center/content` | 滚动加载 | 同上 |
| 快手 | work_list（内容管理） | `/rest/cp/works/v2/video/pc/photo/list` | `cp.kuaishou.com/article/manage/video` | 滚动加载 | 同上 |
| 快手 | photo_analysis（作品分析） | `/rest/cp/creator/analysis/pc/photo/list` | `cp.kuaishou.com/rest/cp/creator/analysis/pc/photo` | **换页按钮**（已实现） | 同上 |
| 小红书 | note_list（笔记管理） | `/api/galaxy/v2/creator/note/user/posted` | `creator.xiaohongshu.com/new/note-manager` | 滚动加载 | `body.data.page===-1` |
| 视频号 | post_list（内容管理） | `/mmfinderassistant-bin/post/post_list` | `channels.weixin.qq.com/micro/content/post/list` | **换页按钮**（需新增） | `body.data.downContinueFlag===1` |

### A.2 各平台 API 响应 JSON 结构

#### 抖音（work_list / item_list 共享解析）

- 响应体数组路径：`body.items[]` / `body.video_list[]` / `body.aweme_list[]`（多路径探测）
- 字段映射（共享 `parseVideoItem`）：
  - `aweme_id` ← `aweme_id` / `id` / `item_id`
  - `description` ← `description` / `display_title` / `title` / `desc`
  - `create_time` ← `create_time` / `publish_time`（秒级时间戳）
  - `comment_count` ← `comment_count` / `metrics.comment_count`
- 分页：`body.has_more` (bool), `body.cursor` (string)
- 非公开过滤字段：无 API 字段 → 用 `play_count`（观看数）=0 判断
  - **注意**：`parseVideoItem()` 会剥离 `statistics` 字段，`play_count` 不在 `VideoInfo` 中。必须在 `fetchVideoListFromSource` 的 raw response 遍历循环中（现有 author 提取逻辑旁边）二次提取 `raw.statistics?.play_count ?? raw.stat?.play_count`，建立 `Map<aweme_id, number>` 映射表
- 跨源去重标识：`description + create_time` 归一化

#### 快手

- 响应体数组路径：`body.data.list[]` / `body.data.photoList.photoItems[]`（内容管理）、`body.data.analysisList[]`（作品分析）
- 字段映射（共享 `parseVideoItem`）：
  - `aweme_id` ← `workId` / `photoId` / `id`
  - `description` ← `description` / `display_title` / `title`
  - `create_time` ← `create_time` / `publish_time`（秒级时间戳）
  - `comment_count` ← `comment_count` / `metrics.comment_count`
- 分页：`body.has_more` (bool), `body.cursor` (string)
- 非公开过滤字段：`photoStatus`（仅 `work_list` 源有此字段，`photo_analysis` 源无此字段）
  - 过滤条件：`photoStatus !== undefined && photoStatus !== 0`（必须先检查 `undefined`，否则 `photo_analysis` 源所有视频都会被误杀）
- 跨源去重标识：`description + create_time` 归一化

#### 小红书

- 响应体数组路径：`body.data.notes[]`
- 字段映射（共享 `parseVideoItem`）：
  - `aweme_id` ← `note_id` / `noteId` / `id`
  - `description` ← `description` / `display_title` / `title`
  - `create_time` ← `create_time` / `publish_time`（秒级时间戳）
  - `comment_count` ← `comment_count` / `interactInfo.comment_count`
- 分页：`body.data.page === -1` 为最后一页
- 非公开过滤字段：`permission_code !== 0` 为非公开（已实现）
- 去重：单一数据源，无需跨源去重

#### 视频号（自定义解析，不走共享 parseVideoItem）

- 响应体数组路径：`body.data.list[]`（直接读取）
- 字段映射（`TencentVideoInfo` 自定义类型）：
  - `exportId` ← `exportId` / `objectId`
  - `description` ← `desc.description`（嵌套在 desc 对象中）
  - `createTime` ← `createTime`（秒级时间戳）
  - `commentCount` ← `commentCount`
  - `readCount` ← `readCount`（播放量）
  - `visibleType` ← `visibleType`
- 分页：`body.data.downContinueFlag === 1` 有更多
- 非公开过滤字段：`visibleType !== undefined && visibleType !== 1` 为非公开（必须先检查 `undefined`，旧数据可能无此字段）
- 换页按钮选择器：
  - CSS: `#container-wrap > div.container-center > div > div.main-body-wrap > div.main-body > div.weui-desktop-block.main-card > div > div > div > div:nth-child(2) > div.list-wrapper > div.footer.post-list-footer > div > span.weui-desktop-pagination__nav > a`
  - XPath: `//*[@id='container-wrap']/div[2]/div/div[1]/div[2]/div[2]/div/div/div/div[2]/div[2]/div[2]/div/span[1]/a`
  - 按钮文本："下一页"

### A.3 跨数据源视频去重逻辑

- **抖音（2 个数据源）**：`description + create_time` 归一化去重。work_list 和 item_list 对同一视频可能返回不同 aweme_id。
- **快手（2 个数据源）**：同抖音，`description + create_time` 归一化去重。
- **小红书（单一数据源）**：无需跨源去重。
- **视频号（单一数据源）**：无需跨源去重。

---

## B 章：选择器配置系统重构

### B.1 selectors.json 扩展结构

在现有 `platforms.{platform}` 节点下新增 4 个顶层节点。

**selectorStore 兼容性要求**：现有 `selectorStore.ts` 的 `VALID_CATEGORIES` 数组必须扩展为 `['menus', 'buttons', 'regions', 'textboxes', 'apiPatterns', 'dataSources', 'navigationFlows']`，否则 `sanitizeConfig` 会静默丢弃新节点。`FALLBACK_CONFIG` 中每个平台需添加空的 `apiPatterns: {}` 和 `dataSources: {}`。

**新增独立访问函数**：`apiPatterns` 和 `dataSources` 的结构与 `SelectorDef`（css/text）完全不同，不能塞入现有 `getSelector()` → `entryToDef()` 管道。需在 `selectorStore.ts` 中新增 `getApiPattern(platform, key)` 和 `getDataSource(platform, key)` 方法。

```json
{
  "platforms": {
    "douyin": {
      "flowRules": { "..." : "..." },
      "menus": { "..." : "..." },
      "buttons": { "..." : "..." },
      "regions": { "..." : "..." },
      "textboxes": { "..." : "..." },

      "apiPatterns": {
        "video_list.work_list": { "pattern": "/work_list", "description": "内容管理-作品管理API" },
        "video_list.item_list": { "pattern": "/item/list", "description": "数据中心-投稿列表API" },
        "comment_list": { "pattern": "/aweme/v1/web/comment/list/select", "description": "评论列表API" },
        "comment_reply": { "pattern": "/aweme/v1/web/comment/list/reply", "description": "评论回复API" }
      },

      "dataSources": {
        "work_list": {
          "label": "内容管理-作品管理",
          "pageUrl": "https://creator.douyin.com/creator-micro/content/manage",
          "apiPatternKey": "video_list.work_list",
          "pagination": { "type": "scroll", "maxScrolls": 50 },
          "privateFilter": {
            "enabled": true,
            "field": "statistics.play_count",
            "condition": "=== 0",
            "dynamicRemove": true
          },
          "responseArrayPath": ["items", "video_list", "aweme_list", "data.items", "data.list"],
          "hasMoreField": "has_more",
          "cursorField": "cursor"
        },
        "item_list": {
          "label": "数据中心-投稿列表",
          "pageUrl": "https://creator.douyin.com/creator-micro/data-center/content",
          "apiPatternKey": "video_list.item_list",
          "pagination": { "type": "scroll", "maxScrolls": 50 },
          "privateFilter": {
            "enabled": true,
            "field": "statistics.play_count",
            "condition": "=== 0",
            "dynamicRemove": true
          },
          "responseArrayPath": ["items", "video_list", "aweme_list", "data.items", "data.list"],
          "hasMoreField": "has_more",
          "cursorField": "cursor"
        }
      }
    }
  }
}
```

快手、小红书、视频号的 `apiPatterns` 和 `dataSources` 结构类似，字段值按 A 章表格填充。

### B.2 TypeScript 类型定义

```typescript
interface ApiPatternConfig {
  pattern: string;
  description?: string;
}

interface PrivateFilterConfig {
  enabled: boolean;
  field: string;
  condition: string;
  dynamicRemove?: boolean;
  description?: string;
}

interface PaginationScrollConfig {
  type: 'scroll';
  maxScrolls: number;
}

interface PaginationPageConfig {
  type: 'page';
  maxPages: number;
  nextPageBtnSelector?: string;
  nextPageBtnCss?: string;
  nextPageBtnXpath?: string;
  nextPageBtnText?: string;
}

type PaginationConfig = PaginationScrollConfig | PaginationPageConfig;

interface DataSourceConfig {
  label: string;
  pageUrl: string;
  apiPatternKey: string;
  pagination: PaginationConfig;
  privateFilter: PrivateFilterConfig;
  responseArrayPath: string[];
  hasMoreField: string;
  hasMoreCondition?: string;
  cursorField?: string;
}
```

### B.3 导航流程编排模型（精细化）

每个步骤 = 一个原子操作（一个选择器 + 一个判断 + 一个动作）。

步骤类型：
- `check_url` — 检查当前页面 URL
- `check_menu_state` — 检查菜单展开/折叠状态（aria-expanded）
- `click_menu` — 点击菜单项
- `click_tab` — 点击页面内 Tab
- `click_button` — 点击按钮（换页、确认等）
- `enable_interceptor` — 清空拦截器数据缓冲区并准备接收（CDP 监听器始终活跃，此步骤执行 `interceptor.clear(pattern)` 而非注册新监听器）
- `disable_interceptor` — 清空拦截器数据缓冲区（停止接收当前 pattern 的数据）
- `refresh_page` — F5 刷新
- `wait_for_response` — 等待 API 响应
- `check_quantity` — 检查已采集视频数量
- `scroll_load` — 滚动加载更多
- `page_turn` — 点击换页按钮
- `close_menu` — 折叠已展开的菜单
- `done` — 流程结束

#### 抖音完整导航流程

```
s01_check_url → 匹配到 work_list → s03_enable_interceptor_work_list
              → 匹配到 item_list → s06_check_data_center_menu
              → 未匹配         → s02_navigate_default

s02_navigate_default（检查数据中心菜单状态）
  → expanded  → s04_click_content_analysis
  → collapsed → s03_click_data_center_menu

s03_click_data_center_menu → 等待 aria-expanded=true → s04_click_content_analysis

s04_click_content_analysis → 等待 URL 包含 /data-center/content → s05_enable_interceptor_item_list

s05_enable_interceptor_item_list → s06_click_post_list_tab

s06_click_post_list_tab（preAction: 开启旁路监控）→ 等待 API 响应 → s07_check_quantity

s03_enable_interceptor_work_list → s03b_refresh_page → 等待 API 响应 → s07_check_quantity

s06_check_data_center_menu（已在数据中心页面，检查菜单状态）
  → expanded  → s05_enable_interceptor_item_list
  → collapsed → s03_click_data_center_menu

s07_check_quantity
  → enough         → s10_exit_check_menu
  → need_more      → s08_scroll_load

s08_scroll_load → 等待 API 响应 → s07_check_quantity

s10_exit_check_menu（检查菜单是否需折叠）
  → expanded  → s11_close_menu
  → collapsed → s12_done

s11_close_menu → s12_done
```

#### 快手完整导航流程

```
s01_check_url → 匹配到 work_list → s03_enable_interceptor_work_list
              → 匹配到 photo_analysis → s06_check_data_center_menu
              → 未匹配 → s02_navigate_default

s02_navigate_default（检查数据中心菜单状态）
  → expanded  → s04_click_photo_analysis
  → collapsed → s03_click_data_center_menu

s03_click_data_center_menu → s04_click_photo_analysis

s04_click_photo_analysis → s05_enable_interceptor_photo_analysis → s06_refresh_and_wait

s06_refresh_and_wait → s07_check_quantity

s03_enable_interceptor_work_list → s03b_refresh_page → s07_check_quantity

s07_check_quantity（根据 current_source 决定分支）
  → enough → s10_exit_check_menu
  → need_more + source=work_list → s08_scroll_load
  → need_more + source=photo_analysis → s09_page_turn

s08_scroll_load → s07_check_quantity

s09_page_turn（点击下一页按钮，selector: page.next-page-btn）→ s07_check_quantity

s10_exit_check_menu
  → expanded  → s11_close_menu
  → collapsed → s12_done

s11_close_menu → s12_done
```

#### 小红书完整导航流程

```
s01_check_url → 匹配到 note_list → s02_enable_interceptor
              → 未匹配 → s01b_navigate_to_note_manager

s01b_navigate_to_note_manager → s02_enable_interceptor

s02_enable_interceptor → s02b_refresh_page → s03_check_quantity

s03_check_quantity
  → enough    → s05_done
  → need_more → s04_scroll_load

s04_scroll_load → s03_check_quantity

s05_done
```

#### 视频号完整导航流程

```
s01_check_url → 匹配到 post_list → s02_enable_interceptor
              → 未匹配 → s01b_navigate_to_post_list

s01b_navigate_to_post_list → s02_enable_interceptor

s02_enable_interceptor → s02b_refresh_page → s03_check_quantity

s03_check_quantity
  → enough    → s05_done
  → need_more → s04_page_turn

s04_page_turn（点击"下一页"按钮）
  → 检查按钮是否 disabled（disabled → 终止，无更多页）
  → 点击按钮
  → 等待 API 响应 post_list（timeout 15s）
  → 等待按钮状态变化（disabled → enabled 反馈确认）
  → 超时处理：API 响应超时 → 重试 1 次 → 仍超时则终止
  → s03_check_quantity

s05_done
```

### B.4 Debug 日志体系

扩展现有 `TaskExecutionStep` 表：

```typescript
interface TaskExecutionStepExtended {
  // 现有字段...
  curlRequest?: string;
  curlResponse?: string;
  mouseActions?: MouseActionLog[];
  selectorTries?: SelectorTryLog[];
}

interface MouseActionLog {
  action: 'move' | 'click' | 'scroll' | 'wheel' | 'keypress';
  target: string;
  coordinates?: { x: number; y: number };
  selector?: string;
  selectorSource?: 'primary' | 'fallback1' | 'fallback2';
  timestamp: number;
  durationMs?: number;
}

interface SelectorTryLog {
  selector: string;
  source: 'primary' | 'fallback1' | 'fallback2' | 'hardcoded';
  result: 'found' | 'not_found' | 'not_visible';
  elementCount?: number;
  timestamp: number;
}
```

Debug 模式开关：通过 `SystemStatus.isDebugMode` 控制。开启时记录完整 curl + 鼠标操作；关闭时仅记录摘要。

---

## C 章：非公开视频过滤

### C.1 四平台过滤实现

| 平台 | 过滤字段 | JSON 路径 | 过滤条件（必须先检查 undefined） | 当前状态 |
|------|---------|----------|-------------------------------|---------|
| 抖音 | play_count | `statistics.play_count` / `stat.play_count` | `=== 0` 为非公开（`undefined` 视为公开，不过滤） | ❌ 缺失 |
| 快手 | photoStatus | `photoStatus` | `!== undefined && !== 0` 为非公开（`photo_analysis` 源无此字段，必须跳过） | ❌ 缺失 |
| 小红书 | permission_code | `permission_code` | `!== 0` 为非公开（已实现） | ✅ 已实现 |
| 视频号 | visibleType | `visibleType` | `!== undefined && !== 1` 为非公开（旧数据可能无此字段） | ❌ 缺失 |

**关键约束**：所有过滤条件必须先检查 `!== undefined`，否则缺失字段会被误判为非公开，导致整源视频被误杀。

### C.2 抖音实现

在 `douyinCrawler.ts` 的 `fetchVideoListFromSource` 中：

1. 从 raw response 二次提取 `play_count`：
   - **注意**：`parseVideoItem()` 会剥离 `statistics` 字段，`allItems` 中的 `VideoInfo` 不含 `play_count`
   - 在现有 raw response 遍历循环中（L336-360，与 author 提取并行），提取 `raw.statistics?.play_count ?? raw.stat?.play_count ?? raw.play_count`
   - 建立 `Map<string, number>` 映射：`awemeIdToPlayCount`

2. 切片过滤：在 `sliced` 之后（L366-373），用映射表过滤：
   - `play_count === 0` → 排除（非公开视频）
   - `play_count === undefined`（-1）→ **保留**（字段缺失视为公开）

3. 已入库视频动态剔除：下次探测时发现 `play_count` 变为 0 则从数据库删除，并按时间排序补入下一个 `play_count > 0` 的视频

4. 滚动加载补充：过滤后数量不足 20 个时继续滚动加载

### C.3 快手实现

在 `kuaishouCrawler.ts` 的 `fetchVideoListFromSource` 中：

1. 从 raw response 提取 `photoStatus`：`raw.photoStatus ?? raw.status`

2. 切片过滤：
   - `photoStatus !== undefined && photoStatus !== 0` → 排除（非公开/异常）
   - `photoStatus === undefined` → **保留**（字段缺失视为公开，`photo_analysis` 源无此字段）

3. 已入库视频动态剔除：同抖音逻辑

4. `photo_analysis` 源天然无非公开，但因 raw items 无 `photoStatus` 字段，过滤逻辑会安全跳过（`undefined` 不过滤）

### C.4 小红书

已实现，无需改动。现有逻辑：`permission_code === 0` 为公开。

### C.5 视频号实现

在 `tencentCrawler.ts` 的 `checkForUpdates` 中（L866 `commentClose` 过滤之后）：

1. 新增 `visibleType` 过滤：
   - `visibleType !== undefined && visibleType !== 1` → 跳过（非公开）
   - `visibleType === undefined` → **保留**（旧数据可能无此字段）

2. 已入库视频动态剔除：同抖音逻辑

### C.6 数据库剔除与补入

```
removePrivateVideoAndReplace(db, userId, platform, privateVideoId, newVideo):
  1. 删除非公开视频（级联删除 Comment 表）
  2. 按 create_time 降序取下一个 play_count > 0 的视频
  3. 插入数据库
  4. 记录日志
```

---

## D 章：抽屉匹配重构

### D.1 四平台 DOM 时间格式

| 平台 | DOM 时间格式 | 示例 | 解析精度 |
|------|------------|------|---------|
| 抖音 | `发布于YYYY年MM月DD日 HH:MM` | `发布于2026年05月25日 14:43` | 分钟 |
| 快手 | `YYYY-MM-DD HH:MM:SS` | `2026-05-28 09:03:19` | 秒 |
| 小红书 | `YYYY-MM-DD HH:MM` | `2026-06-18 18:01` | 分钟 |
| 视频号 | `YYYY/MM/DD HH:MM` | `2026/06/13 13:58` | 分钟 |

### D.2 匹配策略

核心算法：

```
对每个 DOM 容器：
  1. 提取时间文本 → parseDomTimestamp() → Unix 秒级时间戳
  2. 计算时间差：|domTimestamp - video.create_time|
  3. 时间差 ≤ 60 秒 → 时间匹配
  4. 时间匹配后，检查容器文本是否包含 description 前 20 字符 → 双重确认
  5. 双重确认通过 → 匹配成功，点击该容器
  6. 如果时间匹配但 description 不匹配 → 记录日志，继续检查其他容器（可能是同时间发布的不同视频）
```

时间容差：±60 秒（覆盖 DOM 时间精度不足的情况。DOM 时间精度到分钟，最坏情况 API 时间戳为 MM:59，DOM 显示 MM:00，差 59 秒）

**第三重确认（可选）**：如果同一分钟内有多个视频且 description 前 20 字符相同，则比较完整 description 或容器中可见的评论数。

### D.3 通用时间解析函数

```typescript
function parseDomTimestamp(containerText: string, platform: string, timezoneOffset: string = '+08:00'): number | null {
  switch (platform) {
    case 'douyin':     // 发布于2026年05月25日 14:43
    case 'kuaishou':   // 2026-05-28 09:03:19
    case 'xiaohongshu': // 2026-06-18 18:01
    case 'tencent':    // 2026/06/13 13:58
  }
}
```

各平台正则匹配规则见实现代码。

**时区处理**：`timezoneOffset` 作为参数传入（默认 `+08:00`），不硬编码。未来扩展海外平台时可配置。所有平台当前都是中国平台，DOM 时间均为 UTC+8。

**正则精确性**：抖音容器 textContent 包含大量 SVG 文本和数字，正则必须精确匹配"发布于"前缀避免误匹配。各平台正则规则：
- 抖音：`/发布于(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/`
- 快手：`/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/`
- 小红书：`/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/`
- 视频号：`/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/`

### D.4 四平台容器选择器

| 平台 | 视频容器选择器 | 滚动容器选择器 | shadow DOM |
|------|--------------|--------------|------------|
| 抖音 | `drawer.video-item` → `[class*="douyin-creator-interactive-list-items"] > div` | `.douyin-creator-interactive-sidesheet-body` | 否 |
| 快手 | `.video-item` → `.video-info__content` | `.auto-load-list` | 否 |
| 小红书 | 无抽屉（新标签页），直接用 `noteId` CSS 选择器 | 不适用 | 否 |
| 视频号 | `.comment-feed-wrap` | `.feeds-container` | **是**（wujie 微前端） |

**视频号 shadow DOM 特殊处理**：视频号视频列表在 wujie 微前端的 shadow DOM 内。CDP 的 `DOM.querySelectorAll` 可能无法穿透 shadow DOM，需要走 `page.evaluate` 路径（类似现有 `scrollToFindVideo` 的实现），通过 `document.querySelector('wujie-app').shadowRoot.querySelectorAll('.comment-feed-wrap')` 获取元素。时间文本在 `.feed-time` 子元素中（DOM 中已确认存在）。

### D.5 边界处理

抖音抽屉"没有更多视频"标记：滚动前先检测 `.loading-_6JQ2i` 是否包含"没有更多视频"文本，如果是则直接返回失败，避免无意义的 25 次滚动。

### D.6 VideoInfo 接口统一

```typescript
interface VideoInfo {
  aweme_id: string;        // 视频唯一ID
  description: string;     // 视频描述/标题
  create_time: number;     // 发布时间戳（秒）
  comment_count: number;   // 评论数
  metrics: Record<string, any>;
  authorUid?: string;
  authorNickname?: string;
}
```

视频号映射：`exportId` → `aweme_id`，`desc.description` → `description`，`createTime` → `create_time`。

**视频号 exportId 编码**：视频号 `exportId` 格式为 `"export/UzFfBgAA..."`，包含 `/` 字符。作为数据库 `Video.id` 主键在 PostgreSQL 中无问题，但在 URL 路由、文件路径场景可能引起问题。入库前需 `encodeURIComponent(exportId)` 或 `exportId.replace(/\//g, '_')` 进行安全编码，读取时反向解码。

---

## 交付顺序

```
A 章（数据源调研） → B/C/D 并行
  B 章：选择器配置系统重构
  C 章：非公开视频过滤
  D 章：抽屉匹配重构
```

## 关键依赖

- C 章依赖 A 章的非公开过滤字段确认
- D 章依赖 A 章的时间戳格式确认
- B 章依赖 A 章的 API Pattern 和数据源清单
- C 章和 D 章相互独立，可并行实现
