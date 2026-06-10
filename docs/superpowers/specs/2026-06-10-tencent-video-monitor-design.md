# 视频号评论监控设计规格

> 版本：v1.0 | 日期：2026-06-10
> 平台：微信视频号助手 (channels.weixin.qq.com)
> 对标：抖音评论监控方案 (douyinCrawler.ts)

---

## 一、需求概述

### 1.1 监控范围

- **仅评论监控**（与抖音对齐）
- 监控视频评论数变化，采集新评论
- 不包含弹幕、私信

### 1.2 登录方式

- **企业微信推送二维码**
- 检测到登录过期时，截取二维码通过企微发送给用户
- 复用现有 `captureAndSendQR` + `botManager.sendLoginAlert` 机制

### 1.3 监控模式

- **Light + Deep 模式**
- Light：仅检测评论数变化，创建合成记录通知
- Deep：完整采集评论详情并入库
- 通过配置切换，复用抖音的 `crawlMode` 机制

### 1.4 回复功能

- **本期实现**
- 与抖音对齐，支持从企微卡片回复评论
- 回复延迟 6-12s，输入速度 50-150ms/字

### 1.5 特殊指标

- **展示推荐数**（视频号特有）
- 企微通知卡片增加「推荐数」字段

---

## 二、整体架构

### 2.1 文件结构

```
apps/ts-api-gateway/src/crawlers/
├── tencentCrawler.ts      # 新增：视频号爬虫主类
├── douyinCrawler.ts       # 现有：抖音爬虫
├── kuaishouCrawler.ts     # 现有：快手爬虫
├── xiaohongshuCrawler.ts  # 现有：小红书爬虫
├── menuSelectors.ts       # 修改：添加 tencent 选择器映射
└── menuNavigator.ts       # 现有：菜单导航（无需修改）
```

### 2.2 配置文件修改

| 文件 | 修改内容 |
|------|---------|
| `packages/shared-config/src/platforms.ts` | MONITOR_PLATFORMS 添加 `'tencent'` |
| `data/selectors.json` | 添加 tencent 平台选择器配置 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 添加 `runTencentCheck()` + `tencentCrawler` 实例 |

### 2.3 类结构

```typescript
export class TencentCrawler {
  private interceptor: RequestInterceptor;
  
  constructor(private maxMonitorVideos: number = 20) {}
  
  // Phase 0: 登录与会话
  async handleLogin(page: Page, userId: number): Promise<boolean>;
  async keepSessionAlive(page: Page): Promise<void>;
  
  // Phase 1: 视频列表发现
  async navigateToVideoList(page: Page): Promise<void>;
  async checkForUpdates(page: Page, userId: number): Promise<CheckResult>;
  
  // Phase 2: 评论管理导航
  async navigateToCommentManage(page: Page): Promise<boolean>;
  
  // Phase 3: 评论采集
  async processCommentsQueue(page: Page, queue: CommentQueueItem[], userId: number): Promise<CommentProcessResult[]>;
  
  // 通用
  async registerListener(page: Page, patterns: string[]): Promise<void>;
  unregisterListener(): void;
  async detectRiskControl(page: Page): Promise<RiskControlDetection>;
}
```

---

## 三、三阶段流水线

```
┌──────────────────────────────────────────────────────────┐
│  Phase 1: 视频列表发现                                    │
│  导航到视频管理页 → 拦截 post_list API → 获取视频ID/评论数 │
│  对比 sync_state → 发现新视频 + 检测评论数变化             │
├──────────────────────────────────────────────────────────┤
│  Phase 2: 导航到评论管理                                  │
│  点击侧边栏"互动管理 > 评论" → 等待评论页加载             │
│  选择目标视频 → 拦截评论列表 API                          │
├──────────────────────────────────────────────────────────┤
│  Phase 3: 评论采集与入库                                  │
│  一级评论翻页 → 子回复展开 → 评论入库 → 增量去重           │
│  拟人化回复                                               │
└──────────────────────────────────────────────────────────┘
```

### 3.1 API 拦截点

| 阶段 | API 模式 | 用途 |
|------|---------|------|
| Phase 1 | `/mmfinderassistant-bin/post/post_list` | 视频列表 + 评论数 |
| Phase 2 | `/mmfinderassistant-bin/comment/get_comment_list` | 评论列表（待验证） |
| Phase 3 | `/mmfinderassistant-bin/comment/get_reply_list` | 子回复列表（待验证） |

### 3.2 Light vs Deep 模式

| 模式 | 执行阶段 | 说明 |
|------|---------|------|
| Light | Phase 1 仅 | 检测评论数变化，创建合成记录通知 |
| Deep | Phase 1 → 2 → 3 | 完整采集评论详情 |

---

## 四、登录与会话管理

### 4.1 登录流程

```
1. 先导航到 https://channels.weixin.qq.com/platform
2. 检查当前URL：
   ├── 包含 "/platform" → 登录态有效，直接返回 true
   └── 被重定向到 "/login" → 需要登录
3. 截取二维码 → 企微发送给用户
4. 轮询等待用户扫码确认（最长120秒）
5. 成功后自动跳转到 /platform
```

### 4.2 关键代码

```typescript
async handleLogin(page: Page, userId: number): Promise<boolean> {
  // 先尝试访问 platform，检查是否需要登录
  await page.goto('https://channels.weixin.qq.com/platform', {
    waitUntil: 'domcontentloaded',
  });
  await HumanActions.wait(page, 2000, 3000);
  
  // 已登录，无需扫码
  if (page.url().includes('/platform') && !page.url().includes('/login')) {
    logger.info('[Login] Session still valid, skip login');
    return true;
  }
  
  // 被重定向到登录页，需要扫码
  logger.info('[Login] Session expired, need QR scan');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user?.wechatUserid) {
    await captureAndSendQR(page, userId, 'tencent', user.wechatUserid);
  }
  
  // 轮询等待扫码
  const maxWait = 120_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const url = page.url();
    if (url.includes('/platform') && !url.includes('/login')) {
      logger.info('[Login] Login successful');
      return true;
    }
    
    const bodyText = await HumanActions.cdpGetBodyText(page);
    if (bodyText.includes('已过期')) {
      await HumanActions.cdpClick(page, '.qrcode-refresh-btn', { fallbackText: '刷新' });
      await captureAndSendQR(page, userId, 'tencent', user?.wechatUserid);
    }
    await HumanActions.wait(page, 2000, 3000);
  }
  
  logger.error('[Login] Login timeout after 120s');
  return false;
}
```

### 4.3 会话保活

```typescript
const SESSION_HEARTBEAT = 15 * 60 * 1000; // 15分钟

async keepSessionAlive(page: Page): Promise<void> {
  await page.goto('https://channels.weixin.qq.com/platform', {
    waitUntil: 'domcontentloaded',
  });
  if (page.url().includes('/login')) {
    throw new Error('SESSION_EXPIRED');
  }
}
```

### 4.4 风控检测

```typescript
const RISK_KEYWORDS = ['captcha', '验证', '安全', '限制', '封禁', '操作频繁', 'login'];

async detectRiskControl(page: Page): Promise<RiskControlDetection> {
  const url = page.url();
  if (['/login', '/verify', '/captcha'].some(r => url.includes(r) && !url.includes('/platform'))) {
    return { detected: true, type: 'url_redirect', evidence: `Redirected: ${url}` };
  }
  const bodyText = await HumanActions.cdpGetBodyText(page);
  for (const kw of RISK_KEYWORDS) {
    if (bodyText.includes(kw)) {
      return { detected: true, type: 'risk_keyword', evidence: `Found: "${kw}"` };
    }
  }
  return { detected: false, type: '', evidence: '' };
}
```

---

## 五、数据结构映射

### 5.1 视频信息

```typescript
export type TencentVideoInfo = {
  export_id: string;         // 视频唯一ID（对应抖音 aweme_id）
  desc: string;              // 视频描述/标题
  create_time: number;       // 发布时间戳
  object_stat: {
    play_count: number;      // 播放量
    like_count: number;      // 点赞数
    comment_count: number;   // 评论数 ★ 核心字段
    share_count: number;     // 分享数
    recommend_count: number; // 推荐数（视频号特有）
  };
  media_type?: number;
  status?: number;
};
```

### 5.2 评论信息

```typescript
export type TencentCommentInfo = {
  comment_id: string;       // 评论ID（对应抖音 cid）
  content: string;          // 评论内容（对应抖音 text）
  nickname: string;         // 用户昵称
  head_img_url: string;     // 头像URL
  create_time: number;      // 创建时间戳
  like_count: number;       // 点赞数（对应抖音 digg_count）
  reply_count: number;      // 回复数
  export_id: string;        // 所属视频ID
  is_author: boolean;       // 是否作者
  reply_to_nickname?: string;
  level: 1 | 2;             // 1=一级评论, 2=子回复
};
```

### 5.3 字段映射

| 视频号字段 | 抖音字段 | 说明 |
|-----------|---------|------|
| `export_id` | `aweme_id` | 视频唯一标识 |
| `comment_id` | `cid` | 评论唯一标识 |
| `content` | `text` | 评论内容 |
| `nickname` | `user_nickname` | 用户昵称 |
| `like_count` | `digg_count` | 点赞数 |
| `recommend_count` | 无 | 视频号特有 |

---

## 六、选择器策略

### 6.1 稳定性分级

| 等级 | 策略 | 示例 | 适用场景 |
|------|------|------|---------|
| S | `#id` | `#menuBar`, `#side-bar` | 侧边栏容器 |
| S | 文本匹配 | `getByText('span', '评论')` | 菜单项/按钮 |
| A | 组件前缀类 | `.finder-ui-desktop-menu__link_current` | 菜单状态 |
| A | JS钩子类 | `.js_nav_item` | 导航项 |
| B | WeUI图标 | `.weui-icon-outlined-home` | 图标定位 |
| C | `ml-key`属性 | `[ml-key="assistant_tab_privateMsg"]` | 特定元素 |
| D | Vue scoped | `[data-v-2a16615a]` | **避免使用** |

### 6.2 menuSelectors.ts — tencent 映射表

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
  'menu.content.video':    { category: 'menus', name: 'menu_content_video', parentKey: 'menu.content' },
  'menu.content.image':    { category: 'menus', name: 'menu_content_image', parentKey: 'menu.content' },
  'menu.content.draft':    { category: 'menus', name: 'menu_content_draft', parentKey: 'menu.content' },
  'menu.interact.comment': { category: 'menus', name: 'menu_interact_comment', parentKey: 'menu.interact' },
  'menu.interact.danmaku': { category: 'menus', name: 'menu_interact_danmaku', parentKey: 'menu.interact' },
  'menu.interact.message': { category: 'menus', name: 'menu_interact_message', parentKey: 'menu.interact' },
  'menu.data-center.video':    { category: 'menus', name: 'menu_data_video', parentKey: 'menu.data-center' },
  'menu.data-center.follower': { category: 'menus', name: 'menu_data_follower', parentKey: 'menu.data-center' },

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
}
```

### 6.3 菜单导航降级链

```
文本匹配 ("内容管理")
  ↓ 失败
.js_nav_item:has(span:has-text('内容管理'))
  ↓ 失败
.finder-ui-desktop-menu__sub__wrp:has(span:has-text('内容管理'))
  ↓ 失败
直接 page.goto('/platform/post/list')
```

---

## 七、企微通知扩展

### 7.1 平台信息

```typescript
case 'tencent':
  return { 
    label: '视频号', 
    cardActionUrl: 'https://channels.weixin.qq.com/platform/comment' 
  };
```

### 7.2 通知卡片扩展

```typescript
horizontal_content_list: [
  { keyname: '平台', value: '视频号' },
  { keyname: '视频', value: videoShort },
  { keyname: '总数', value: `${group.subReplies.length + 1} 条` },
  { keyname: '推荐数', value: String(recommendCount) },  // 新增
],
```

---

## 八、分阶段实施路线

| 阶段 | 内容 | 产出 | 预计工作量 |
|------|------|------|-----------|
| P0 | 登录 + 会话管理 | `handleLogin()` + `keepSessionAlive()` | 半天 |
| P1 | Light 模式监控 | 视频列表API拦截 + 评论数变化通知 | 1天 |
| P2 | Deep 模式监控 | 评论详情采集 + 入库 | 2天 |
| P3 | 拟人化回复 | 评论回复 + 风控检测 | 1天 |

---

## 九、关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 评论API路径未验证 | P2阻塞 | P0登录后立即验证，更新方案文档 |
| wujie微前端DOM隔离 | 选择器可能失效 | 优先API拦截，DOM操作作为回退 |
| 会话有效期不确定 | 频繁重登 | 15分钟心跳保活 + 过期检测 |

---

## 十、待验证事项

| 序号 | 待验证项 | 验证方法 | 重要性 |
|------|---------|---------|--------|
| 1 | 评论列表API真实路径 | Network面板 > XHR筛选 | **最高** |
| 2 | 评论API请求参数字段 | 查看请求body | **最高** |
| 3 | 评论API响应字段名 | 查看响应body | **最高** |
| 4 | 子回复API路径和参数 | 展开回复后查看Network | **高** |
| 5 | 视频列表分页机制 | 翻页时查看请求参数 | **高** |
| 6 | 视频ID字段名 (export_id?) | 查看 post_list 响应 | **高** |
