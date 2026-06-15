# 视频号助手平台分析指导文件

## 目标

通过浏览器操作和网络请求旁路监控，实现：
1. **视频数据更新**：获取视频列表，对比评论数变化，发现新评论
2. **评论树采集**：对每个有新评论的视频，采集完整的评论树（根评论 + 所有子回复）

## 核心原则

- **不使用 DOM 提取器读取评论内容**（不从 DOM 中解析评论文本）
- **通过浏览器操作触发 API 请求**（滚动加载、点击展开更多回复）
- **旁路监控网络请求**（拦截 fetch/XHR 响应，分析 JSON 数据）
- **拼接完整评论树**（从多个 API 响应中合并数据）

---

## 第一部分：平台架构分析

### 1.1 技术栈识别

视频号助手使用 **wujie 微前端** 架构：
- 主页面：`https://channels.weixin.qq.com/platform`
- 微前端内容通过 `<wujie-app>` 自定义元素加载
- 子页面在 iframe 中：`https://channels.weixin.qq.com/micro/...`
- 网络请求可能在主页面或 iframe 内部发出

**分析任务**：
1. 打开 `https://channels.weixin.qq.com/platform`
2. 检查页面中是否有 `<wujie-app>` 元素
3. 检查 `<wujie-app>` 是否有 `shadowRoot`
4. 检查 `<wujie-app>` 内部是否有 `<iframe>`
5. 如果有 iframe，获取 iframe 的 `src` URL
6. 检查 iframe 是否同源（能否访问 `contentDocument`）

### 1.2 页面导航结构

视频号助手的左侧菜单结构：

```
├── 首页
├── 内容管理
│   ├── 视频
│   ├── 图文
│   ├── 音乐音频
│   └── 草稿箱
├── 主页
├── 活动
├── 互动管理
│   ├── 评论
│   ├── 弹幕
│   └── 私信
├── 直播
│   ├── 直播管理
│   ├── 直播商品管理
│   ├── 直播预告
│   ├── 直播回放
│   ├── 个人创作
│   └── 礼物管理
├── 收入与服务
│   ├── 收入权益
│   └── 原创保护记录
├── 加热工具
├── 带货中心
├── 数据中心
│   ├── 关注者数据
│   ├── 视频数据
│   ├── 图文数据
│   ├── 直播数据
│   └── 带货数据
└── 设置
    ├── 人员设置
    ├── 肖像授权管理
    └── 服务菜单
```

**分析任务**：
1. 确认每个菜单项的 DOM 结构（class 名、层级关系）
2. 确认菜单展开/折叠的机制（CSS class 变化、style 属性变化）
3. 确认子菜单项的 DOM 结构和位置
4. 测试点击菜单后页面内容的变化（URL 是否变化、内容是否在 iframe 中加载）

---

## 第二部分：菜单导航操作

### 2.1 菜单展开机制

菜单项的 DOM 结构：
```html
<li class="finder-ui-desktop-menu__item finder-ui-desktop-menu__sub__wrp">
  <a class="finder-ui-desktop-menu__link finder-ui-desktop-menu__sub__link">
    <span class="finder-ui-desktop-menu__name"><span>互动管理</span></span>
  </a>
  <ul class="finder-ui-desktop-sub-menu" style="display: none;">
    <li class="finder-ui-desktop-sub-menu__item">
      <a class="finder-ui-desktop-menu__link finder-ui-desktop-menu__only-icon">
        <span class="finder-ui-desktop-menu__name"><span>评论</span></span>
      </a>
    </li>
  </ul>
</li>
```

**展开状态判断**：
- 折叠：`<ul class="finder-ui-desktop-sub-menu" style="display: none;">`
- 展开：`<ul class="finder-ui-desktop-sub-menu" style="">`
- 或者 `<a>` 标签增加 class `finder-ui-desktop-menu__sub-unfold`

**操作步骤**：
1. 找到目标菜单项的 `<a>` 标签
2. 检查子菜单 `<ul>` 的 `style.display` 是否为 `none`
3. 如果是 `none`，点击 `<a>` 标签展开菜单
4. 等待 1-2 秒，验证 `style.display` 是否变为 `""`（空）
5. 如果仍然为 `none`，重试点击（最多 3 次）

**分析任务**：
1. 点击「互动管理」菜单，观察子菜单（评论/弹幕/私信）是否展开
2. 记录展开前后的 CSS class 变化
3. 确认子菜单项的坐标位置（用于后续点击）

### 2.2 子菜单点击

子菜单项在 `<ul class="finder-ui-desktop-sub-menu">` 内部。

**操作步骤**：
1. 确认父菜单已展开（`style.display` 不是 `none`）
2. 在 `.finder-ui-desktop-sub-menu` 容器内查找目标文本（如「评论」）
3. 点击对应的 `<a>` 标签
4. 等待页面内容切换

**分析任务**：
1. 点击「评论」子菜单，观察页面内容变化
2. 检查 URL 是否变化（从 `/platform` 变为 `/platform/interaction/comment`）
3. 检查是否有新的 iframe 加载
4. 检查是否有新的网络请求发出

---

## 第三部分：视频列表获取

### 3.1 视频列表页面

**目标**：获取用户的视频列表，包括每个视频的评论数。

**导航路径**：内容管理 → 视频

**分析任务**：
1. 导航到「内容管理 → 视频」页面
2. 检查页面 URL 变化
3. 检查是否有 iframe 加载
4. **监控网络请求**：查找包含 `post_list` 或 `video` 关键字的 API 请求
5. 分析 API 响应结构，提取视频列表数据

### 3.2 视频列表 API

**预期 API**：
- URL 包含 `post_list` 或 `video/pc/photo/list`
- 请求方法：POST
- 响应格式：JSON

**预期响应结构**：
```json
{
  "errCode": 0,
  "errMsg": "",
  "data": {
    "list": [
      {
        "exportId": "export/xxx",
        "title": "视频标题",
        "commentCount": 12,
        "likeCount": 100,
        "viewCount": 1000,
        "createTime": 1780000000
      }
    ],
    "totalCount": 1,
    "continueFlag": false,
    "lastBuff": "..."
  }
}
```

**分析任务**：
1. 打开网络监控（DevTools → Network）
2. 导航到视频列表页面
3. 筛选 XHR/Fetch 请求
4. 查找包含视频列表数据的请求
5. 记录请求 URL、方法、headers、body
6. 分析响应 JSON 结构
7. 确认 `exportId`、`commentCount` 等关键字段的路径

### 3.3 API 请求触发

**问题**：视频号使用 wujie 微前端，API 请求可能在 iframe 内部发出，主页面的网络监控可能捕获不到。

**解决方案**：
1. **方案 A**：在主页面注入 fetch/XHR 拦截器（在页面加载前注入）
2. **方案 B**：通过 `page.frames()` 获取 iframe，然后在 iframe 内部注入拦截器
3. **方案 C**：刷新页面触发 API 请求，同时在 iframe 内部监控

**分析任务**：
1. 检查 `page.frames()` 返回的 frame 列表
2. 查找包含 `video` 或 `post` 关键字的 frame
3. 尝试在该 frame 内部注入 fetch 拦截器
4. 触发页面刷新或菜单切换，观察是否捕获到 API 请求

---

## 第四部分：评论管理页面

### 4.1 评论管理页面导航

**导航路径**：互动管理 → 评论

**分析任务**：
1. 展开「互动管理」菜单
2. 点击「评论」子菜单
3. 等待页面加载
4. 检查 URL 变化（应为 `/platform/interaction/comment`）
5. 检查是否有新的 iframe 加载（应为 `/micro/interaction/comment`）
6. 检查页面中是否显示评论列表

### 4.2 评论管理页面结构

评论管理页面通常包含：
- **视频切换器**：可以选择查看哪个视频的评论
- **评论列表**：显示当前视频的所有根评论
- **评论详情**：点击根评论可以查看子回复

**分析任务**：
1. 检查页面中是否有「切换视频」按钮
2. 检查视频切换器的 DOM 结构（下拉菜单、弹窗等）
3. 检查评论列表的 DOM 结构
4. 检查评论项的 DOM 结构（头像、昵称、内容、时间、点赞数等）
5. 检查是否有「展开更多回复」按钮

### 4.3 视频切换

**操作步骤**：
1. 查找「切换视频」按钮
2. 点击按钮，打开视频选择弹窗/抽屉
3. 在弹窗中查找目标视频（通过标题匹配）
4. 点击目标视频
5. 等待评论列表刷新

**分析任务**：
1. 记录「切换视频」按钮的选择器
2. 记录弹窗/抽屉的 DOM 结构
3. 记录视频列表项的 DOM 结构
4. 测试点击视频后评论列表的变化
5. 检查是否有新的 API 请求发出（`comment_list`）

---

## 第五部分：评论树采集（核心）

### 5.1 根评论 API

**预期 API**：
- URL 包含 `comment_list` 或 `comment/comment_list`
- 请求方法：POST
- 响应格式：JSON

**预期响应结构**：
```json
{
  "errCode": 0,
  "errMsg": "",
  "data": {
    "comment": [
      {
        "commentId": "123456",
        "commentContent": "评论内容",
        "commentNickname": "用户昵称",
        "commentHeadurl": "https://...",
        "commentCreatetime": 1780000000,
        "commentLikeCount": 5,
        "levelTwoComment": [
          {
            "commentId": "789012",
            "commentContent": "子回复内容",
            "commentNickname": "回复者昵称",
            "replyNickname": "被回复者昵称",
            "commentCreatetime": 1780000001
          }
        ],
        "levelTwoCommentCount": 3
      }
    ],
    "lastBuff": "...",
    "commentCount": 12,
    "downContinueFlag": true
  }
}
```

**分析任务**：
1. 打开网络监控
2. 导航到评论管理页面
3. 筛选 XHR/Fetch 请求
4. 查找包含评论列表数据的请求
5. 记录请求 URL、方法、headers、body
6. 分析响应 JSON 结构
7. 确认 `commentId`、`commentContent`、`levelTwoComment` 等关键字段的路径
8. 确认 `levelTwoCommentCount` 字段（表示子回复数量）
9. 确认 `downContinueFlag` 字段（表示是否有更多根评论）

### 5.2 根评论分页加载

**操作步骤**：
1. 进入评论管理页面
2. 等待首批根评论加载（`comment_list` API 响应）
3. 向下滚动评论列表
4. 监控是否有新的 `comment_list` API 请求发出（带 `lastBuff` 参数）
5. 分析新请求的参数和响应

**分析任务**：
1. 记录首批 API 请求的参数（`exportId`、`lastBuff` 等）
2. 滚动评论列表，观察是否触发新的 API 请求
3. 记录分页请求的参数变化（`lastBuff` 更新）
4. 记录分页响应的数据结构
5. 确认 `downContinueFlag` 为 `false` 时表示已加载所有根评论

### 5.3 子回复展开

**操作步骤**：
1. 在评论列表中查找「展开更多回复」或「查看 N 条回复」按钮
2. 点击按钮
3. 监控是否有新的 API 请求发出（`subCommentList` 或类似）
4. 分析子回复 API 的响应结构

**分析任务**：
1. 查找「展开更多回复」按钮的 DOM 结构
2. 记录按钮的文本模式（如「展开查看 3 条回复」、「查看全部 5 条回复」）
3. 点击按钮，观察页面变化
4. 检查网络请求，查找子回复 API
5. 记录子回复 API 的 URL、参数、响应结构
6. 确认子回复 API 的参数中是否包含根评论 ID
7. 确认子回复是否也有分页机制

### 5.4 子回复 API

**预期 API**：
- URL 包含 `subCommentList` 或 `comment/sub`
- 请求方法：POST
- 请求参数中包含根评论 ID（`commentId`）
- 响应格式：JSON

**预期响应结构**：
```json
{
  "errCode": 0,
  "errMsg": "",
  "data": {
    "list": [
      {
        "commentId": "789012",
        "commentContent": "子回复内容",
        "commentNickname": "回复者昵称",
        "replyNickname": "被回复者昵称",
        "commentCreatetime": 1780000001,
        "commentLikeCount": 2
      }
    ],
    "lastBuff": "...",
    "downContinueFlag": true
  }
}
```

**分析任务**：
1. 记录子回复 API 的完整 URL
2. 记录请求参数中的根评论 ID 字段名
3. 分析响应结构
4. 确认子回复是否有分页（`downContinueFlag`）
5. 确认子回复的分页参数（`lastBuff`）

### 5.5 子回复分页加载

**操作步骤**：
1. 点击「展开更多回复」按钮
2. 等待首批子回复加载
3. 在子回复列表中查找「加载更多」或「查看更多回复」按钮
4. 点击按钮，加载更多子回复
5. 监控 API 请求，记录分页参数

**分析任务**：
1. 确认子回复是否有「加载更多」按钮
2. 记录按钮的 DOM 结构和文本
3. 点击按钮后，检查 API 请求的参数变化
4. 确认 `lastBuff` 参数是否更新
5. 确认 `downContinueFlag` 为 `false` 时表示已加载所有子回复

---

## 第六部分：网络请求旁路监控

### 6.1 拦截器注入

**问题**：wujie 微前端的 iframe 内部的 API 请求可能无法被主页面的 CDP Network 层捕获。

**解决方案**：在页面内部注入 fetch/XHR 拦截器。

**注入时机**：
- 在页面加载前注入（通过 `page.addInitScript`）
- 或在 iframe 加载后注入（通过 `frame.addInitScript`）

**注入代码**：
```javascript
// 在页面加载前注入
window.__interceptedResponses = [];

// 拦截 fetch
const origFetch = window.fetch;
window.fetch = async function(...args) {
  const resp = await origFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
  // 匹配目标 API
  if (url.includes('post_list') || url.includes('comment_list') || url.includes('subCommentList')) {
    try {
      const clone = resp.clone();
      const body = await clone.json();
      window.__interceptedResponses.push({ url, body, timestamp: Date.now() });
    } catch {}
  }
  return resp;
};

// 拦截 XMLHttpRequest
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  this.__url = url;
  return origOpen.call(this, method, url, ...rest);
};
XMLHttpRequest.prototype.send = function(...args) {
  this.addEventListener('load', function() {
    const url = this.__url || '';
    if (url.includes('post_list') || url.includes('comment_list') || url.includes('subCommentList')) {
      try {
        const body = JSON.parse(this.responseText);
        window.__interceptedResponses.push({ url, body, timestamp: Date.now() });
      } catch {}
    }
  });
  return origSend.apply(this, args);
};
```

**分析任务**：
1. 在主页面注入拦截器
2. 在 iframe 中注入拦截器
3. 触发 API 请求（导航、滚动、点击）
4. 检查 `window.__interceptedResponses` 是否有数据
5. 如果主页面拦截不到，尝试在 iframe 中拦截

### 6.2 CDP Network 监控

**备选方案**：使用 CDP 的 `Network` 域监控请求。

**操作步骤**：
1. 启用 `Network` 域：`Network.enable`
2. 监听 `Network.responseReceived` 事件
3. 筛选目标 URL 模式
4. 获取响应体：`Network.getResponseBody`

**分析任务**：
1. 检查 CDP Network 是否能捕获 iframe 内部的请求
2. 如果能，记录请求 URL 和响应体
3. 如果不能，使用注入拦截器方案

### 6.3 请求参数分析

**分析任务**：
1. 记录每个 API 请求的完整参数
2. 分析参数中的关键字段：
   - `exportId`：视频 ID
   - `commentId`：根评论 ID（子回复 API）
   - `lastBuff`：分页游标
   - `photoId`：视频 ID（另一种格式）
3. 分析参数之间的关联关系

---

## 第七部分：评论树拼接

### 7.1 数据收集流程

1. **收集根评论**：
   - 触发 `comment_list` API 请求
   - 获取首批根评论（20 条）
   - 滚动加载更多根评论（带 `lastBuff` 分页）
   - 直到 `downContinueFlag` 为 `false`

2. **收集子回复**：
   - 遍历每个根评论
   - 如果 `levelTwoCommentCount > 0`，点击「展开更多回复」
   - 获取子回复 API 响应（带 `commentId` 参数）
   - 如果子回复有分页，继续加载更多
   - 直到 `downContinueFlag` 为 `false`

3. **拼接评论树**：
   - 根评论作为一级节点
   - 子回复作为二级节点
   - 子回复通过 `commentId` 参数关联到根评论

### 7.2 评论树数据结构

```typescript
interface CommentTree {
  commentId: string;
  content: string;
  nickname: string;
  headImgUrl: string;
  createTime: number;
  likeCount: number;
  level: 1; // 根评论
  subComments: SubComment[];
}

interface SubComment {
  commentId: string;
  content: string;
  nickname: string;
  replyToName: string; // 被回复者昵称
  createTime: number;
  likeCount: number;
  level: 2; // 子回复
  rootCommentId: string; // 关联的根评论 ID
}
```

### 7.3 去重逻辑

**问题**：滚动加载可能会重复获取已有的评论。

**解决方案**：
1. 维护一个已收集评论 ID 的 Set
2. 每次获取新评论后，过滤掉已存在的 ID
3. 只保留真正的新评论

---

## 第八部分：异常处理

### 8.1 常见问题

1. **API 请求未被拦截**：
   - 原因：请求在 iframe 内部发出，拦截器未注入到 iframe
   - 解决：在 iframe 中注入拦截器

2. **评论列表为空**：
   - 原因：页面未正确加载，或视频没有评论
   - 解决：检查页面状态，确认视频有评论

3. **子回复展开失败**：
   - 原因：「展开更多回复」按钮未找到或点击无效
   - 解决：检查按钮 DOM 结构，尝试不同的选择器

4. **分页加载不完整**：
   - 原因：滚动未触发加载，或 `lastBuff` 参数错误
   - 解决：检查滚动行为，确认 `lastBuff` 参数正确

### 8.2 风控检测

**检测点**：
1. 页面中是否出现验证码
2. 页面中是否出现「操作过于频繁」提示
3. API 响应中是否包含错误码

**处理方式**：
1. 检测到风控后，暂停操作
2. 等待一段时间后重试
3. 如果持续触发风控，通知用户手动处理

---

## 第九部分：实施步骤

### 9.1 第一步：平台结构分析

1. 打开视频号助手页面
2. 检查 wujie 微前端结构
3. 记录 iframe URL
4. 测试菜单导航
5. 记录每个页面的 URL 变化

### 9.2 第二步：API 发现

1. 在视频列表页面，监控网络请求
2. 找到 `post_list` API，记录请求和响应结构
3. 在评论管理页面，监控网络请求
4. 找到 `comment_list` API，记录请求和响应结构
5. 点击「展开更多回复」，找到子回复 API
6. 记录所有 API 的 URL、参数、响应结构

### 9.3 第三步：拦截器实现

1. 在主页面注入 fetch/XHR 拦截器
2. 在 iframe 中注入拦截器
3. 测试是否能捕获 API 请求
4. 如果不能，调整注入时机和位置

### 9.4 第四步：视频列表采集

1. 导航到视频列表页面
2. 通过拦截器获取视频列表 API 响应
3. 解析视频数据，提取 `exportId` 和 `commentCount`
4. 对比数据库，找出评论数变化的视频

### 9.5 第五步：评论树采集

1. 导航到评论管理页面
2. 切换到目标视频
3. 通过拦截器获取根评论 API 响应
4. 滚动加载所有根评论
5. 遍历每个根评论，展开子回复
6. 通过拦截器获取子回复 API 响应
7. 拼接完整评论树

### 9.6 第六步：数据入库

1. 将评论树数据写入数据库
2. 更新视频的评论数
3. 标记新评论

---

## 附录：API URL 模式

| API | URL 模式 | 用途 |
|-----|---------|------|
| 视频列表 | `*/post/post_list` | 获取视频列表 |
| 评论列表 | `*/comment/comment_list` | 获取根评论 |
| 子回复列表 | `*/comment/subCommentList` | 获取子回复 |
| 评论首页 | `*/comment/home` | 获取评论管理首页数据 |

## 附录：关键 DOM 选择器

| 元素 | 选择器 | 说明 |
|------|--------|------|
| 菜单容器 | `.finder-ui-desktop-menu__sub__wrp` | 一级菜单项 |
| 子菜单容器 | `.finder-ui-desktop-sub-menu` | 二级菜单容器 |
| 子菜单项 | `.finder-ui-desktop-sub-menu__item` | 二级菜单项 |
| 菜单文本 | `.finder-ui-desktop-menu__name span` | 菜单文字 |
| 展开状态 | `.finder-ui-desktop-menu__sub-unfold` | 菜单展开 class |
| 视频切换按钮 | `切换视频` 文本匹配 | 切换视频按钮 |
| 展开回复按钮 | `展开查看 N 条回复` 文本匹配 | 展开子回复 |
| 评论容器 | `[class*="comment"]` | 评论项容器 |
