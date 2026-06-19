# 视频监控系统重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构视频监控系统：外置化选择器配置、私密视频过滤、抽屉匹配改用时间戳+标题

**架构：** 扩展 selectors.json 新增 apiPatterns/dataSources 配置节点，在各 Crawler 的 fetchVideoListFromSource 中新增私密视频过滤（二次提取 raw response 字段），在 findAndClickVideoInDrawer 中用 parseDomTimestamp + description 双重匹配替代纯文本匹配

**技术栈：** TypeScript, Playwright CDP, Prisma, PostgreSQL

**设计文档：** `docs/superpowers/specs/2026-06-19-video-monitoring-redesign-design.md`

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|---------|
| `data/selectors.json` | 选择器配置（含新增 apiPatterns/dataSources） | 修改 |
| `apps/ts-api-gateway/src/lib/selectorStore.ts` | 选择器配置加载/校验/访问 | 修改 |
| `packages/browser-core/src/interceptor.ts` | 共享 parseVideoItem / extractItems | 不修改（二次提取在 Crawler 层） |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音爬虫 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫 | 修改 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 视频号爬虫 | 修改 |
| `apps/ts-api-gateway/src/crawlers/timeParser.ts` | 新增：四平台 DOM 时间解析工具 | 创建 |
| `apps/ts-api-gateway/src/crawlers/timeParser.test.ts` | 新增：时间解析单元测试 | 创建 |

---

## Phase 1: 基础设施（B 章）

### 任务 1：扩展 selectorStore — VALID_CATEGORIES + sanitizeConfig + FALLBACK_CONFIG

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/selectorStore.ts`

- [ ] **步骤 1：扩展 VALID_CATEGORIES**

在 `selectorStore.ts` L81，将：
```typescript
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes'];
```
改为：
```typescript
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes', 'apiPatterns', 'dataSources', 'navigationFlows'];
```

- [ ] **步骤 2：扩展 sanitizeConfig 透传新节点**

在 `selectorStore.ts` L223，`sanitizeConfig` 函数中 `out` 变量初始化处，将：
```typescript
const out: Record<string, Record<string, unknown>> = { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {} };
```
改为：
```typescript
const out: Record<string, Record<string, unknown>> = { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {} };
```

在 L237 `out.urlMonitors` 透传之后，新增：
```typescript
// 透传 apiPatterns / dataSources / navigationFlows 字段（不做 purposes 校验）
out.apiPatterns = (p.apiPatterns || {}) as Record<string, unknown>;
out.dataSources = (p.dataSources || {}) as Record<string, unknown>;
out.navigationFlows = (p.navigationFlows || {}) as Record<string, unknown>;
```

- [ ] **步骤 3：扩展 FALLBACK_CONFIG**

在 `selectorStore.ts` L62-65，每个平台的 fallback 中新增空节点：
```typescript
douyin: {
  // ... 现有 menus/buttons/regions/textboxes/flowRules/urlMonitors ...
  apiPatterns: {},
  dataSources: {},
  navigationFlows: {},
},
kuaishou: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {} },
xiaohongshu: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {} },
```

- [ ] **步骤 4：新增 getApiPattern 和 getDataSource 访问函数**

在 `selectorStore.ts` 文件末尾（`reloadSelectorReader` 函数之前），新增：

```typescript
/**
 * 从 selectors.json 读取 apiPattern 配置
 * @returns pattern 字符串，未找到返回 undefined
 */
export function getApiPattern(platform: string, key: string): string | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.apiPatterns?.[key]) return undefined;
  return p.apiPatterns[key].pattern;
}

/**
 * 从 selectors.json 读取 dataSource 配置
 * @returns DataSourceConfig 对象，未找到返回 undefined
 */
export function getDataSource(platform: string, key: string): Record<string, any> | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.dataSources?.[key]) return undefined;
  return p.dataSources[key];
}

/**
 * 从 selectors.json 读取所有 dataSource 配置
 */
export function getDataSources(platform: string): Record<string, Record<string, any>> {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  return p?.dataSources || {};
}

/**
 * 从 selectors.json 读取 navigationFlow 配置
 */
export function getNavigationFlow(platform: string, flowName: string): Record<string, any> | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.navigationFlows?.[flowName]) return undefined;
  return p.navigationFlows[flowName];
}
```

- [ ] **步骤 5：运行 TypeScript 编译验证**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -30`
预期：无新增类型错误（可能有既存错误，忽略）

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/lib/selectorStore.ts
git commit -m "feat(config): extend selectorStore for apiPatterns/dataSources/navigationFlows"
```

---

### 任务 2：更新 selectors.json — 添加 apiPatterns 和 dataSources

**文件：**
- 修改：`data/selectors.json`

- [ ] **步骤 1：读取现有 selectors.json 的平台结构**

运行：`python3 -c "import json; d=json.load(open('data/selectors.json')); print(list(d['platforms'].keys()))"`
预期：`['douyin', 'kuaishou', 'xiaohongshu', 'tencent']`（或子集）

- [ ] **步骤 2：为每个平台添加 apiPatterns 节点**

在 `data/selectors.json` 的每个平台对象中，新增 `apiPatterns` 节点。以抖音为例，在 `"flowRules": { ... }` 之后添加：

```json
"apiPatterns": {
  "video_list.work_list": { "pattern": "/work_list", "description": "内容管理-作品管理API" },
  "video_list.item_list": { "pattern": "/item/list", "description": "数据中心-投稿列表API" },
  "comment_list": { "pattern": "/aweme/v1/web/comment/list/select", "description": "评论列表API" },
  "comment_reply": { "pattern": "/aweme/v1/web/comment/list/reply", "description": "评论回复API" }
}
```

快手：
```json
"apiPatterns": {
  "video_list.work_list": { "pattern": "/rest/cp/works/v2/video/pc/photo/list", "description": "内容管理-作品管理API" },
  "video_list.photo_analysis": { "pattern": "/rest/cp/creator/analysis/pc/photo/list", "description": "数据中心-作品分析API" },
  "comment_list": { "pattern": "/rest/cp/creator/comment/commentList", "description": "评论列表API" },
  "comment_reply": { "pattern": "/rest/cp/creator/comment/subCommentList", "description": "评论回复API" },
  "comment_home": { "pattern": "/rest/cp/creator/comment/home", "description": "评论首页API" }
}
```

小红书：
```json
"apiPatterns": {
  "note_list": { "pattern": "/api/galaxy/v2/creator/note/user/posted", "description": "笔记管理API" },
  "comment_page": { "pattern": "/api/sns/web/v2/comment/page", "description": "评论分页API" },
  "comment_sub_page": { "pattern": "/api/sns/web/v2/comment/sub/page", "description": "子评论分页API" }
}
```

视频号：
```json
"apiPatterns": {
  "post_list": { "pattern": "/mmfinderassistant-bin/post/post_list", "description": "内容管理-视频API" },
  "comment_list": { "pattern": "/mmfinderassistant-bin/comment/comment_list", "description": "评论列表API" }
}
```

- [ ] **步骤 3：为每个平台添加 dataSources 节点**

抖音：
```json
"dataSources": {
  "work_list": {
    "label": "内容管理-作品管理",
    "pageUrl": "https://creator.douyin.com/creator-micro/content/manage",
    "apiPatternKey": "video_list.work_list",
    "pagination": { "type": "scroll", "maxScrolls": 50 },
    "privateFilter": { "enabled": true, "field": "statistics.play_count", "condition": "=== 0", "dynamicRemove": true },
    "responseArrayPath": ["items", "video_list", "aweme_list", "data.items", "data.list"],
    "hasMoreField": "has_more",
    "cursorField": "cursor"
  },
  "item_list": {
    "label": "数据中心-投稿列表",
    "pageUrl": "https://creator.douyin.com/creator-micro/data-center/content",
    "apiPatternKey": "video_list.item_list",
    "pagination": { "type": "scroll", "maxScrolls": 50 },
    "privateFilter": { "enabled": true, "field": "statistics.play_count", "condition": "=== 0", "dynamicRemove": true },
    "responseArrayPath": ["items", "video_list", "aweme_list", "data.items", "data.list"],
    "hasMoreField": "has_more",
    "cursorField": "cursor"
  }
}
```

快手：
```json
"dataSources": {
  "work_list": {
    "label": "内容管理-作品管理",
    "pageUrl": "https://cp.kuaishou.com/article/manage/video",
    "apiPatternKey": "video_list.work_list",
    "pagination": { "type": "scroll", "maxScrolls": 50 },
    "privateFilter": { "enabled": true, "field": "photoStatus", "condition": "!== undefined && !== 0" },
    "responseArrayPath": ["data.list", "data.photoList.photoItems"],
    "hasMoreField": "has_more",
    "cursorField": "cursor"
  },
  "photo_analysis": {
    "label": "数据中心-作品分析",
    "pageUrl": "https://cp.kuaishou.com/rest/cp/creator/analysis/pc/photo",
    "apiPatternKey": "video_list.photo_analysis",
    "pagination": { "type": "page", "maxPages": 20, "nextPageBtnSelector": "page.next-page-btn" },
    "privateFilter": { "enabled": false, "description": "作品分析源天然无私密" },
    "responseArrayPath": ["data.analysisList"],
    "hasMoreField": "has_more"
  }
}
```

小红书：
```json
"dataSources": {
  "note_list": {
    "label": "笔记管理",
    "pageUrl": "https://creator.xiaohongshu.com/new/note-manager",
    "apiPatternKey": "note_list",
    "pagination": { "type": "scroll", "maxScrolls": 50 },
    "privateFilter": { "enabled": true, "field": "permission_code", "condition": "!== 0" },
    "responseArrayPath": ["data.notes", "data.note_infos", "data.note_list"],
    "hasMoreField": "data.page",
    "hasMoreCondition": "=== -1"
  }
}
```

视频号：
```json
"dataSources": {
  "post_list": {
    "label": "内容管理-视频",
    "pageUrl": "https://channels.weixin.qq.com/micro/content/post/list",
    "apiPatternKey": "post_list",
    "pagination": {
      "type": "page",
      "maxPages": 20,
      "nextPageBtnCss": "#container-wrap > div.container-center > div > div.main-body-wrap > div.main-body > div.weui-desktop-block.main-card > div > div > div > div:nth-child(2) > div.list-wrapper > div.footer.post-list-footer > div > span.weui-desktop-pagination__nav > a",
      "nextPageBtnText": "下一页"
    },
    "privateFilter": { "enabled": true, "field": "visibleType", "condition": "!== undefined && !== 1" },
    "responseArrayPath": ["data.list"],
    "hasMoreField": "data.downContinueFlag",
    "hasMoreCondition": "=== 1"
  }
}
```

- [ ] **步骤 4：验证 JSON 格式**

运行：`python3 -c "import json; json.load(open('data/selectors.json')); print('JSON valid')"`
预期：`JSON valid`

- [ ] **步骤 5：验证新节点被正确加载**

运行：`cd /home/lrp/social_media_complete && node -e "const s = require('./apps/ts-api-gateway/src/lib/selectorStore'); const r = s.getSelectorReader(); const c = r.getConfig(); console.log('douyin apiPatterns:', Object.keys(c.platforms.douyin?.apiPatterns || {})); console.log('douyin dataSources:', Object.keys(c.platforms.douyin?.dataSources || {}));"`
预期：`douyin apiPatterns: [ 'video_list.work_list', 'video_list.item_list', 'comment_list', 'comment_reply' ]`

- [ ] **步骤 6：Commit**

```bash
git add data/selectors.json
git commit -m "feat(config): add apiPatterns and dataSources to selectors.json for all platforms"
```

---

## Phase 2: 私密视频过滤（C 章）

### 任务 3：抖音 — play_count 二次提取与过滤

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:330-386`

- [ ] **步骤 1：在 raw response 遍历循环中提取 play_count**

在 `douyinCrawler.ts` L335（`awemeIdToAuthor` 声明之后），新增：

```typescript
const awemeIdToPlayCount = new Map<string, number>();
```

在 L349 `for (const raw of rawItems)` 循环体内，L357 `}` 之后（author 提取完成后），新增：

```typescript
// 提取 play_count 用于私密过滤（parseVideoItem 会剥离 statistics 字段）
const playCount = raw.statistics?.play_count ?? raw.stat?.play_count ?? raw.play_count;
if (id && playCount !== undefined) {
  awemeIdToPlayCount.set(String(id), Number(playCount));
}
```

- [ ] **步骤 2：在 sliced 之后新增私密过滤**

在 `douyinCrawler.ts` L373（`sliced` 变量定义完成后），新增：

```typescript
// 私密视频过滤：play_count === 0 视为私密
const filtered = sliced.filter((item: any) => {
  const playCount = awemeIdToPlayCount.get(String(item.aweme_id));
  if (playCount === 0) {
    logger.info({ awemeId: item.aweme_id }, '[Phase1] 过滤私密视频（play_count=0）');
    return false;
  }
  return true; // playCount 为 undefined 时视为公开（字段缺失不等于私密）
});
```

将 L375-383 的日志和返回值中的 `sliced` 替换为 `filtered`：

```typescript
logger.info({
  source,
  step: 'FETCH_COMPLETE',
  totalCollected: allItems.length,
  totalResponses: this.interceptor.getResponseCount(pattern),
  finalCount: filtered.length,
  privateFiltered: sliced.length - filtered.length,
  maxMonitor: this.maxMonitorVideos,
  awemeIds: filtered.map(i => i.aweme_id),
}, 'Video list fetch completed');

return filtered;
```

- [ ] **步骤 3：运行 TypeScript 编译验证**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep douyinCrawler | head -10`
预期：无新增错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): filter private videos with play_count=0"
```

---

### 任务 4：快手 — photoStatus 二次提取与过滤

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:579-619`

- [ ] **步骤 1：在 raw response 遍历循环中提取 photoStatus**

在 `kuaishouCrawler.ts` L583（`awemeIdToAuthor` 声明之后），新增：

```typescript
const awemeIdToPhotoStatus = new Map<string, number>();
```

在 L599 `for (const raw of rawItems)` 循环体内，L606 `}` 之后，新增：

```typescript
// 提取 photoStatus 用于私密过滤（photo_analysis 源无此字段，undefined 视为公开）
const photoStatus = raw.photoStatus ?? raw.status;
if (id && photoStatus !== undefined) {
  awemeIdToPhotoStatus.set(String(id), Number(photoStatus));
}
```

- [ ] **步骤 2：在 sliced 之后新增私密过滤**

在 `kuaishouCrawler.ts` L619（`sliced` 变量定义完成后），新增：

```typescript
// 私密视频过滤：photoStatus !== 0 视为私密（必须先检查 undefined，photo_analysis 源无此字段）
const filtered = sliced.filter((item: any) => {
  const photoStatus = awemeIdToPhotoStatus.get(String(item.aweme_id));
  if (photoStatus !== undefined && photoStatus !== 0) {
    logger.info({ awemeId: item.aweme_id, photoStatus }, '[Phase1] 过滤私密视频（photoStatus!=0）');
    return false;
  }
  return true;
});
```

在后续日志和返回值中将 `sliced` 替换为 `filtered`。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): filter private videos with photoStatus!=0"
```

---

### 任务 5：视频号 — visibleType 过滤

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:864-868`

- [ ] **步骤 1：在 commentClose 过滤之后新增 visibleType 过滤**

在 `tencentCrawler.ts` L868（`commentClose` 过滤的 `continue` 之后），新增：

```typescript
// 私密视频过滤：visibleType !== 1 为非公开（必须先检查 undefined，旧数据可能无此字段）
if (video.visibleType !== undefined && video.visibleType !== 1) {
  logger.info({ exportId: video.exportId, visibleType: video.visibleType }, '[Phase1] 过滤非公开视频（visibleType!=1）');
  continue;
}
```

- [ ] **步骤 2：在 videoInfos 映射中编码 exportId**

在 `tencentCrawler.ts` L913，将：
```typescript
aweme_id: v.exportId,
```
改为：
```typescript
aweme_id: v.exportId.replace(/\//g, '_'), // URL安全编码，/ → _
```

同时在 `commentsQueue.push` 处（L887、L900）也做相同编码：
```typescript
exportId: video.exportId.replace(/\//g, '_'),
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): filter private videos with visibleType!=1, encode exportId"
```

---

### 任务 6：已入库私密视频动态剔除（三平台通用逻辑）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（checkForUpdates 函数）
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`（checkForUpdates 函数）
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（checkForUpdates 函数）

- [ ] **步骤 1：在抖音 checkForUpdates 中添加动态剔除逻辑**

找到抖音 `checkForUpdates` 函数中已有视频对比逻辑的位置（通常在获取 `dbVideos` 之后、构建 `commentsQueue` 之前），新增：

```typescript
// 动态剔除：已入库视频变为私密（play_count=0）时从数据库删除
for (const dbVideo of dbVideos) {
  const freshItem = filtered.find((f: any) => f.aweme_id === dbVideo.id);
  if (!freshItem) {
    const playCount = awemeIdToPlayCount.get(dbVideo.id);
    if (playCount === 0) {
      logger.info({ awemeId: dbVideo.id }, '[Phase1] 已入库视频变为私密，剔除');
      await prisma.video.delete({ where: { id: dbVideo.id } });
    }
  }
}
```

- [ ] **步骤 2：在快手 checkForUpdates 中添加相同逻辑**

同上，使用 `awemeIdToPhotoStatus` 映射。

- [ ] **步骤 3：在视频号 checkForUpdates 中添加相同逻辑**

同上，使用 `video.visibleType` 字段。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat: dynamic removal of private videos from DB on re-check"
```

---

## Phase 3: 抽屉匹配重构（D 章）

### 任务 7：创建 parseDomTimestamp 工具函数

**文件：**
- 创建：`apps/ts-api-gateway/src/crawlers/timeParser.ts`
- 创建：`apps/ts-api-gateway/src/crawlers/timeParser.test.ts`

- [ ] **步骤 1：编写 parseDomTimestamp 函数**

创建 `apps/ts-api-gateway/src/crawlers/timeParser.ts`：

```typescript
/**
 * 四平台 DOM 时间文本解析为 Unix 秒级时间戳
 * 抖音：发布于2026年05月25日 14:43
 * 快手：2026-05-28 09:03:19
 * 小红书：2026-06-18 18:01
 * 视频号：2026/06/13 13:58
 */
export function parseDomTimestamp(containerText: string, platform: string, timezoneOffset: string = '+08:00'): number | null {
  let match: RegExpMatchArray | null;

  switch (platform) {
    case 'douyin': {
      match = containerText.match(/发布于(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    case 'kuaishou': {
      match = containerText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute, second] = match;
      return toTimestamp(year, month, day, hour, minute, second, timezoneOffset);
    }
    case 'xiaohongshu': {
      match = containerText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    case 'tencent': {
      match = containerText.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    default:
      return null;
  }
}

function toTimestamp(year: string, month: string, day: string, hour: string, minute: string, second: string, tz: string): number {
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tz}`;
  const ms = new Date(iso).getTime();
  return Math.floor(ms / 1000);
}

/**
 * 检查两个时间戳是否在容差范围内（秒）
 */
export function isTimestampMatch(domTimestamp: number, apiTimestamp: number, toleranceSeconds: number = 60): boolean {
  return Math.abs(domTimestamp - apiTimestamp) <= toleranceSeconds;
}

/**
 * 从容器文本中提取 description 前缀匹配
 */
export function isDescriptionMatch(containerText: string, description: string, prefixLength: number = 20): boolean {
  const descPrefix = description.toLowerCase().substring(0, prefixLength);
  if (descPrefix.length === 0) return true; // 空描述不做匹配
  return containerText.toLowerCase().includes(descPrefix);
}
```

- [ ] **步骤 2：编写单元测试**

创建 `apps/ts-api-gateway/src/crawlers/timeParser.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';

describe('parseDomTimestamp', () => {
  it('douyin: 发布于2026年05月25日 14:43', () => {
    const ts = parseDomTimestamp('some text 发布于2026年05月25日 14:43 more text', 'douyin');
    expect(ts).toBe(Math.floor(new Date('2026-05-25T14:43:00+08:00').getTime() / 1000));
  });

  it('kuaishou: 2026-05-28 09:03:19', () => {
    const ts = parseDomTimestamp('title 2026-05-28 09:03:19 detail', 'kuaishou');
    expect(ts).toBe(Math.floor(new Date('2026-05-28T09:03:19+08:00').getTime() / 1000));
  });

  it('xiaohongshu: 2026-06-18 18:01', () => {
    const ts = parseDomTimestamp('title 2026-06-18 18:01 stats', 'xiaohongshu');
    expect(ts).toBe(Math.floor(new Date('2026-06-18T18:01:00+08:00').getTime() / 1000));
  });

  it('tencent: 2026/06/13 13:58', () => {
    const ts = parseDomTimestamp('title 2026/06/13 13:58 stats', 'tencent');
    expect(ts).toBe(Math.floor(new Date('2026-06-13T13:58:00+08:00').getTime() / 1000));
  });

  it('returns null when no time found', () => {
    expect(parseDomTimestamp('no time here', 'douyin')).toBeNull();
  });

  it('returns null for unknown platform', () => {
    expect(parseDomTimestamp('2026-01-01 00:00', 'unknown')).toBeNull();
  });
});

describe('isTimestampMatch', () => {
  it('exact match', () => {
    expect(isTimestampMatch(1000, 1000, 60)).toBe(true);
  });

  it('within tolerance', () => {
    expect(isTimestampMatch(1000, 1059, 60)).toBe(true);
  });

  it('outside tolerance', () => {
    expect(isTimestampMatch(1000, 1061, 60)).toBe(false);
  });
});

describe('isDescriptionMatch', () => {
  it('matches prefix', () => {
    expect(isDescriptionMatch('title: #好心情从欣赏美景开始 more', '#好心情从欣赏美景开始，关注我')).toBe(true);
  });

  it('no match', () => {
    expect(isDescriptionMatch('title: #其他内容 more', '#好心情从欣赏美景开始')).toBe(false);
  });

  it('empty description always matches', () => {
    expect(isDescriptionMatch('anything', '')).toBe(true);
  });
});
```

- [ ] **步骤 3：运行测试**

运行：`cd /home/lrp/social_media_complete && npx vitest run apps/ts-api-gateway/src/crawlers/timeParser.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/timeParser.ts apps/ts-api-gateway/src/crawlers/timeParser.test.ts
git commit -m "feat(match): add parseDomTimestamp utility for 4-platform time parsing"
```

---

### 任务 8：抖音抽屉匹配重构

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:2339-2409`

- [ ] **步骤 1：导入 parseDomTimestamp**

在 `douyinCrawler.ts` 文件头部 import 区域，新增：

```typescript
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';
```

- [ ] **步骤 2：重构 findAndClickVideoInDrawer 函数**

将 `douyinCrawler.ts` L2339-2409 的 `findAndClickVideoInDrawer` 函数替换为：

```typescript
private async findAndClickVideoInDrawer(
  page: Page,
  awemeId: string,
  description: string,
  createTime: number,
): Promise<boolean> {
  const MAX_SCROLL_ATTEMPTS_DRAWER = 25;
  const TIMESTAMP_TOLERANCE = 60; // 秒

  logger.info({ awemeId, createTime, descPrefix: description.substring(0, 20) }, '[Drawer] Searching for target video in drawer');

  // 检查"没有更多视频"标记（避免无意义滚动）
  const noMoreVideo = await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="loading"]');
    for (const el of els) {
      if (el.textContent?.includes('没有更多视频')) return true;
    }
    return false;
  }).catch(() => false);

  if (noMoreVideo) {
    logger.info('[Drawer] 抽屉已无更多视频，跳过滚动');
  }

  const maxScrolls = noMoreVideo ? 0 : MAX_SCROLL_ATTEMPTS_DRAWER;

  for (let scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {
    await HumanActions.wait(page, 400, 700);

    const containerSelector = getSelector('drawer.video-item').css || '[class*="douyin-creator-interactive-list-items"] > div';
    const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
    if (!containerElements || containerElements.length === 0) {
      if (scrollAttempt < maxScrolls) await this.scrollDrawerForMore(page, scrollAttempt);
      continue;
    }

    logger.info({ count: containerElements.length, scrollAttempt }, '[Drawer] Found video containers');

    for (const container of containerElements) {
      const containerText = container.text || '';

      // 1. 提取 DOM 时间戳
      const domTimestamp = parseDomTimestamp(containerText, 'douyin');
      if (domTimestamp === null) continue; // 时间解析失败，跳过

      // 2. 时间差判断
      if (!isTimestampMatch(domTimestamp, createTime, TIMESTAMP_TOLERANCE)) continue;

      // 3. 时间匹配后，检查 description 前缀
      if (!isDescriptionMatch(containerText, description)) continue;

      // 4. 双重确认通过，点击
      const clicked = await HumanActions.cdpClickNode(page, container.nodeId);
      if (clicked) {
        logger.info({ awemeId, domTimestamp, createTime, timeDiff: Math.abs(domTimestamp - createTime), matchType: 'timestamp+description' }, '[Drawer] 匹配成功（时间戳+描述双重确认）');
        return true;
      }

      // 点击失败，尝试重新查询
      const reClicked = await this.tryClickMatchedContainer(page, description.toLowerCase(), description.toLowerCase().substring(0, 25));
      if (reClicked) return true;

      logger.warn({ awemeId }, '[Drawer] Match found but click failed — giving up');
      return false;
    }

    if (scrollAttempt < maxScrolls) {
      logger.info({ scrollAttempt, containerCount: containerElements.length }, '[Drawer] 未匹配，滚动加载更多');
      await this.scrollDrawerForMore(page, scrollAttempt);
    }
  }

  logger.warn({ awemeId, maxScrolls }, '[Drawer] 滚动穷尽仍未匹配');
  return false;
}
```

- [ ] **步骤 3：更新调用处传入 createTime**

找到调用 `findAndClickVideoInDrawer` 的地方（约 L1531），将：
```typescript
const clicked = await this.findAndClickVideoInDrawer(page, item.aweme_id, item.description);
```
改为：
```typescript
const clicked = await this.findAndClickVideoInDrawer(page, item.aweme_id, item.description, item.create_time);
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): refactor drawer matching to use timestamp+description"
```

---

### 任务 9：快手抽屉匹配重构

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1924-2047`

- [ ] **步骤 1：导入 parseDomTimestamp**

在 `kuaishouCrawler.ts` 文件头部 import 区域，新增：

```typescript
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';
```

- [ ] **步骤 2：重构 findAndClickVideoInDrawer 函数**

将 `kuaishouCrawler.ts` L1924 的 `findAndClickVideoInDrawer` 函数签名改为接收 `createTime` 参数，内部逻辑替换为时间戳+描述双重匹配（与抖音类似，但容器选择器和平台标识不同）。

核心变更：
- 函数签名新增 `createTime: number` 参数
- 替换纯文本匹配为 `parseDomTimestamp(containerText, 'kuaishou')` + `isTimestampMatch` + `isDescriptionMatch`
- 容器选择器使用 `.video-info__content__title` 和 `.video-info__content__date` 的父元素

- [ ] **步骤 3：更新调用处传入 createTime**

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): refactor drawer matching to use timestamp+description"
```

---

### 任务 10：视频号侧边栏匹配重构

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:1427-1462, 1573-1612`

- [ ] **步骤 1：导入 parseDomTimestamp**

在 `tencentCrawler.ts` 文件头部 import 区域，新增：

```typescript
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';
```

- [ ] **步骤 2：重构 scrollToFindVideo 函数**

视频号使用 shadow DOM 侧边栏而非抽屉。修改 `scrollToFindVideo` 函数，将纯文本匹配改为时间戳+描述双重匹配。

核心变更：
- 函数签名新增 `createTime: number` 参数
- 在 `page.evaluate` 内部，从 `.feed-time` 元素提取时间文本
- 用 `parseDomTimestamp` 解析后与 `createTime` 对比

- [ ] **步骤 3：更新调用处传入 createTime**

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): refactor sidebar matching to use timestamp+description"
```

---

## Phase 4: 验证与集成

### 任务 11：全量编译验证 + 回归检查

- [ ] **步骤 1：TypeScript 全量编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit 2>&1 | tail -20`
预期：无新增类型错误

- [ ] **步骤 2：运行已有测试**

运行：`cd /home/lrp/social_media_complete && npx vitest run 2>&1 | tail -20`
预期：无新增失败

- [ ] **步骤 3：运行新增的 timeParser 测试**

运行：`cd /home/lrp/social_media_complete && npx vitest run apps/ts-api-gateway/src/crawlers/timeParser.test.ts`
预期：全部 PASS

- [ ] **步骤 4：验证 selectors.json 加载**

运行：`cd /home/lrp/social_media_complete && node -e "
const s = require('./apps/ts-api-gateway/src/lib/selectorStore');
const r = s.getSelectorReader();
const c = r.getConfig();
for (const p of ['douyin','kuaishou','xiaohongshu','tencent']) {
  const ap = Object.keys(c.platforms[p]?.apiPatterns || {});
  const ds = Object.keys(c.platforms[p]?.dataSources || {});
  console.log(p + ': apiPatterns=' + ap.length + ', dataSources=' + ds.length);
}"`
预期：每个平台 apiPatterns >= 2, dataSources >= 1

- [ ] **步骤 5：最终 Commit**

```bash
git add -A
git commit -m "chore: video monitoring redesign — all phases complete"
```

---

## 自检

| 检查项 | 结果 |
|-------|------|
| 规格覆盖度 — A 章（数据源调研） | ✅ 已内联到 selectors.json 配置中 |
| 规格覆盖度 — B 章（选择器配置） | ✅ 任务 1-2 覆盖 |
| 规格覆盖度 — C 章（私密过滤） | ✅ 任务 3-6 覆盖 |
| 规格覆盖度 — D 章（抽屉匹配） | ✅ 任务 7-10 覆盖 |
| 占位符扫描 | ✅ 无 TODO/待定 |
| 类型一致性 | ✅ parseDomTimestamp 签名在所有调用处一致 |
| exportId 编码 | ✅ 任务 5 步骤 2 覆盖 |
| photoStatus undefined 检查 | ✅ 任务 4 步骤 2 覆盖 |
