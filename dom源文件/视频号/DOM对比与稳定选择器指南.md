# 视频号助手 DOM 对比与稳定选择器指南

> 创建日期：2026-06-10
> 平台：微信视频号助手 (channels.weixin.qq.com)
> 数据验证：浏览器实际登录抓取 + Network面板API确认

---

## 一、平台技术架构

### 1.1 核心架构

| 属性 | 值 |
|------|-----|
| 应用名 | `finder-helper-web` (noscript标签中确认) |
| 前端框架 | Vue 3 SPA |
| 微前端 | **wujie (无界)** — 腾讯自研微前端框架 |
| 组件库 | WeUI设计体系 + Element UI |
| Vue Scoped | `data-v-2a16615a` (侧边栏), `data-v-757dc8fe` (内容区) |
| API前缀 | `/cgi-bin/mmfinderassistant-bin/` |
| 内容模块API | `/micro/content/cgi-bin/mmfinderassistant-bin/` |
| CDN | `res.wx.qq.com/t/wx_fed/finder/helper/` |
| 登录方式 | 微信扫码 (仅支持扫码, 无账号密码) |
| 路由方式 | History API (非Hash路由) |

### 1.2 wujie 微前端架构

平台使用腾讯的 wujie 微前端框架，核心特征:
- 主壳应用 (`finder-helper-web`) 负责侧边栏/路由/登录
- 子应用通过 `<wujie-app data-wujie-id="xxx">` 标签加载:
  - `content` — 内容管理模块 (视频/图文/评论等)
  - `live` — 直播模块
  - `eccommerce` — 电商/带货模块
- 子应用CSS通过 `data-wujie-attach-css-flag` 注入
- 子应用独立打包，资源前缀: `/micro/content/`, `/micro/live/`

### 1.3 与抖音/快手/小红书的对比

| 维度 | 视频号 | 抖音 | 快手 | 小红书 |
|------|--------|------|------|--------|
| 登录 | 微信扫码 | Cookie | Cookie+签名 | Cookie+签名 |
| 前端 | Vue3+wujie | 自研+Semi | Vue+ElementUI | Vue+D组件 |
| 微前端 | wujie无界 | 无 | 无 | 无 |
| API前缀 | mmfinderassistant | aweme/v1/web | rest/cp/creator | api/sns/web |
| 签名 | Session Cookie | msToken+a_bogus | __NS_sig3 | xsec_token |
| CSS命名 | finder-ui-desktop-* | douyin-creator-* | BEM+Modules | d-*组件 |
| 路由 | History API | History API | History API | History API |

---

## 二、CSS 类名体系

### 2.1 侧边栏组件 (finder-ui-desktop-menu)

所有侧边栏相关类名以 `finder-ui-desktop-menu__` 为前缀:

| 类名 | 用途 | 稳定性 |
|------|------|--------|
| `finder-ui-desktop-menu__wrp` | 菜单外层容器 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__container` | 菜单内层容器 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu_global` | 全局菜单标识 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__link` | 菜单项链接 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__link_current` | 当前选中状态 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__name` | 菜单项文本容器 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__sub__wrp` | 可展开子菜单外层 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-sub-menu` | 子菜单列表 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-sub-menu__item` | 子菜单项 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-sub-menu__current` | 子菜单展开状态 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__sub__active` | 子菜单父级激活 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__sub-unfold` | 子菜单展开标识 | ⭐⭐⭐⭐ 高 |
| `finder-ui-desktop-menu__icon_logo` | 图标容器 | ⭐⭐⭐ 中 |
| `finder-ui-desktop-menu__has_icon` | 带图标的菜单项 | ⭐⭐⭐ 中 |
| `finder-ui-desktop-menu__only-icon` | 仅图标的子菜单项 | ⭐⭐⭐ 中 |
| `js_nav_item` | 导航项JS钩子 | ⭐⭐⭐⭐⭐ 最高 |
| `weui-icon-outlined-home` | WeUI图标类 | ⭐⭐⭐⭐ 高 |
| `weui-icon-filled-home` | WeUI填充图标 | ⭐⭐⭐⭐ 高 |

### 2.2 结构类 (通用)

| 类名 | 用途 |
|------|------|
| `app-body` | 应用主体容器 |
| `micro-whole-app` | 微前端整体容器 |
| `container-wrap` | 内容区外层 |
| `container-center` | 内容区居中 |
| `router-view` | 路由视图 |
| `wujie_iframe` | wujie子应用容器 |
| `side-bar-header` | 侧边栏头部 |
| `brand-name` | 品牌名称 |

### 2.3 选择器稳定性等级

| 等级 | 策略 | 示例 |
|------|------|------|
| ⭐⭐⭐⭐⭐ | `#id` 选择器 | `#menuBar`, `#side-bar` |
| ⭐⭐⭐⭐⭐ | 文本匹配 | `findByText('span', '评论')` |
| ⭐⭐⭐⭐ | 组件前缀类名 | `.finder-ui-desktop-menu__link_current` |
| ⭐⭐⭐⭐ | JS钩子类名 | `.js_nav_item` |
| ⭐⭐⭐ | WeUI图标类 | `.weui-icon-outlined-home` |
| ⭐⭐ | ml-key属性 | `[ml-key="assistant_tab_privateMsg"]` |
| ⭐ | Vue scoped hash | `[data-v-2a16615a]` |

---

## 三、各页面选择器策略

### 3.1 菜单导航

**推荐的选择器降级链:**

```json
{
  "menu.content.video": {
    "primary": "getByText('span', '视频', exact=true)",
    "fallbacks": [
      "#menuBar .finder-ui-desktop-menu__link_current:has(span:has-text('视频'))",
      ".finder-ui-desktop-sub-menu__item:has(span:has-text('视频'))"
    ],
    "parentKey": "menu.content",
    "description": "内容管理 > 视频"
  },
  "menu.interact.comment": {
    "primary": "getByText('span', '评论', exact=true)",
    "fallbacks": [
      ".finder-ui-desktop-sub-menu__item:has(span:has-text('评论'))"
    ],
    "parentKey": "menu.interact",
    "description": "互动管理 > 评论"
  }
}
```

### 3.2 视频列表页

| 元素 | 选择器 | 数据提取 |
|------|--------|---------|
| 视频卡片 | `.video-card` 或按文本"视频管理"定位页面 | 容器 |
| 视频标题 | `.video-title` 文本 | 描述 |
| 发布时间 | `.publish-time` 文本 | 日期解析 |
| 播放量 | 第1个 `.stat-value` | 数字(可能含"万") |
| 点赞数 | 第2个 `.stat-value` | 数字 |
| 评论数 | 第3个 `.stat-value` | 数字 |
| 分享数 | 第4个 `.stat-value` | 数字 |
| 推荐数 | 第5个 `.stat-value` | 数字 |

**注意**: 由于wujie微前端，视频卡片DOM在 `<wujie-app>` 内，可能需要通过 `document.querySelector('wujie-app').shadowRoot` 或直接在主文档中查找。

### 3.3 评论管理页

| 元素 | 选择器 | 数据提取 |
|------|--------|---------|
| 评论容器 | `.comment-item` | 评论卡片 |
| 评论ID | `[data-comment-id]` | 唯一标识 |
| 用户昵称 | `.comment-username` | 文本 |
| 评论内容 | `.comment-text` | 文本 |
| 回复按钮 | `.reply-btn` 或文本"回复" | 操作入口 |
| 回复输入 | `.reply-textarea` | 输入区域 |
| 发送按钮 | `.submit-reply-btn` | 发送操作 |
| 切换视频 | `.switch-video-btn` 或文本"切换视频" | 视频选择 |

---

## 四、API 拦截策略

### 4.1 已确认的 API 端点

```typescript
// ★ 视频列表 (已确认)
const POST_LIST_PATTERN = '/mmfinderassistant-bin/post/post_list';

// ★ 合集列表 (已确认)
const COLLECTION_LIST_PATTERN = '/mmfinderassistant-bin/collection/get_collection_list';

// ★ 会话/用户数据 (已确认)
const SESSION_DATA_PATTERN = '/mmfinderassistant-bin/helper/hepler_merlin_mmdata';
const HELPER_DATA_PATTERN = '/mmfinderassistant-bin/helper/helper_mmdata';

// 评论列表 (待确认, 推测)
const COMMENT_LIST_PATTERN = '/mmfinderassistant-bin/comment/';

// 发送评论 (待确认, 推测)
const COMMENT_PUBLISH_PATTERN = '/mmfinderassistant-bin/comment/publish';
```

### 4.2 RequestInterceptor 配置

```typescript
// 参照 douyinCrawler.ts 的模式
const interceptor = new RequestInterceptor();

// 注册视频列表监听
interceptor.register({
  urlPattern: POST_LIST_PATTERN,
  validateConfig: {
    expectedPageUrl: '/platform/post/list',
    requiredFields: ['list']  // 待确认具体字段名
  }
});

// 注册评论列表监听
interceptor.register({
  urlPattern: COMMENT_LIST_PATTERN,
  validateConfig: {
    expectedPageUrl: '/platform/comment',
    requiredFields: ['list']  // 待确认
  }
});
```

---

## 五、Cookie 管理

### 5.1 登录流程

```
1. 导航 → /login.html
2. iframe[src*="login-for-iframe"] 加载二维码
3. 用户微信扫码
4. 轮询检测: URL跳转到 /platform = 成功
5. Cookie 自动设置到 channels.weixin.qq.com
```

### 5.2 Cookie 保活

- 有效期: 数小时到数天 (未公开)
- 检测方法: 导航到 `/platform` → 跳转到 `/login.html` = 过期
- 心跳保活: 定期访问首页维持会话 (15-30分钟间隔)
- 关键域名: `.weixin.qq.com`, `channels.weixin.qq.com`

---

## 六、待验证事项 (需登录后DevTools确认)

以下信息基于浏览器实际访问获取，但部分DOM细节因wujie微前端隔离无法直接读取:

1. **视频卡片精确CSS类名** — 需通过Elements面板检查wujie内部DOM
2. **评论页精确DOM结构** — 需导航到评论页后检查
3. **评论API具体路径和字段** — 需Network面板抓取XHR请求
4. **视频列表分页机制** — 是offset分页还是cursor游标
5. **视频ID字段名** — `export_id` 还是其他名称
6. **数据中心各子页面URL** — 确认 `/platform/data/video` 等路径

### 验证步骤

1. 登录后打开 Chrome DevTools (F12)
2. Network面板: 勾选 "Preserve log" + 筛选 "XHR"
3. 依次导航到各页面，记录API请求
4. Elements面板: 检查wujie-app内部DOM
5. 更新本指南中的选择器和API信息
