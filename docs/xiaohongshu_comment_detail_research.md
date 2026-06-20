# 小红书评论详情采集方案 — 调研报告

> 调研日期：2026-06-18 | 调研方法：浏览器实际操控 + 网络请求分析 + DOM 结构逆向

---

## 一、核心问题

小红书创作者服务中心（`creator.xiaohongshu.com`）**没有评论管理页面**（与抖音、快手不同），因此无法直接在创作者中心内获取评论树。目前系统仅支持"轻量模式"——通过笔记列表 API 追踪评论数量变化，但不采集评论内容。

---

## 二、解决方案：用户主页作为桥梁

### 2.1 关键发现

创作者中心的笔记管理页面**点击缩略图不会跳转到主站**（经实际测试验证：单击、双击缩略图/标题均无反应，点击操作按钮仅弹出"权限设置"弹窗）。

**真正可行的路径**：通过用户主页获取 `xsec_token`，再构造主站笔记详情页 URL。

### 2.2 完整采集流程

```
Phase 0: 预热（已有）
  └── 导航至 www.xiaohongshu.com → 随机滚动 → 建立 Cookie

Phase 1: 获取笔记列表（已有）
  └── 导航至 creator.xiaohongshu.com/new/note-manager
  └── 拦截 /api/galaxy/v2/creator/note/user/posted
  └── 提取 note_id 列表 + comment_count

Phase 2: 获取 xsec_token（新增 ★）
  └── 导航至 www.xiaohongshu.com/user/profile/{user_id}
  └── 从 DOM 中提取每个笔记的 xsec_token
  └── 构建 note_id → xsec_token 映射表

Phase 3: 逐笔记采集评论（新增 ★）
  └── for each note_id:
       ├── 导航至 www.xiaohongshu.com/explore/{note_id}?xsec_token={token}&xsec_source=pc_profile
       ├── 注册拦截器监听 comment API
       ├── 拦截一级评论：GET /api/sns/web/v2/comment/page
       ├── 滚动加载更多评论（翻页至 has_more=false）
       ├── 展开子评论：GET /api/sns/web/v2/comment/sub/page
       └── 提取评论树数据 → 入库
```

### 2.3 xsec_token 获取方式

**关键 URL 模式**：用户主页上的笔记链接格式为：
```
https://www.xiaohongshu.com/user/profile/{user_id}/{note_id}?xsec_token={token}
```

**提取方法**：
```javascript
// 在用户主页上执行
const links = document.querySelectorAll('a[href*="profile/{user_id}/"]');
const tokenMap = {};
for (const link of links) {
  const match = link.href.match(/profile\/([^/]+)\/([a-f0-9]+)\?xsec_token=([^&]+)/);
  if (match) {
    tokenMap[match[2]] = decodeURIComponent(match[3]); // noteId → token
  }
}
```

**注意事项**：
- 每个 note 有独立的 xsec_token
- token 由服务端生成，非客户端可计算
- 需要用户主页上已加载所有笔记（可能需要滚动加载）
- `xsec_source` 参数使用 `pc_profile` 值

---

## 三、DOM 选择器清单

### 3.1 创作者中心 — 笔记管理页面

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 笔记卡片容器 | `.note-card` | 每个笔记一张卡片 |
| 笔记缩略图 | `.note-card__cover .media-body img.content` | 缩略图图片 |
| 笔记标题 | `.note-card__title` | 笔记标题文本 |
| 操作按钮区域 | `.note-card__actions` | 悬浮时显示，class 追加 `--visible` |
| 权限设置按钮 | `.note-card__actions .note-card__action-btn` (index 1) | 眼睛图标，打开权限设置弹窗 |
| 编辑按钮 | `.note-card__actions .note-card__action-btn` (index 3) | 铅笔图标 |
| 删除按钮 | `.note-card__actions .note-card__action-btn--del` | 垃圾桶图标 |
| 笔记 ID | `.note-card[data-impression]` → JSON 解析 `noteTarget.value.noteId` | 从 data-impression 属性提取 |
| 滚动容器 | `#content-area main [class*="scroll"]`, `[class*="table"] [class*="body"]` | 列表滚动加载 |

### 3.2 主站 — 用户主页

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 用户头像 | `.user.side-bar-component` | 侧边栏"我"入口 |
| 笔记卡片 | `.note-item` | 主页笔记网格 |
| 笔记链接（含 token） | `a[href*="user/profile/{user_id}/{noteId}?xsec_token="]` | **★ 关键：获取 xsec_token** |
| 笔记链接（不含 token） | `a[href*="/explore/{noteId}"]` | 仅 noteId，无 token |

### 3.3 主站 — 笔记详情页（评论区）

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 评论外层容器 | `.comments-el` | 评论区根元素 |
| 评论总数 | `.comments-container .total` | 文本："共 N 条评论" |
| 评论列表容器 | `.comments-container .list-container` | 所有一级评论的父容器 |
| 一级评论滚动容器 | `.note-scroller` | 右侧面板可滚动区域，scrollHeight > clientHeight 时可滚动 |
| 单条评论项 | `.comment-item` | 每条评论，id 格式 `comment-{comment_id}` |
| 子评论标识 | `.comment-item.comment-item-sub` | 追加 `comment-item-sub` class |
| 评论者头像 | `.comment-item .avatar a` | href 含用户主页链接 |
| 评论者昵称 | `.comment-item .author .name` | `<a>` 标签 |
| 作者标识 | `.comment-item .author .tag` | 文本 "作者" |
| 评论内容 | `.comment-item .content .note-text` | 评论正文 |
| 评论日期 | `.comment-item .date span:first-child` | 如 "05-29"、"2025-08-23" |
| 评论 IP 属地 | `.comment-item .date .location` | 如 "北京"、"天津" |
| 点赞数 | `.comment-item .like-wrapper` | 数字或 "赞" |
| 回复按钮 | `.comment-item .reply` | 回复操作入口 |
| 置顶标识 | `.comment-item .labels .top` | 文本 "置顶评论" |
| 展开子评论 | `.reply-container .show-more` | 文本 "展开 N 条回复"，点击后触发 sub/page API |
| 评论输入框 | `.bottom-container [contenteditable="true"]` 或底部输入区域 | 发表评论用 |

---

## 四、网络 API 接口清单

### 4.1 笔记列表（创作者中心，已有）

```
GET https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted
  ?tab=0          // 0=全部
  &page=0         // 0-based 分页

Response:
{
  "data": {
    "notes": [
      {
        "id": "6a05e65b00000000360194b5",
        "title": "自动发布测试",
        "comments_count": 0,
        "liked_count": 0,
        ...
      }
    ]
  }
}
```

### 4.2 一级评论（主站，新增 ★）

```
GET https://edith.xiaohongshu.com/api/sns/web/v2/comment/page
  ?note_id={note_id}
  &cursor=                    // 空字符串=第一页，后续用返回值中的 cursor
  &top_comment_id=            // 可选，指定置顶评论
  &image_formats=jpg,webp,avif
  &xsec_token={xsec_token}   // ★ 从用户主页获取

Headers（浏览器自动附加）:
  x-s: {签名}
  x-t: {时间戳}
  x-s-common: {公共签名}

Response:
{
  "success": true,
  "code": 0,
  "data": {
    "has_more": true,                    // 是否还有下一页
    "cursor": "6a25ffb800000000280340bb", // 下一页游标
    "comments": [
      {
        "id": "6a1969b1000000002900f61f",
        "content": "听说智谱有周限额，是真的吗？",
        "create_time": 1748486400,
        "sub_comment_count": 15,
        "sub_comment_has_more": true,
        "sub_comment_cursor": "6a196a67000000002702315b",
        "sub_comments": [               // 默认前3条嵌套
          { "id": "...", "content": "...", "user_info": {...} }
        ],
        "user_info": {
          "user_id": "6428e541000000001102354c",
          "nickname": "Agent论道",
          "avatar": "https://sns-avatar-qc.xhscdn.com/..."
        },
        "interact_info": {
          "like_count": "1",
          "liked": false
        },
        "ip_location": "北京",
        "note_id": "6a196981000000003601c50a"
      }
    ]
  }
}
```

### 4.3 子评论/回复（主站，新增 ★）

```
GET https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page
  ?note_id={note_id}
  &root_comment_id={parent_comment_id}    // 父评论 ID
  &num=10                                 // 每页数量
  &cursor={last_sub_comment_id}           // 子评论游标（上一页最后一条的 ID）
  &image_formats=jpg,webp,avif
  &top_comment_id=
  &xsec_token={xsec_token}

Response:
{
  "success": true,
  "data": {
    "has_more": false,
    "cursor": "...",
    "comments": [
      {
        "id": "...",
        "content": "买得到就是胜利",
        "create_time": 1748490000,
        "user_info": {...},
        "interact_info": { "like_count": "5" },
        "ip_location": "海南",
        "target_comment": {               // 回复对象（区分多级回复）
          "id": "...",
          "user_info": { "nickname": "xxx" }
        }
      }
    ]
  }
}
```

---

## 五、采集流程详解

### 5.1 Phase 2: 用户主页获取 xsec_token

```
操作步骤：
1. 从创作者中心获取 user_id（从笔记列表 API 的 user.userId 字段）
2. 导航至 https://www.xiaohongshu.com/user/profile/{user_id}
3. 等待页面加载完成
4. 滚动加载所有笔记（如果笔记数 > 首屏显示数量）
5. 从 DOM 提取所有 a[href*="profile/{user_id}/{noteId}"] 链接
6. 解析每个链接中的 xsec_token
7. 构建 Map<noteId, xsecToken>
```

**滚动容器选择器**：页面主体（非特定容器，直接滚动 viewport）

**数据提取代码**：
```javascript
function extractTokensFromProfilePage(userId) {
  const links = document.querySelectorAll(`a[href*="profile/${userId}/"]`);
  const tokenMap = new Map();
  for (const link of links) {
    const match = link.href.match(
      /profile\/[^/]+\/([a-f0-9]+)\?xsec_token=([^&]+)/
    );
    if (match) {
      tokenMap.set(match[1], decodeURIComponent(match[2]));
    }
  }
  return tokenMap;
}
```

### 5.2 Phase 3: 笔记详情页评论采集

```
对每个 note_id:
  1. 构造 URL: https://www.xiaohongshu.com/explore/{note_id}?xsec_token={token}&xsec_source=pc_profile
  2. 导航至该 URL
  3. 等待评论 API 响应（通过 RequestInterceptor 拦截 comment/page）
  4. 解析一级评论数据
  5. 对每个有子评论的一级评论：
     a. 方法 A：展开子评论（点击 .show-more → 拦截 comment/sub/page）
     b. 方法 B：直接调用 sub/page API（需要 x-s/x-t 签名）
  6. 滚动 .note-scroller 加载更多一级评论（触发 cursor 翻页）
  7. 重复直到 has_more=false
```

**推荐方式**：使用 `RequestInterceptor` 旁路监控（方法 A），而非直接 fetch 调用。因为直接 fetch 缺少 `x-s`、`x-t`、`x-s-common` 签名头，会返回 "create invoker failed" 错误。

### 5.3 评论滚动加载策略

```
滚动容器: .note-scroller
scrollHeight: 动态增长
clientHeight: 约 983px（视口高度）

滚动策略:
1. 使用 HumanActions.cdpSmartScroll(page, ['.note-scroller'], 400, 'down')
2. 每次滚动后等待 1-3 秒
3. 检查是否有新的 comment/page API 响应
4. 连续 N 次无新数据 → 评论加载完毕
```

### 5.4 子评论展开策略

```
触发条件: 评论项下存在 .reply-container .show-more
文本模式: "展开 {N} 条回复"

操作步骤:
1. 定位 .show-more 元素
2. 使用 HumanActions.cdpClick(page, '.show-more') 点击
3. 等待 comment/sub/page API 响应
4. 解析子评论数据
5. 如果有更多子评论（has_more=true），继续滚动加载
```

---

## 六、旁路监控（RequestInterceptor）配置

### 6.1 需要拦截的 URL 模式

| 模式 | 说明 | 用途 |
|------|------|------|
| `/api/sns/web/v2/comment/page` | 一级评论分页 | 采集一级评论 |
| `/api/sns/web/v2/comment/sub/page` | 子评论分页 | 采集子回复 |
| `/api/galaxy/v2/creator/note/user/posted` | 笔记列表（已有） | 获取笔记 ID 和评论数 |

### 6.2 拦截器配置建议

```javascript
const COMMENT_PATTERNS = [
  '/api/sns/web/v2/comment/page',
  '/api/sns/web/v2/comment/sub/page'
];

// 注册拦截器
for (const pattern of COMMENT_PATTERNS) {
  interceptor.setValidationConfig(pattern, {
    expectedPageUrls: ['www.xiaohongshu.com'],
    requiredItemFields: ['id', 'content', 'user_info'],
    minItems: 0,
  });
}
interceptor.register(page, COMMENT_PATTERNS);
```

### 6.3 响应解析路径

```
一级评论:
  body.data.comments[]
    ├── .id                    → 评论 ID
    ├── .content               → 评论内容
    ├── .create_time           → 创建时间 (Unix timestamp)
    ├── .user_info.user_id     → 评论者 ID
    ├── .user_info.nickname    → 评论者昵称
    ├── .user_info.avatar      → 头像 URL
    ├── .interact_info.like_count → 点赞数
    ├── .ip_location           → IP 属地
    ├── .sub_comment_count     → 子评论数量
    ├── .sub_comment_has_more  → 是否有更多子评论
    ├── .sub_comment_cursor    → 子评论游标
    └── .sub_comments[]        → 默认前 3 条子评论

子评论:
  body.data.comments[]
    ├── .id, .content, .create_time, .user_info, .interact_info, .ip_location
    └── .target_comment        → 回复对象（区分多级回复）
        ├── .id
        └── .user_info.nickname

分页:
  body.data.has_more           → 是否有下一页
  body.data.cursor             → 下一页游标
```

---

## 七、风险与防封控策略

### 7.1 关键风险点

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| xsec_token 过期 | token 有时效性 | 每次采集前重新从用户主页获取 |
| 频繁访问笔记详情 | 短时间内访问多个笔记页 | 笔记间间隔 5-10 秒，模拟阅读行为 |
| 评论翻页请求频率 | 快速翻页可能触发风控 | 翻页间加入随机延迟 1-3 秒 |
| Cookie 过期 | a1, webId, websectiga 有有效期 | 定期刷新，失败时重新登录 |
| x-s/x-t 签名变化 | 签名算法可能更新 | 依赖浏览器原生请求，不自行构造 |

### 7.2 推荐采集节奏

```
1. 预热阶段: www.xiaohongshu.com 浏览 3-5 秒，随机滚动 1-2 次
2. 用户主页: 停留 3-5 秒，提取 token（可缓存 5 分钟）
3. 笔记详情页:
   - 进入后等待 2-3 秒（模拟阅读）
   - 评论加载完毕后再展开子评论
   - 展开子评论间隔 1-2 秒
   - 笔记间切换: 5-10 秒间隔
4. 退出策略: 采集完毕后随机浏览其他页面
```

---

## 八、与现有系统的集成建议

### 8.1 XiaohongshuCrawler 扩展

建议在现有 `XiaohongshuCrawler` 类中新增以下方法：

| 方法 | 说明 |
|------|------|
| `fetchXsecTokens(page, userId)` | 导航至用户主页，提取所有笔记的 xsec_token |
| `fetchCommentTree(page, noteId, token)` | 导航至笔记详情页，拦截评论 API，返回完整评论树 |
| `scrollLoadComments(page)` | 滚动加载一级评论 |
| `expandSubComments(page)` | 点击展开子评论 |
| `deepCheck(page, userId)` | 新的深度检查入口（替代现有的 light-only 限制） |

### 8.2 选择器配置（data/selectors.json 新增项）

```json
{
  "xiaohongshu": {
    "profile": {
      "note_link_with_token": {
        "primary": "a[href*='user/profile/{userId}/']",
        "description": "用户主页上带 xsec_token 的笔记链接"
      }
    },
    "comment": {
      "comments_container": {
        "primary": ".comments-el",
        "fallbacks": [".comments-container"]
      },
      "comment_item": {
        "primary": ".comment-item",
        "fallbacks": ["div[id^='comment-']"]
      },
      "sub_comment_item": {
        "primary": ".comment-item.comment-item-sub"
      },
      "comment_author": {
        "primary": ".author .name"
      },
      "comment_content": {
        "primary": ".content .note-text"
      },
      "comment_date": {
        "primary": ".date span:first-child"
      },
      "comment_location": {
        "primary": ".date .location"
      },
      "show_more_replies": {
        "primary": ".reply-container .show-more"
      },
      "total_count": {
        "primary": ".comments-el .total"
      }
    },
    "scroll": {
      "note_scroller": {
        "primary": ".note-scroller",
        "description": "笔记详情页右侧评论滚动容器"
      }
    }
  }
}
```

---

## 九、实测验证结论

| 验证项 | 结果 | 备注 |
|--------|------|------|
| 创作者中心缩略图点击跳转主站 | **失败** | 单击/双击均无反应 |
| 创作者中心操作按钮跳转主站 | **失败** | 眼睛图标打开权限设置弹窗 |
| 用户主页获取 xsec_token | **成功** | 每个笔记链接均含独立 token |
| 通过 token 导航至笔记详情页 | **成功** | URL 格式 `/explore/{id}?xsec_token={token}` |
| 评论 API 旁路拦截 | **成功** | `comment/page` 和 `comment/sub/page` 均可拦截 |
| 直接 fetch 评论 API | **失败** | 缺少 x-s/x-t 签名，返回 "create invoker failed" |
| 评论 DOM 解析 | **成功** | `.comment-item` 结构清晰，数据完整 |
| 子评论展开 | **成功** | `.show-more` 点击触发 `sub/page` API |

---

## 十、总结

小红书评论详情采集的核心突破点在于 **xsec_token 的获取**。通过用户主页（`/user/profile/{user_id}`）作为桥梁，可以从 DOM 中提取每个笔记的 xsec_token，然后构造主站笔记详情页 URL 进行评论采集。

**整个流程无需点击创作者中心的缩略图**，而是通过 API 获取 note_id + 从用户主页 DOM 提取 xsec_token 的组合方式实现。
