# 视频号助手平台调研报告

## 一、平台架构分析

### 1.1 wujie 微前端架构

视频号助手（`https://channels.weixin.qq.com/platform`）采用 **wujie 微前端** 架构，核心特征如下：

**主页面结构**：

```
<body>
  <svg id="__SVG_SPRITE_NODE__">       <!-- SVG 图标精灵 -->
  <div id="app" class="finder-page Home">  <!-- 主应用容器 -->
    <wujie-app data-wujie-id="postCard" class="wujie_iframe">  <!-- 微前端容器 -->
      #shadow-root (open)
        <html>
          <head>...</head>
          <body>
            <div id="app" class="finder-page PostList">  <!-- 子应用实例 -->
              <!-- 页面具体内容 -->
            </div>
          </body>
        </html>
    </wujie-app>
  </div>
  <iframe src="https://channels.weixin.qq.com/empty.html">  <!-- 空 iframe，用于通信 -->
</body>
```

**关键发现**：

- `<wujie-app>` 元素拥有 **open 模式的 shadow root**，子应用渲染在 shadow DOM 内部
- **无内部 iframe**：子页面内容不通过 iframe 加载，而是直接渲染在 shadow DOM 中
- `data-wujie-id` 随页面切换而变化：首页为 `postCard`，内容管理为 `content`，互动管理为 `interaction`
- 主文档 `#app` 的 class 反映当前页面：`finder-page Home`、`finder-page PostList` 等
- 菜单/侧边栏在 **主文档** 中，不在 shadow DOM 内

### 1.2 菜单导航机制

侧边栏菜单位于主文档，DOM 结构如下：

```html
<div class="finder-ui-desktop-menu__wrp finder-ui-desktop-menu__unflod__wrp">
  <div class="finder-ui-desktop-menu__container">
    <div class="finder-ui-desktop-menu__header">视频号 · 助手</div>
    <ul class="finder-ui-desktop-menu finder-ui-desktop-menu_global">
      <!-- 一级菜单项 -->
      <li class="finder-ui-desktop-sub-menu__item">  <!-- 无子菜单项（如首页） -->
        <a class="finder-ui-desktop-menu__link finder-ui-desktop-menu__link_current">
          <span class="finder-ui-desktop-menu__name"><span>首页</span></span>
        </a>
      </li>
      <li class="finder-ui-desktop-menu__item finder-ui-desktop-menu__sub__wrp">  <!-- 有子菜单项 -->
        <a class="finder-ui-desktop-menu__link finder-ui-desktop-menu__sub__link">
          <span class="finder-ui-desktop-menu__name"><span>内容管理</span></span>
        </a>
        <ul class="finder-ui-desktop-sub-menu" style="display: none;">  <!-- 折叠状态 -->
          <li class="finder-ui-desktop-sub-menu__item">
            <a class="finder-ui-desktop-menu__link finder-ui-desktop-menu__only-icon">
              <span class="finder-ui-desktop-menu__name"><span>视频</span></span>
            </a>
          </li>
          <!-- 更多子菜单... -->
        </ul>
      </li>
    </ul>
  </div>
</div>
```

**展开/折叠状态判断**：

| 状态 | `<ul>` 子菜单 style | `<a>` 链接 class |
|------|---------------------|-------------------|
| 折叠 | `style="display: none;"` | 无 `sub-unfold` class |
| 展开 | style 属性移除（空） | 添加 `finder-ui-desktop-menu__sub-unfold` |
| 当前页 | - | 添加 `finder-ui-desktop-menu__link_current` |

**完整菜单树**：

| 一级菜单 | 子菜单 |
|---------|--------|
| 首页 | — |
| 内容管理 | 视频、图文、音乐、音频、草稿箱、主页、活动 |
| 互动管理 | 评论、弹幕、私信 |
| 直播 | 直播管理、直播商品管理、直播预告、直播回放、个人创作礼物管理 |
| 收入与服务 | 收入权益、原创保护记录、加热工具 |
| 带货中心 | — |
| 数据中心 | 关注者数据、视频数据、图文数据、直播数据、带货数据 |
| 设置 | 人员设置、肖像授权管理、服务菜单 |

### 1.3 URL 路由映射

| 页面 | URL | wujie-app data-wujie-id |
|------|-----|------------------------|
| 首页 | `/platform` | `postCard` |
| 视频列表 | `/platform/post/list` | `content` |
| 评论管理 | `/platform/interaction/comment` | `interaction` |

### 1.4 SPA 导航注意事项

- 菜单点击触发 **SPA 内部导航**，不刷新页面
- **必须通过菜单点击进行页面导航**，避免使用 `browser.navigate()` 直接跳转 URL，否则会触发完整页面重载，导致页面状态丢失
- 导航流程：先用 `find` 工具定位菜单文本 → 再用 `computer` 工具模拟鼠标点击

---

## 二、API 端点发现

### 2.1 API 基础信息

所有 API 的 **baseURL**：`/micro/{module}/cgi-bin/mmfinderassistant-bin`

| 模块 | baseURL |
|------|---------|
| 内容管理 | `/micro/content/cgi-bin/mmfinderassistant-bin` |
| 互动管理 | `/micro/interaction/cgi-bin/mmfinderassistant-bin` |

**请求通用参数**：

| 参数 | 说明 | 示例 |
|------|------|------|
| `_aid` | 应用 ID（会话级） | `788aa51f-0439-475c-b32b-a8cb4c1d3d9a` |
| `_rid` | 请求 ID（随机生成） | `6a2cb09a-77a0b900` |
| `_pageUrl` | 当前页面 URL（编码后） | `https%3A%2F%2Fchannels.weixin.qq.com%2Fmicro%2Finteraction%2Fcomment` |

### 2.2 视频列表 API

**端点**：`POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_list`

**请求触发**：导航到「内容管理 → 视频」或评论管理页面时自动发出

**数据获取方式**：使用 `read_network_requests` 工具，通过 URL 模式 `post_list` 过滤，获取 API 响应体

**视频数据字段**（API 响应 `data.list` 中的每个元素）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `exportId` / `objectId` | string | 视频唯一 ID（如 `export/UzFfBgAAxOCnAFZ1PhfKjMzT4DCa...`） |
| `desc.description` | string | 视频标题（如 "生活life"） |
| `createTime` | number | 创建时间戳（秒级 Unix timestamp） |
| `commentCount` | number | 评论数 |
| `likeCount` | number | 点赞数 |
| `readCount` | number | 播放数 |
| `forwardCount` | number | 转发数 |
| `favCount` | number | 收藏数 |
| `commentClose` | number | 评论是否关闭（0=开启，1=关闭） |
| `visibleType` | number | 可见性 |
| `status` | number | 状态 |
| `objectType` | number | 对象类型 |
| `objectNonce` | string | 对象 nonce |
| `fullPlayRate` | number | 完播率 |
| `avgPlayTimeSec` | number | 平均播放时长（秒） |
| `desc.media[].videoPlayLen` | number | 视频时长（秒） |
| `desc.media[].width` / `height` | number | 视频分辨率 |
| `desc.media[].thumbUrl` | string | 封面图 URL |
| `desc.location.city` | string | 定位城市 |

**分页字段**：

| 字段 | 说明 |
|------|------|
| `pageSize` | 每页大小（默认 20） |
| `total` | 总视频数 |
| `lastBuffer` | 分页游标（空字符串表示无更多） |
| `continueFlag` | 是否有更多（false=已加载全部） |

### 2.3 评论列表 API

**端点**：`POST /micro/interaction/cgi-bin/mmfinderassistant-bin/comment/comment_list`

**重要发现**：**没有独立的 `subCommentList` API**。子回复的加载也通过 `comment_list` 端点实现，通过传入 `commentId` 和 `lastBuff` 参数来加载更多子回复。

**请求触发**：
1. 点击视频列表中的某个视频 → 加载该视频的根评论
2. 滚动评论区域到底部 → 加载更多根评论（分页）
3. 点击「展开更多回复」按钮 → 加载指定根评论的子回复

**数据获取方式**：使用 `read_network_requests` 工具，通过 URL 模式 `comment_list` 过滤，获取 API 响应体

#### 2.3.1 根评论数据结构

API 响应 `data.comment` 数组中每个元素的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `commentId` | string | 评论唯一 ID（如 `"14942722901145946688"`） |
| `commentNickname` | string | 评论者昵称 |
| `commentContent` | string | 评论文本 |
| `commentHeadurl` | string | 头像 URL |
| `commentCreatetime` | string | 创建时间戳（字符串格式的秒级 Unix timestamp） |
| `commentLikeCount` | number | 点赞数 |
| `levelTwoComment` | Array | 子回复数组（初始包含前几条） |
| `downContinueFlag` | number | 是否有更多子回复（1=有，0=无） |
| `lastBuff` | string | 子回复分页游标 |
| `visibleFlag` | number | 可见性标志 |
| `readFlag` | boolean | 是否已读 |
| `likeFlag` | number | 点赞状态 |
| `username` | string | 用户名 |
| `blacklistFlag` | number | 黑名单状态 |

**分页控制字段**（API 响应 `data` 层级）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `commentCount` | number | 评论总数 |
| `lastBuff` | string | 根评论分页游标，传入下次请求 |
| `downContinueFlag` | number | 是否有更多根评论（1=有，0=无） |

#### 2.3.2 子回复数据结构

`levelTwoComment` 数组中每个元素的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `commentId` | string | 子回复 ID |
| `commentNickname` | string | 回复者昵称 |
| `commentContent` | string | 回复文本 |
| `replyNickname` | string | 被回复者昵称 |
| `commentCreatetime` | string | 创建时间戳 |
| `commentLikeCount` | number | 点赞数 |

### 2.4 其他发现的 API

| API | URL 模式 | 用途 |
|-----|---------|------|
| 视频列表 | `POST /micro/content/.../post/post_list` | 获取视频列表 |
| 评论列表 | `POST /micro/interaction/.../comment/comment_list` | 获取根评论 + 子回复（同一端点） |
| 更新视频评论数 | `POST /micro/interaction/.../comment/update_feed_comment` | 更新视频评论计数 |
| 联系人信息 | `POST /micro/interaction/.../comment/get-contact-info` | 获取评论者联系信息 |
| 合集列表 | `POST /micro/content/.../collection/get_collection_list` | 获取视频合集 |
| 粉丝趋势 | `POST /cgi-bin/.../statistic/fans_trend` | 粉丝增长趋势 |
| 数据总览 | `POST /cgi-bin/.../statistic/new_post_total_data` | 内容数据汇总 |
| 通知列表 | `POST /cgi-bin/.../notification/notification_list` | 系统通知 |
| 认证信息 | `POST /cgi-bin/.../auth/get_auth_info` | 账号认证状态 |
| 埋点上报 | `POST /cgi-bin/.../helper/hepler_merlin_mmdata` | 大量埋点/监控请求（可忽略） |

---

## 三、数据采集方案（安全浏览器自动化）

### 3.1 核心工具链

| 操作类型 | 使用工具 | 说明 |
|---------|---------|------|
| **页面导航** | `find` + `computer`（click） | 通过文本查找菜单项，模拟鼠标点击进行 SPA 导航 |
| **页面内容读取** | `read_page` / `find` / `get_page_text` | 读取页面可访问性树或文本内容 |
| **API 数据捕获** | `read_network_requests` | 通过 CDP 网络层捕获 API 请求和响应体，支持 URL 模式过滤 |
| **滚动加载** | `computer`（scroll） | 模拟鼠标滚动触发分页加载 |
| **点击交互** | `computer`（left_click） | 通过坐标或 ref 模拟鼠标点击按钮、列表项等 |
| **截图验证** | `computer`（screenshot） | 截图确认页面状态 |
| **等待加载** | `computer`（wait） | 等待 API 响应完成 |

### 3.2 数据获取核心策略

**方案：CDP 网络请求监控 + DOM 选择器定位**

```
操作流程：
1. 通过菜单点击导航到目标页面
2. 等待页面加载（wait 2-3秒）
3. 使用 read_network_requests 捕获 API 响应
   - urlPattern: "post_list"     → 视频列表数据
   - urlPattern: "comment_list"  → 评论数据
4. 使用 find / read_page 定位页面元素
5. 使用 computer（click/scroll）触发更多数据加载
6. 重复步骤 3 获取分页数据
```

**关键优势**：
- **零 JS 注入**：所有数据采集通过 CDP 网络监控完成，无需注入任何脚本
- **CDP 网络层可捕获微前端内部请求**：`read_network_requests` 基于 Chrome DevTools Protocol，可以捕获 wujie 微前端 shadow DOM 内部发出的所有网络请求
- **API 响应体即为结构化 JSON 数据**：直接从网络请求中提取，无需额外解析 DOM

### 3.3 网络请求过滤策略

`read_network_requests` 工具支持 `urlPattern` 参数过滤请求。推荐使用的过滤模式：

| 目标数据 | urlPattern | 说明 |
|---------|-----------|------|
| 视频列表 | `post_list` | 过滤 post_list API |
| 评论列表 | `comment_list` | 过滤 comment_list API |
| 所有业务 API | `mmfinderassistant-bin` | 过滤所有业务请求（排除静态资源） |
| 排除埋点 | 忽略 `hepler_merlin_mmdata` | 埋点请求极其频繁，应忽略 |

**注意**：每次调用 `read_network_requests` 后建议使用 `clear: true` 清除已读请求，避免重复处理。

---

## 四、评论树采集完整流程

### 4.1 操作流程（全安全操作，无 JS 注入）

```
步骤 1：导航到评论管理页面
  ├→ find("互动管理") → 获取菜单 ref
  ├→ computer(left_click, ref) → 展开子菜单
  ├→ computer(wait, 1.5秒) → 等待动画完成
  ├→ find("评论") → 获取子菜单 ref
  └→ computer(left_click, ref) → 点击「评论」导航

步骤 2：获取视频列表
  ├→ computer(wait, 3秒) → 等待页面加载和 API 请求完成
  └→ read_network_requests(urlPattern: "post_list") → 捕获视频列表 API 响应
     └→ 从响应 JSON 中提取：视频标题、exportId、commentCount

步骤 3：选择目标视频并加载评论
  ├→ screenshot() → 截图确认视频列表位置
  ├→ computer(left_click, 视频列表项坐标) → 点击选中视频
  ├→ computer(wait, 3秒) → 等待评论加载
  └→ read_network_requests(urlPattern: "comment_list") → 捕获评论 API 响应
     └→ 从响应 JSON 中提取：根评论列表、子回复、分页标志

步骤 4：滚动加载更多根评论（分页）
  ├→ computer(scroll, 评论区域坐标, direction: down) → 向下滚动
  ├→ computer(wait, 2秒) → 等待加载
  ├→ read_network_requests(urlPattern: "comment_list") → 捕获新的评论 API 响应
  └→ 循环直到响应中 downContinueFlag === 0

步骤 5：展开子回复
  ├→ find("展开更多回复") → 查找展开按钮
  ├→ 如果按钮存在：
  │   ├→ computer(left_click, ref 或坐标) → 点击展开按钮
  │   ├→ computer(wait, 2秒) → 等待子回复加载
  │   └→ read_network_requests(urlPattern: "comment_list") → 捕获子回复 API 响应
  └→ 循环直到 find("展开更多回复") 返回空（按钮消失表示全部加载完成）

步骤 6：切换到下一个视频
  ├→ screenshot() → 截图确认视频列表位置
  ├→ computer(left_click, 下一个视频项坐标) → 点击切换视频
  └→ 重复步骤 3-5
```

### 4.2 关键 DOM 选择器（用于 find / read_page 工具）

| 用途 | 查找方式 | 文本/选择器 | 所在区域 |
|------|---------|------------|---------|
| 首页菜单 | `find("首页")` | 文本匹配 | 主文档侧边栏 |
| 内容管理菜单 | `find("内容管理")` | 文本匹配 | 主文档侧边栏 |
| 互动管理菜单 | `find("互动管理")` | 文本匹配 | 主文档侧边栏 |
| 视频子菜单 | `find("视频")` | 文本匹配 | 主文档侧边栏 |
| 评论子菜单 | `find("评论")` | 文本匹配 | 主文档侧边栏 |
| 当前活跃菜单 | `read_page` 检查 | class 包含 `link_current` | 主文档侧边栏 |
| 视频列表项 | `screenshot` 坐标定位 | 截图确认后用坐标点击 | shadow DOM 内容区 |
| 评论标题 | `find("评论管理")` | 文本匹配 | shadow DOM 内容区 |
| 全部评论标签 | `find("全部评论")` | 文本匹配 | shadow DOM 内容区 |
| 展开更多回复 | `find("展开更多回复")` | 文本匹配 | shadow DOM 内容区 |
| 评论权限按钮 | `find("启用")` | 文本匹配 | shadow DOM 内容区 |

### 4.3 坐标定位参考（基于 1920×1080 分辨率）

| 元素 | 近似坐标 (x, y) | 说明 |
|------|-----------------|------|
| 侧边栏菜单项 | (132, 148~660) | x 固定 ~132，y 按菜单顺序递增 |
| 视频列表项（评论页左侧） | (632, 341) / (632, 437) | 评论管理页的视频切换列表 |
| 评论详情区域（右侧） | (1200, 600) | 评论列表滚动区域 |
| 「展开更多回复」按钮 | 动态定位 | 使用 `find("展开更多回复")` 获取 ref 后点击 |

**注意**：坐标会随窗口大小变化，建议优先使用 `find` + `ref` 方式定位，仅在 find 无法定位时用截图坐标。

### 4.4 分页机制

**根评论分页**：
- 每页 10 条
- 滚动评论区域到底部触发加载下一页
- API 响应中 `data.downContinueFlag`：`1` = 有更多，`0` = 已加载全部
- API 响应中 `data.lastBuff`：分页游标，自动传入下次请求

**子回复分页**：
- 初始加载前 3 条子回复
- 点击「展开更多回复」按钮加载下一批（约 10 条/次）
- 根评论对象中 `downContinueFlag`：`1` = 有更多，`0` = 已加载全部
- 按钮消失表示该根评论的所有子回复已加载完毕

### 4.5 去重逻辑

- 维护已收集评论 ID 的 Set
- 根评论通过 `commentId` 去重
- 子回复同样通过 `commentId` 去重
- 子回复通过所属根评论的 `commentId` 关联
- 每次 `read_network_requests` 返回的响应中，合并评论数据时过滤已存在的 ID

---

## 五、实测数据汇总

### 5.1 账号信息

| 项目 | 值 |
|------|-----|
| 账号名 | io流 |
| 视频号 ID | xpr1a59WjukATDfQr |
| 视频数 | 2 |
| 关注者数 | 5 |

### 5.2 视频列表

| 视频标题 | exportId | 创建时间 | 评论数 | 点赞 | 播放 | 转发 | 收藏 |
|---------|----------|---------|-------|------|------|------|------|
| 生活life | `export/UzFfBgAAxOCnAFZ1PhfKjMzT4DCaRGhu6DEw9FyhgBavBgX-rw` | 2026/06/13 08:41 | 21 | 0 | 25 | 0 | 0 |
| 德瓦达 | `export/UzFfBgAAxNGhNBNHFw_vjMzT4DCaEaEJczQJgMiJs56loh2HDQ` | 2026/05/15 16:10 | 23 | 5 | 685 | 11 | 6 |

### 5.3 评论树统计

**视频「生活life」（21条评论）**：
- 根评论：21 条（全部加载完成，通过滚动评论区域触发分页）
- 子回复：0 条（所有根评论均无子回复）
- API 响应 `downContinueFlag`: 0（无更多根评论）

**视频「德瓦达」（23条评论）**：
- 根评论：1 条（"哈哈哈哈"）
- 子回复：22 条（通过多次点击「展开更多回复」按钮全部加载完成）
- API 响应 `downContinueFlag`: 0（无更多根评论）
- 子回复 `downContinueFlag`: 0（无更多子回复，按钮消失）

---

## 六、与指导文件的差异分析

| 指导文件预期 | 实际发现 | 影响 |
|-------------|---------|------|
| 子回复通过独立的 `subCommentList` API 加载 | **子回复也通过 `comment_list` 端点加载**（无独立 API） | 简化了 API 对接，只需监听一个端点 |
| 通过注入 fetch/XHR 拦截器捕获 API 响应 | **使用 `read_network_requests` 工具直接捕获**（CDP 网络层） | 无需注入任何脚本，更安全且可捕获微前端内部请求 |
| iframe 内部发出请求，主页面拦截不到 | 请求确实从 wujie 微前端上下文发出 | CDP 网络层不受此限制，可捕获所有请求 |
| `exportId` 作为视频标识 | 确认 `exportId` 和 `objectId` 值相同，可互换使用 | 无影响 |
| `commentCount` 包含子回复 | 确认 commentCount = 根评论数 + 所有子回复数 | 需注意 commentCount 不是根评论数 |
| 页面通过 iframe 加载子应用 | 实际通过 **shadow DOM** 直接渲染，无 iframe | 使用 `read_page` / `find` 读取页面内容即可 |
| 菜单展开用 `display: none` → `display: ""` | 确认一致：折叠时 `style="display: none;"`，展开时 style 属性移除 | 无影响 |
| `lastBuff` 作为分页游标 | 确认一致，根评论和子回复都使用 `lastBuff` | 无影响 |
| `downContinueFlag` 标识是否有更多 | 确认一致，但值为 **数字**（1/0）而非布尔值 | 判断条件为 `=== 1` 而非 `=== true` |

---

## 七、风控与注意事项

1. **埋点请求极多**：`hepler_merlin_mmdata` 请求非常频繁（每次操作触发 10+ 次），使用 `read_network_requests` 时应通过 `urlPattern` 过滤掉
2. **操作间隔**：建议每次点击/滚动操作后等待 2-3 秒（`computer` wait），避免触发频率限制
3. **SPA 导航**：必须通过菜单点击（`find` + `computer` click）进行页面切换，不要使用 `browser.navigate()` 直接跳转 URL
4. **验证码检测**：未在本次测试中触发，但应在生产环境中通过 `screenshot` 定期检查是否出现验证码弹窗或「操作过于频繁」提示
5. **网络请求清除**：每次调用 `read_network_requests` 后建议使用 `clear: true`，防止重复处理已读请求
6. **评论区域滚动**：评论列表在右侧内容区域内，滚动时需将鼠标定位在评论详情区域（约 x=1200, y=600），而非页面全局滚动
7. **展开按钮循环**：「展开更多回复」按钮可能在加载完成后消失，使用 `find("展开更多回复")` 返回空即可判断所有子回复加载完毕
