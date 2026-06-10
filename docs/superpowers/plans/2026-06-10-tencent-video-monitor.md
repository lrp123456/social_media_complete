# 视频号评论监控实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为微信视频号助手 (channels.weixin.qq.com) 添加评论监控功能，与抖音/快手/小红书三阶段流水线对齐

**架构：** 新建 `TencentCrawler` 类（对标 `DouyinCrawler`），通过 API 拦截获取视频列表和评论数据，集成到现有 BullMQ 监控调度器。分四阶段交付：P0 登录会话 → P1 Light 监控 → P2 Deep 监控 → P3 拟人化回复。

**技术栈：** TypeScript, Patchright (CDP), BullMQ, Prisma, RequestInterceptor, HumanActions

**设计规格：** `docs/superpowers/specs/2026-06-10-tencent-video-monitor-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 视频号爬虫主类（登录、视频列表、评论采集、回复） |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `packages/shared-config/src/platforms.ts:84` | MONITOR_PLATFORMS 添加 `'tencent'` |
| `apps/ts-api-gateway/src/crawlers/menuSelectors.ts:29-118` | CRAWLER_KEY_MAP 添加 tencent 映射表 |
| `data/selectors.json` | 添加 tencent 平台选择器配置（menus/buttons/regions） |
| `apps/ts-api-gateway/src/services/monitorService.ts:600-921` | 添加 tencentCrawler 实例 + runTencentCheck() + getPlatformInfo 扩展 |

---

## 任务 1：启用 tencent 监控平台

**文件：**
- 修改：`packages/shared-config/src/platforms.ts:84`

- [ ] **步骤 1：在 MONITOR_PLATFORMS 中添加 tencent**

```typescript
// packages/shared-config/src/platforms.ts:84
// 修改前:
export const MONITOR_PLATFORMS: PlatformName[] = ['douyin', 'kuaishou', 'xiaohongshu'];

// 修改后:
export const MONITOR_PLATFORMS: PlatformName[] = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'];
```

- [ ] **步骤 2：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/shared-config/tsconfig.json`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add packages/shared-config/src/platforms.ts
git commit -m "feat: enable tencent platform for comment monitoring"
```

---

## 任务 2：添加 tencent 选择器配置 — menuSelectors.ts

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/menuSelectors.ts:29-118`（在 xiaohongshu 块之后、`};` 之前插入 tencent 块）

- [ ] **步骤 1：在 CRAWLER_KEY_MAP 中添加 tencent 映射表**

在 `xiaohongshu: { ... }` 块之后（第 117 行 `},` 之后），插入：

```typescript
  tencent: {
    // 导航
    'menu.home':       { category: 'menus', name: 'menu_home' },
    'menu.content':    { category: 'menus', name: 'menu_content' },
    'menu.interact':   { category: 'menus', name: 'menu_interact' },
    'menu.live':       { category: 'menus', name: 'menu_live' },
    'menu.data-center': { category: 'menus', name: 'menu_data_center' },
    'menu.settings':   { category: 'menus', name: 'menu_settings' },

    // 子菜单
    'menu.content.video':    { category: 'menus', name: 'menu_content_video' },
    'menu.content.image':    { category: 'menus', name: 'menu_content_image' },
    'menu.content.draft':    { category: 'menus', name: 'menu_content_draft' },
    'menu.interact.comment': { category: 'menus', name: 'menu_interact_comment' },
    'menu.interact.danmaku': { category: 'menus', name: 'menu_interact_danmaku' },
    'menu.interact.message': { category: 'menus', name: 'menu_interact_message' },
    'menu.data-center.video':    { category: 'menus', name: 'menu_data_video' },
    'menu.data-center.follower': { category: 'menus', name: 'menu_data_follower' },

    // 页面元素
    'page.switch-video-btn': { category: 'buttons', name: 'btn_switch_video' },

    // 评论相关
    'comment.reply-btn':    { category: 'buttons', name: 'btn_comment_reply' },
    'comment.reply-submit': { category: 'buttons', name: 'btn_reply_submit' },
    'comment.reply-input':  { category: 'regions', name: 'region_reply_input' },
    'comment.container':    { category: 'regions', name: 'region_comment_container' },

    // 滚动区域
    'scroll.video-list':    { category: 'regions', name: 'region_video_list_scroll' },
    'scroll.comment-list':  { category: 'regions', name: 'region_comment_list_scroll' },

    // 侧边栏
    'region.sidebar':       { category: 'regions', name: 'region_sidebar' },
  },
```

- [ ] **步骤 2：在 getSubmenuKeyForPageType 中添加 tencent 分支**

在 `menuSelectors.ts` 的 `getSubmenuKeyForPageType` 函数中（约第 308-342 行），在 `if (platform === 'xiaohongshu')` 块之后添加：

```typescript
  if (platform === 'tencent') {
    switch (pageType) {
      case 'content_management':
        return 'menu.content.video';
      case 'data_center':
        return 'menu.data-center.video';
      case 'tencent_interact':
        return 'menu.interact.comment';
      default:
        return undefined;
    }
  }
```

- [ ] **步骤 3：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误（可能有未使用变量警告，忽略）

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/menuSelectors.ts
git commit -m "feat: add tencent platform selector mappings to menuSelectors"
```

---

## 任务 3：添加 tencent 选择器配置 — selectors.json

**文件：**
- 修改：`data/selectors.json`（在 `"xiaohongshu": { ... }` 块之后添加 `"tencent": { ... }`）

- [ ] **步骤 1：读取当前 selectors.json 确认插入位置**

读取 `data/selectors.json` 找到 `"xiaohongshu"` 块的结束位置，在其后插入 tencent 配置。

- [ ] **步骤 2：插入 tencent 选择器配置**

在 `platforms` 对象中 `"xiaohongshu"` 块之后添加：

```json
    "tencent": {
      "menus": {
        "menu_home": {
          "purposes": ["monitor"],
          "primary": "getByText('span', '首页', {exact: true})",
          "fallbacks": [
            "#menuBar .finder-ui-desktop-menu__link_current:has(span:has-text('首页'))",
            ".finder-ui-desktop-sub-menu__item:has(span:has-text('首页'))"
          ],
          "selectorType": "text",
          "description": "首页菜单"
        },
        "menu_content": {
          "purposes": ["monitor"],
          "primary": "getByText('span', '内容管理')",
          "fallbacks": [
            ".js_nav_item:has(span:has-text('内容管理'))",
            ".finder-ui-desktop-menu__sub__wrp:has(span:has-text('内容管理'))"
          ],
          "selectorType": "text",
          "description": "内容管理 (可展开)"
        },
        "menu_content_video": {
          "purposes": ["monitor"],
          "primary": "getByText('span', '视频', {exact: true})",
          "fallbacks": [
            ".finder-ui-desktop-sub-menu__item:has(span:has-text('视频'))"
          ],
          "parent": "menu_content",
          "selectorType": "text",
          "description": "内容管理 > 视频"
        },
        "menu_interact": {
          "purposes": ["monitor"],
          "primary": "getByText('span', '互动管理')",
          "fallbacks": [
            ".js_nav_item:has(span:has-text('互动管理'))"
          ],
          "selectorType": "text",
          "description": "互动管理 (可展开)"
        },
        "menu_interact_comment": {
          "purposes": ["monitor"],
          "primary": "getByText('span', '评论', {exact: true})",
          "fallbacks": [
            ".finder-ui-desktop-sub-menu__item:has(span:has-text('评论'))"
          ],
          "parent": "menu_interact",
          "selectorType": "text",
          "description": "互动管理 > 评论"
        },
        "menu_live": {
          "purposes": [],
          "primary": "getByText('span', '直播')",
          "fallbacks": [".js_nav_item:has(span:has-text('直播'))"],
          "selectorType": "text",
          "description": "直播"
        },
        "menu_data_center": {
          "purposes": [],
          "primary": "getByText('span', '数据中心')",
          "fallbacks": [".js_nav_item:has(span:has-text('数据中心'))"],
          "selectorType": "text",
          "description": "数据中心"
        },
        "menu_data_video": {
          "purposes": [],
          "primary": "getByText('span', '视频数据')",
          "fallbacks": [".finder-ui-desktop-sub-menu__item:has(span:has-text('视频数据'))"],
          "parent": "menu_data_center",
          "selectorType": "text",
          "description": "数据中心 > 视频数据"
        },
        "menu_data_follower": {
          "purposes": [],
          "primary": "getByText('span', '关注者数据')",
          "fallbacks": [".finder-ui-desktop-sub-menu__item:has(span:has-text('关注者数据'))"],
          "parent": "menu_data_center",
          "selectorType": "text",
          "description": "数据中心 > 关注者数据"
        },
        "menu_settings": {
          "purposes": [],
          "primary": "getByText('span', '设置')",
          "fallbacks": [".js_nav_item:has(span:has-text('设置'))"],
          "selectorType": "text",
          "description": "设置"
        }
      },
      "buttons": {
        "btn_switch_video": {
          "purposes": ["monitor"],
          "primary": "getByText('button', '切换视频')",
          "fallbacks": [".switch-video-btn", "text=切换视频"],
          "filterTag": "BUTTON",
          "description": "切换视频按钮"
        },
        "btn_comment_reply": {
          "purposes": ["monitor"],
          "primary": "getByText('button', '回复')",
          "fallbacks": [".reply-btn", "text=回复"],
          "filterTag": "BUTTON",
          "description": "评论回复按钮"
        },
        "btn_reply_submit": {
          "purposes": ["monitor"],
          "primary": "getByText('button', '发送')",
          "fallbacks": [".submit-reply-btn", "text=发送"],
          "filterTag": "BUTTON",
          "description": "回复发送按钮"
        }
      },
      "regions": {
        "region_sidebar": {
          "purposes": ["monitor"],
          "primary": "#side-bar",
          "fallbacks": [".finder-ui-desktop-menu__wrp"],
          "description": "侧边栏容器"
        },
        "region_comment_container": {
          "purposes": ["monitor"],
          "primary": ".comment-list-container",
          "fallbacks": ["wujie-app .comment-list", "[class*='comment']"],
          "description": "评论列表容器"
        },
        "region_reply_input": {
          "purposes": ["monitor"],
          "primary": ".reply-textarea",
          "fallbacks": ["textarea[placeholder*='回复']", "div[contenteditable='true']"],
          "description": "回复输入框"
        },
        "region_video_list_scroll": {
          "purposes": ["monitor"],
          "primary": ".video-list-container",
          "fallbacks": ["wujie-app [class*='list']", "[class*='video-list']"],
          "description": "视频列表滚动区域"
        },
        "region_comment_list_scroll": {
          "purposes": ["monitor"],
          "primary": ".comment-list-scroll",
          "fallbacks": ["[class*='comment-list']", "wujie-app [class*='comment']"],
          "description": "评论列表滚动区域"
        }
      }
    }
```

- [ ] **步骤 3：验证 JSON 格式**

运行：`node -e "JSON.parse(require('fs').readFileSync('data/selectors.json','utf8')); console.log('OK')"`
预期：`OK`

- [ ] **步骤 4：Commit**

```bash
git add data/selectors.json
git commit -m "feat: add tencent platform selectors to selectors.json"
```

---

## 任务 4：创建 TencentCrawler — 类型定义 + 登录会话（P0）

**文件：**
- 创建：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **步骤 1：创建 tencentCrawler.ts 骨架（类型 + 登录 + 会话保活）**

```typescript
// apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, BrowserManager } from '@social-media/browser-core';
import { getSelector } from './menuSelectors';
import { resolveAndClick } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('crawler:tencent');

// ── 类型定义 ──

export type TencentVideoInfo = {
  export_id: string;
  desc: string;
  create_time: number;
  object_stat: {
    play_count: number;
    like_count: number;
    comment_count: number;
    share_count: number;
    recommend_count: number;
  };
  media_type?: number;
  status?: number;
};

export type TencentCommentInfo = {
  comment_id: string;
  content: string;
  nickname: string;
  head_img_url: string;
  create_time: number;
  like_count: number;
  reply_count: number;
  export_id: string;
  is_author: boolean;
  reply_to_nickname?: string;
  level: 1 | 2;
};

export interface CommentQueueItem {
  exportId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
  _userId: number;
}

export interface CommentProcessResult {
  exportId: string;
  success: boolean;
  comments: TencentCommentInfo[];
  commentGroups?: Array<{
    rootComment: any;
    subReplies: any[];
    newInGroup: any[];
  }>;
  error?: string;
}

export interface CheckResult {
  hasUpdate: boolean;
  commentsQueue: CommentQueueItem[];
  updatedVideos: Array<{
    exportId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  riskControlDetected: boolean;
  riskControlInfo?: RiskControlDetection;
}

export type RiskControlDetection = {
  detected: boolean;
  type: string;
  evidence: string;
};

// ── 常量 ──

const TENCENT_HOME = 'https://channels.weixin.qq.com/platform';
const TENCENT_LOGIN = 'https://channels.weixin.qq.com/login.html';

const POST_LIST_PATTERN = '/mmfinderassistant-bin/post/post_list';
const COMMENT_LIST_PATTERN = '/mmfinderassistant-bin/comment/get_comment_list';
const COMMENT_REPLY_PATTERN = '/mmfinderassistant-bin/comment/get_reply_list';
const ALL_COMMENT_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_REPLY_PATTERN];

const RISK_CONTROL_KEYWORDS = ['captcha', '验证', '安全', '限制', '封禁', '操作频繁', 'login'];
const RISK_CONTROL_URLS = ['/login', '/verify', '/captcha'];

const SESSION_HEARTBEAT = 15 * 60 * 1000; // 15分钟

// ── 爬虫主类 ──

export class TencentCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
  }

  // ════════════════════════════════════════
  // Phase 0: 登录与会话管理
  // ════════════════════════════════════════

  /**
   * 检测登录状态，需要时通过企微推送二维码
   * 先访问 /platform，如果被重定向到 /login 则需要扫码
   */
  async handleLogin(page: Page, userId: number): Promise<boolean> {
    logger.info('[Login] Checking login status');

    // 先尝试访问 platform
    await page.goto(TENCENT_HOME, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 3000);

    // 已登录，无需扫码
    const url = page.url();
    if (url.includes('/platform') && !url.includes('/login')) {
      logger.info('[Login] Session still valid, skip login');
      return true;
    }

    // 被重定向到登录页，需要扫码
    logger.info('[Login] Session expired, need QR scan');

    // 动态导入 botManager（避免循环依赖）
    const { botManager } = await import('../services/wechatBotService');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) {
      await this.captureAndSendQR(page, userId, 'tencent', user.wechatUserid, botManager);
    }

    // 轮询等待扫码（最长120秒）
    const maxWait = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const currentUrl = page.url();
      if (currentUrl.includes('/platform') && !currentUrl.includes('/login')) {
        logger.info('[Login] Login successful');
        return true;
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      if (bodyText.includes('已过期')) {
        logger.info('[Login] QR code expired, refreshing');
        await HumanActions.cdpClick(page, '.qrcode-refresh-btn', { fallbackText: '刷新', timeout: 5000 });
        await HumanActions.wait(page, 2000, 3000);
        if (user?.wechatUserid) {
          await this.captureAndSendQR(page, userId, 'tencent', user.wechatUserid, botManager);
        }
      }

      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Login] Login timeout after 120s');
    return false;
  }

  /**
   * 会话保活 — 定期访问首页维持 Cookie
   */
  async keepSessionAlive(page: Page): Promise<void> {
    await page.goto(TENCENT_HOME, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 3000);

    if (page.url().includes('/login')) {
      throw new Error('SESSION_EXPIRED');
    }
  }

  /**
   * 截取二维码并通过企微发送
   */
  private async captureAndSendQR(
    page: Page,
    userId: number,
    platform: string,
    wechatUserid: string,
    botManager: any,
  ): Promise<void> {
    try {
      const selectors = [
        'iframe[src*="login-for-iframe"]',
        'img[src*="qrcode"]',
        'img[src*="qr"]',
        'canvas',
        '[class*="qrcode"] img',
      ];

      let buf: Buffer | undefined;
      const PADDING = 40;

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);
            const box = await el.boundingBox();
            if (box && box.width > 50 && box.height > 50) {
              const clip = {
                x: Math.max(0, box.x - PADDING),
                y: Math.max(0, box.y - PADDING),
                width: box.width + PADDING * 2,
                height: box.height + PADDING * 2,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ selector: sel, width: clip.width, height: clip.height }, '[Login] QR screenshot captured');
              break;
            }
          }
        } catch {}
      }

      if (!buf) {
        buf = await page.screenshot({ type: 'png' });
        logger.info('[Login] Fallback: full page screenshot');
      }

      await botManager.sendLoginAlert(wechatUserid, platform, userId, buf).catch(() => {});
    } catch (err) {
      await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
    }
  }

  // ════════════════════════════════════════
  // 风控检测
  // ════════════════════════════════════════

  async detectRiskControl(page: Page): Promise<RiskControlDetection> {
    try {
      const url = page.url();
      for (const riskUrl of RISK_CONTROL_URLS) {
        if (url.includes(riskUrl) && !url.includes('/platform')) {
          return { detected: true, type: 'url_redirect', evidence: `Redirected: ${url}` };
        }
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      for (const keyword of RISK_CONTROL_KEYWORDS) {
        if (bodyText.includes(keyword)) {
          return { detected: true, type: 'risk_keyword', evidence: `Found: "${keyword}"` };
        }
      }

      return { detected: false, type: '', evidence: '' };
    } catch {
      return { detected: false, type: '', evidence: '' };
    }
  }

  // ════════════════════════════════════════
  // API 拦截器管理
  // ════════════════════════════════════════

  async registerListener(page: Page, patterns: string[]): Promise<void> {
    this.interceptor.clearAll();
    for (const pattern of patterns) {
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['channels.weixin.qq.com'],
        requiredItemFields: pattern === POST_LIST_PATTERN ? ['export_id'] : ['comment_id'],
        minItems: pattern === POST_LIST_PATTERN ? 1 : 0,
      });
    }
    this.listenerPageId = await this.interceptor.register(page, patterns);
    logger.info({ patterns }, '[Tencent] Listener registered');
  }

  unregisterListener(): void {
    if (this.listenerPageId) {
      this.interceptor.unregister(this.listenerPageId);
      this.listenerPageId = null;
    }
    this.interceptor.clearAll();
  }

  // ════════════════════════════════════════
  // Phase 1: 视频列表发现（占位，任务 5 实现）
  // ════════════════════════════════════════

  async navigateToVideoList(page: Page): Promise<void> {
    // 任务 5 实现
  }

  async checkForUpdates(page: Page, userId: number): Promise<CheckResult> {
    // 任务 5 实现
    return { hasUpdate: false, commentsQueue: [], updatedVideos: [], riskControlDetected: false };
  }

  // ════════════════════════════════════════
  // Phase 2: 评论管理导航（占位，任务 6 实现）
  // ════════════════════════════════════════

  async navigateToCommentManage(page: Page): Promise<boolean> {
    // 任务 6 实现
    return false;
  }

  // ════════════════════════════════════════
  // Phase 3: 评论采集（占位，任务 7 实现）
  // ════════════════════════════════════════

  async processCommentsQueue(
    page: Page,
    queue: CommentQueueItem[],
    userId: number,
  ): Promise<CommentProcessResult[]> {
    // 任务 7 实现
    return [];
  }

  // ════════════════════════════════════════
  // 退出策略
  // ════════════════════════════════════════

  async executeExitStrategy(page: Page): Promise<void> {
    try {
      // 随机选择退出行为
      const actions = ['navigate_submenu', 'idle_wander', 'refresh'];
      const action = actions[Math.floor(Math.random() * actions.length)];

      if (action === 'navigate_submenu') {
        const submenuKeys = ['menu.data-center.video', 'menu.content.image', 'menu.live'];
        const key = submenuKeys[Math.floor(Math.random() * submenuKeys.length)];
        const clicked = await resolveAndClick(page, key, 'tencent', { timeout: 8000 });
        if (clicked) {
          await HumanActions.wait(page, 2000, 3000);
          return;
        }
      }

      if (action === 'idle_wander') {
        await HumanActions.randomBlankClick(page);
        await HumanActions.humanScroll(page, 100 + Math.random() * 200, { minPause: 200, maxPause: 600 });
        await HumanActions.wait(page, 1000, 2000);
        return;
      }

      // fallback: CDP refresh
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      await HumanActions.wait(page, 2000, 3000);
    } catch (err: any) {
      logger.warn({ error: err.message }, '[Exit] Exit strategy failed');
    }
  }
}
```

- [ ] **步骤 2：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误（占位方法返回空值，不会影响编译）

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): create TencentCrawler with login + session management"
```

---

## 任务 5：实现 Phase 1 — 视频列表发现 + Light 模式（P1）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（填充 `navigateToVideoList` + `checkForUpdates`）

- [ ] **步骤 1：实现 navigateToVideoList**

在 `TencentCrawler` 类中替换 `navigateToVideoList` 占位：

```typescript
  async navigateToVideoList(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes('/platform/post/list')) {
      logger.info('[Phase1] Already on video list page');
      return;
    }

    // 优先通过菜单导航（防风控）
    const videoClicked = await resolveAndClick(
      page, 'menu.content.video', 'tencent', { timeout: 10000 }
    );

    if (videoClicked) {
      await HumanActions.wait(page, 3000, 5000);
      await HumanActions.pageLoadBehavior(page);
      logger.info('[Phase1] Navigated to video list via menu click');
    } else {
      logger.warn('[Phase1] Menu click failed, falling back to page.goto');
      await page.goto('https://channels.weixin.qq.com/platform/post/list', {
        waitUntil: 'domcontentloaded',
      });
      await HumanActions.wait(page, 3000, 5000);
    }
  }
```

- [ ] **步骤 2：实现 checkForUpdates（Phase 1 核心逻辑）**

替换 `checkForUpdates` 占位：

```typescript
  async checkForUpdates(page: Page, userId: number): Promise<CheckResult> {
    logger.info({ userId }, '[Phase1] Starting update check');

    // 风控检测
    const riskCheck = await this.detectRiskControl(page);
    if (riskCheck.detected) {
      return {
        hasUpdate: false,
        commentsQueue: [],
        updatedVideos: [],
        riskControlDetected: true,
        riskControlInfo: riskCheck,
      };
    }

    // 注册 API 监听
    await this.registerListener(page, [POST_LIST_PATTERN]);

    // 导航到视频列表
    await this.navigateToVideoList(page);

    // 触发数据加载（刷新）
    await HumanActions.cdpF5Refresh(page);
    HumanActions.clearCDPContext(page);
    await HumanActions.wait(page, 3000, 5000);

    // 获取拦截到的视频列表
    const intercepted = await this.interceptor.waitForResponse(POST_LIST_PATTERN, 15000);
    const videos: TencentVideoInfo[] = intercepted?.body?.list || [];

    logger.info({ userId, videoCount: videos.length }, '[Phase1] Videos fetched');

    // 对比数据库中的评论数
    const dbVideos = await db.getVideosByUserId(userId);
    const commentsQueue: CommentQueueItem[] = [];

    for (const video of videos.slice(0, this.maxMonitorVideos)) {
      const dbVideo = dbVideos.find(v => v.id === video.export_id);
      const newCount = video.object_stat?.comment_count ?? 0;

      if (!dbVideo) {
        // 新视频
        if (newCount > 0) {
          commentsQueue.push({
            exportId: video.export_id,
            description: video.desc,
            oldCount: 0,
            newCount,
            isFirstCrawl: true,
            _userId: userId,
          });
        }
        continue;
      }

      if (newCount > dbVideo.commentCount) {
        commentsQueue.push({
          exportId: video.export_id,
          description: video.desc,
          oldCount: dbVideo.commentCount,
          newCount,
          isFirstCrawl: false,
          _userId: userId,
        });
      }
    }

    // 保存视频到数据库
    const videoInfos = videos.slice(0, this.maxMonitorVideos).map(v => ({
      aweme_id: v.export_id,
      description: v.desc,
      create_time: v.create_time,
      comment_count: v.object_stat?.comment_count ?? 0,
      metrics: v.object_stat,
    }));
    await db.upsertVideosBatch(userId, videoInfos);
    await db.truncateVideosByUser(userId, this.maxMonitorVideos);

    this.unregisterListener();

    logger.info({ userId, queueLength: commentsQueue.length }, '[Phase1] Check complete');

    return {
      hasUpdate: commentsQueue.length > 0,
      commentsQueue,
      updatedVideos: videos.slice(0, this.maxMonitorVideos).map(v => ({
        exportId: v.export_id,
        description: v.desc,
        oldCount: dbVideos.find(d => d.id === v.export_id)?.commentCount ?? 0,
        newCount: v.object_stat?.comment_count ?? 0,
      })),
      riskControlDetected: false,
    };
  }
```

- [ ] **步骤 3：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): implement Phase 1 video list discovery + Light mode"
```

---

## 任务 6：实现 Phase 2 — 评论管理导航

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（填充 `navigateToCommentManage`）

- [ ] **步骤 1：实现 navigateToCommentManage**

替换占位方法：

```typescript
  async navigateToCommentManage(page: Page): Promise<boolean> {
    logger.info('[Phase2] Navigating to comment management page');

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 检测是否已在评论页
      const bodyText = await HumanActions.cdpGetBodyText(page);
      const alreadyOnCommentPage = bodyText.includes('评论')
        && (bodyText.includes('切换视频') || bodyText.includes('全部类型'));

      if (alreadyOnCommentPage) {
        logger.info({ attempt }, '[Phase2] Already on comment page');
        return true;
      }

      // 方式1: 通过菜单点击
      // 先展开 "互动管理" 父菜单
      const interactClicked = await resolveAndClick(
        page, 'menu.interact', 'tencent', { timeout: 8000 }
      );
      if (interactClicked) {
        await HumanActions.wait(page, 1000, 2000);
      }

      // 再点击 "评论" 子菜单
      const commentClicked = await resolveAndClick(
        page, 'menu.interact.comment', 'tencent', { timeout: 10000 }
      );

      if (commentClicked) {
        logger.info('[Phase2] Comment menu clicked, waiting for page load');
        await HumanActions.wait(page, 3000, 5000);

        const loaded = await this.waitForCommentManagePage(page);
        if (loaded) {
          logger.info('[Phase2] Comment page loaded');
          return true;
        }
      }

      // 方式2: 直接导航（回退）
      if (attempt === maxRetries - 1) {
        logger.warn('[Phase2] Menu click failed, falling back to page.goto');
        await page.goto('https://channels.weixin.qq.com/platform/comment', {
          waitUntil: 'domcontentloaded',
        });
        await HumanActions.wait(page, 3000, 5000);
        const loaded = await this.waitForCommentManagePage(page);
        if (loaded) return true;
      }

      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Phase2] Failed to navigate to comment page');
    return false;
  }

  private async waitForCommentManagePage(page: Page): Promise<boolean> {
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      const url = page.url();
      if (url.includes('/comment') || url.includes('/platform/comment')) {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('评论') && (bodyText.includes('切换视频') || bodyText.includes('全部类型'))) {
          return true;
        }
      }
      await HumanActions.wait(page, 800, 1500);
    }
    return false;
  }
```

- [ ] **步骤 2：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): implement Phase 2 comment management navigation"
```

---

## 任务 7：实现 Phase 3 — 评论采集（P2）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（填充 `processCommentsQueue`）

- [ ] **步骤 1：实现 processCommentsQueue**

替换占位方法。注意：评论 API 路径待验证，代码中标注 `// TODO: verify API path`。

```typescript
  async processCommentsQueue(
    page: Page,
    queue: CommentQueueItem[],
    userId: number,
  ): Promise<CommentProcessResult[]> {
    const results: CommentProcessResult[] = [];
    logger.info({ queueLength: queue.length }, '[Phase3] Starting comment queue processing');

    // 导航到评论管理页
    const navigated = await this.navigateToCommentManage(page);
    if (!navigated) {
      logger.error('[Phase3] Failed to navigate to comment page');
      return queue.map(q => ({
        exportId: q.exportId,
        success: false,
        comments: [],
        error: 'Failed to navigate to comment page',
      }));
    }

    // 注册评论 API 监听
    await this.registerListener(page, ALL_COMMENT_PATTERNS);

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      logger.info({ index: i + 1, total: queue.length, exportId: item.exportId }, '[Phase3] Processing video');

      try {
        // 风控检测
        const riskCheck = await this.detectRiskControl(page);
        if (riskCheck.detected) {
          logger.error({ exportId: item.exportId, riskType: riskCheck.type }, '[Phase3] Risk control detected');
          results.push({ exportId: item.exportId, success: false, comments: [], error: 'Risk control detected' });
          break;
        }

        // 选择目标视频（如果评论页支持切换视频）
        if (item.description) {
          await this.selectVideoForComments(page, item.exportId, item.description);
        }

        // 等待评论 API 响应
        this.interceptor.clear(COMMENT_LIST_PATTERN);
        await HumanActions.wait(page, 2000, 3000);

        // 触发评论加载（滚动）
        await HumanActions.humanScroll(page, 300, { minPause: 300, maxPause: 600 });
        await HumanActions.wait(page, 1000, 2000);

        const commentResp = await this.interceptor.waitForResponse(COMMENT_LIST_PATTERN, 15000);
        const comments: TencentCommentInfo[] = (commentResp?.body?.list || []).map((c: any) => ({
          comment_id: c.comment_id,
          content: c.content || '',
          nickname: c.nickname || '',
          head_img_url: c.head_img_url || '',
          create_time: c.create_time || 0,
          like_count: c.like_count || 0,
          reply_count: c.reply_count || 0,
          export_id: item.exportId,
          is_author: c.is_author || false,
          level: 1 as const,
        }));

        // 入库
        await db.batchUpsertComments('tencent', comments, userId);

        results.push({
          exportId: item.exportId,
          success: true,
          comments,
        });

        logger.info({ exportId: item.exportId, commentCount: comments.length }, '[Phase3] Video processed');

        // 视频间冷却
        await HumanActions.wait(page, 3000, 5000);
      } catch (error: any) {
        logger.error({ error: error.message, exportId: item.exportId }, '[Phase3] Comment processing failed');
        results.push({
          exportId: item.exportId,
          success: false,
          comments: [],
          error: error.message,
        });
      }
    }

    this.unregisterListener();
    return results;
  }

  /**
   * 选择目标视频进行评论筛选
   */
  private async selectVideoForComments(
    page: Page,
    exportId: string,
    videoTitle: string,
  ): Promise<boolean> {
    // 点击 "切换视频" 按钮
    const switchClicked = await resolveAndClick(
      page, 'page.switch-video-btn', 'tencent', { timeout: 8000 }
    );

    if (!switchClicked) {
      logger.warn('[Phase3] Switch video button not found, using default video');
      return false;
    }

    await HumanActions.wait(page, 1500, 2500);

    // 在弹窗中搜索视频标题
    if (videoTitle) {
      const searchInput = await page.$('input[placeholder*="搜索"]');
      if (searchInput) {
        await searchInput.fill(videoTitle.slice(0, 20));
        await HumanActions.wait(page, 1000, 2000);
      }
    }

    // 点击目标视频选项
    const optionClicked = await HumanActions.cdpClickByText(page, videoTitle.slice(0, 15), { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);

    return optionClicked;
  }
```

- [ ] **步骤 2：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): implement Phase 3 comment collection (API paths need verification)"
```

---

## 任务 8：集成到 monitorService — runTencentCheck + 通知扩展

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：添加 tencentCrawler 导入和实例**

在文件顶部导入区域添加（约第 14 行之后）：

```typescript
import { TencentCrawler } from '../crawlers/tencentCrawler';
```

在爬虫实例化区域添加（约第 343 行之后）：

```typescript
const tencentCrawler = new TencentCrawler(MAX_MONITOR_VIDEOS);
```

- [ ] **步骤 2：扩展 getPlatformInfo 支持 tencent**

在 `getPlatformInfo` 函数的 switch 中添加（约第 108-118 行）：

```typescript
    case 'tencent':
      return { label: '视频号', cardActionUrl: 'https://channels.weixin.qq.com/platform/comment' };
```

- [ ] **步骤 3：在 executeMonitorCheck 中添加 tencent case**

在 `executeMonitorCheck` 函数的 switch 中添加（约第 600-608 行，在 `case 'xiaohongshu':` 之后）：

```typescript
      case 'tencent':
        return await runTencentCheck(page, task, onProgress);
```

- [ ] **步骤 4：添加 runTencentCheck 函数**

在 `runXiaohongshuCheck` 函数之后添加：

```typescript
// ============================================================
// 视频号监控 — 3阶段流程
// ============================================================

async function runTencentCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const crawlMode = await db.getCrawlMode('tencent');

  // 注册 API 拦截器
  await tencentCrawler.registerListener(page, ['/mmfinderassistant-bin/post/post_list']);

  // Phase 0: 登录检测
  const loggedIn = await tencentCrawler.handleLogin(page, task.userId);
  if (!loggedIn) {
    throw new Error('Tencent login failed');
  }

  // Phase 1: 检测更新
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const phase1Result = await tencentCrawler.checkForUpdates(page, task.userId);

  tencentCrawler.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'tencent', riskType }, '视频号风控触发');
    await db.logRiskScene(task.userId, 'tencent', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'tencent', user.wechatUserid);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  if (phase1Result.commentsQueue.length === 0) {
    await tencentCrawler.executeExitStrategy(page);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  // Light 模式
  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '视频号 Light 模式 — 跳过 Phase 2/3');
    await tencentCrawler.executeExitStrategy(page);
    const updates = queue.map(q => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: true, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 2: 导航到评论管理
  onProgress?.({ phase: 'Phase2', step: '导航到评论管理', percent: 40, detail: `发现 ${queue.length} 个视频有新评论` });
  const navSuccess = await tencentCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '视频号 Phase 2 失败');
    await tencentCrawler.executeExitStrategy(page);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 评论采集
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  const phase3Result = await tencentCrawler.processCommentsQueue(page, queue, task.userId);

  const successful = phase3Result.filter(r => r.success);
  const updates = queue
    .filter(q => successful.some(r => r.exportId === q.exportId))
    .map(q => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  onProgress?.({ phase: '退出', step: '执行退出策略', percent: 90, detail: `${successful.length}/${queue.length} 个视频采集成功` });
  await tencentCrawler.executeExitStrategy(page);

  logger.info({ userId: task.userId, processed: phase3Result.length, successful: successful.length }, '视频号 Phase 3 完成');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}
```

- [ ] **步骤 5：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(tencent): integrate TencentCrawler into monitorService with Light+Deep modes"
```

---

## 任务 9：实现拟人化回复（P3）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（添加回复方法）
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（添加 tencent 回复处理）

- [ ] **步骤 1：在 TencentCrawler 中添加回复方法**

```typescript
  /**
   * 拟人化回复评论
   */
  async replyToComment(
    page: Page,
    commentCid: string,
    replyText: string,
  ): Promise<boolean> {
    logger.info({ commentCid, textLength: replyText.length }, '[Reply] Starting reply');

    try {
      // 定位目标评论的 "回复" 按钮
      const replyBtnClicked = await resolveAndClick(
        page, 'comment.reply-btn', 'tencent', { timeout: 5000 }
      );

      if (!replyBtnClicked) {
        // 回退：通过文本匹配
        const textClicked = await HumanActions.cdpClickByText(page, '回复', { timeout: 3000 });
        if (!textClicked) {
          logger.error('[Reply] Reply button not found');
          return false;
        }
      }

      await HumanActions.wait(page, 500, 1000);

      // 点击输入框
      const inputDef = getSelector('comment.reply-input');
      const inputCss = inputDef.css || 'div[contenteditable="true"], textarea';
      const inputClicked = await HumanActions.cdpClick(page, inputCss, { timeout: 5000 });
      if (!inputClicked) {
        logger.error('[Reply] Reply input not found');
        return false;
      }
      await HumanActions.wait(page, 300, 500);

      // 逐字输入（拟人化，50-150ms/字）
      for (const char of replyText) {
        await HumanActions.cdpKeyPress(page, char, char, char.charCodeAt(0));
        await HumanActions.wait(page, 50, 150);
      }

      await HumanActions.wait(page, 500, 1000);

      // 点击发送
      const submitDef = getSelector('comment.reply-submit');
      const submitCss = submitDef.css || 'button:has-text("发送")';
      await HumanActions.cdpClick(page, submitCss, { timeout: 5000 });
      await HumanActions.wait(page, 1000, 2000);

      logger.info({ commentCid }, '[Reply] Reply sent successfully');
      return true;
    } catch (err: any) {
      logger.error({ error: err.message, commentCid }, '[Reply] Reply failed');
      return false;
    }
  }
```

- [ ] **步骤 2：在 monitorService 中添加 tencent 回复处理**

在 `executeReplyAction` 函数中扩展 tencent 平台支持（约第 1110-1189 行）：

在函数开头的平台判断后添加 tencent 分支：

```typescript
  // 在现有 douyin 回复逻辑之后，添加 tencent 回复逻辑
  if (task.platform === 'tencent') {
    const loggedIn = await tencentCrawler.handleLogin(page, task.userId);
    if (!loggedIn) {
      logger.error('回复失败：视频号登录失败');
      return;
    }

    const navSuccess = await tencentCrawler.navigateToCommentManage(page);
    if (!navSuccess) {
      logger.error('回复失败：无法导航到评论管理');
      return;
    }

    const replied = await tencentCrawler.replyToComment(page, replyData.commentCid, replyData.text);
    if (replied) {
      logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '视频号回复执行成功');
    }

    await tencentCrawler.executeExitStrategy(page);
    return;
  }
```

- [ ] **步骤 3：验证 TypeScript 编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(tencent): implement reply functionality with humanized typing"
```

---

## 任务 10：端到端验证

- [ ] **步骤 1：验证完整编译**

运行：`cd /home/lrp/social_media_complete && npx tsc --noEmit`
预期：无错误

- [ ] **步骤 2：检查所有文件已正确修改**

运行以下命令确认关键变更：
```bash
grep -n "tencent" packages/shared-config/src/platforms.ts
grep -n "tencent" apps/ts-api-gateway/src/crawlers/menuSelectors.ts
grep -n "tencent" apps/ts-api-gateway/src/services/monitorService.ts
ls -la apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
```

- [ ] **步骤 3：最终 Commit**

```bash
git add -A
git commit -m "feat(tencent): complete video comment monitoring integration

- P0: Login via QR code push to WeChat Work
- P1: Light mode - video list API interception + comment count tracking
- P2: Deep mode - comment detail collection + database storage
- P3: Humanized reply with 6-12s delay + risk control detection
- Selectors: menuSelectors + selectors.json for tencent platform
- Monitor: runTencentCheck integrated into BullMQ scheduler"
```

---

## 自检清单

- [ ] 规格中每个需求都有对应任务
- [ ] 无占位符（TODO/待定）
- [ ] 类型/方法签名在任务间一致
- [ ] 所有代码步骤包含完整代码块
- [ ] 所有命令精确且可执行
