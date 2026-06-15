# 视频号创作者平台 API 调研报告

> 调研时间：2026-06-11
> 调研环境：https://channels.weixin.qq.com/platform（已登录状态）

---

## 1. 登录流程

| 项目 | 调研结果 |
|------|---------|
| 登录页 URL | `https://channels.weixin.qq.com/login.html`（代码中定义，未实际观察到重定向） |
| 登录后 URL | `https://channels.weixin.qq.com/platform` |
| 登录方式 | 微信扫码登录（iframe 内嵌二维码） |
| 二维码 iframe src | 未实际观察到（已登录状态，未触发登录页） |
| 登录成功标志 | URL 包含 `/platform` 且不包含 `/login` |
| 关键 Cookie | `sessionid`、`wxuin`、`_qimei_uuid42`、`_qimei_fingerprint`、`_gcl_au`、`RK`、`ptcz`、`pac_uid`、`omgid` |

**说明**：已登录状态下访问 `/platform` 不会重定向到 `/login`，而是直接展示控制台首页。登录状态通过 Cookie（特别是 `sessionid`）维持。

---

## 2. 视频列表 API

### 基本信息

| 项目 | 值 |
|------|-----|
| 完整路径 | `/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list` |
| 请求方法 | POST |
| Content-Type | `application/json` |
| 认证方式 | Cookie（`sessionid`） |
| 状态码 | 201 |

### 请求参数

```json
{
  "pageSize": 10,
  "currentPage": 1
}
```

可选参数：`userpageType`（区分视频/图文类型）、`stickyOrder`

### 响应结构（实际返回）

```json
{
  "errCode": 0,
  "errMsg": "request successful",
  "data": {
    "list": [
      {
        "commentList": [],
        "objectId": "export/UzFfBgAAxNGhNBNHFw_vjMzT4DCaEaEJczQJgMiJs56loh2HDQ",
        "createTime": 1778832620,
        "likeCount": 5,
        "commentCount": 12,
        "readCount": 682,
        "forwardCount": 11,
        "favCount": 6,
        "commentClose": 0,
        "visibleType": 1,
        "status": 1,
        "desc": {
          "media": [
            {
              "spec": [],
              "url": "https://finder.video.qq.com/...",
              "thumbUrl": "https://finder.video.qq.com/...",
              "mediaType": 4,
              "videoPlayLen": 13,
              "width": 552,
              "height": 832,
              "md5sum": "7da54a601875d0d61c4a26b438b248e9",
              "fileSize": "5282577",
              "bitrate": 3241984,
              "coverUrl": "https://finder.video.qq.com/...",
              "fullThumbUrl": "",
              "fullUrl": "",
              "fullWidth": 0,
              "fullHeight": 0,
              "fullMd5sum": "",
              "fullFileSize": "0",
              "fullBitrate": 0,
              "halfRect": {},
              "fullCoverUrl": "https://finder.video.qq.com/...",
              "cardShowStyle": 0,
              "shareCoverUrl": "",
              "shareCoverShowStyle": 0
            }
          ],
          "mentionedMusics": [],
          "shortTitle": [],
          "description": "德瓦达",
          "mediaType": 4,
          "location": {
            "longitude": 117.30982971191406,
            "latitude": 39.71754837036133,
            "city": "天津市",
            "poiClassifyId": ""
          },
          "extReading": {},
          "topic": {},
          "feedLocation": {},
          "event": {
            "eventTopicId": "",
            "eventName": "",
            "eventCreatorNickname": "",
            "eventAttendCount": 0
          },
          "audio": {},
          "member": {},
          "finderNewlifeDesc": {},
          "modFeedInfo": {
            "history": [],
            "modifyButtonStatus": 2
          }
        },
        "objectType": 0,
        "flag": 64,
        "objectNonce": "16878550867249093036",
        "permissionFlag": 0,
        "canSetOriginalsoundTitle": true,
        "fullPlayRate": 0.21994134897360704,
        "avgPlayTimeSec": 8.45,
        "disableInfo": { "isDisabled": false },
        "showOriginal": false,
        "exportId": "export/UzFfBgAAxNGhNBNHFw_vjMzT4DCaEaEJczQJgMiJs56loh2HDQ",
        "ringsetCount": 0,
        "snscoverCount": 0,
        "statusrefCount": 0,
        "forwardAggregationCount": 11,
        "originalInfo": {
          "auditOriginalFlag": 0,
          "isDeclared": 0,
          "isOriginalUpgrad": 0
        },
        "followCount": 4,
        "fastFlipRate": 0.4024896265560166,
        "forwardSnsCount": 1,
        "forwardAllChatCount": 10,
        "argsInfo": { "poiCheckSum": "462f80830577c47dd9edeea54646de95" },
        "yesterdayReadCount": 0,
        "stickyOpStatus": 1
      }
    ],
    "bindInfo": [],
    "totalCount": 1,
    "lastBuff": "export/SzFfBgAAyV2ChWPH-RXa731TV02VKn60l1vpTyT9",
    "continueFlag": false
  }
}
```

### 关键发现（与预期差异）

| 字段 | 预期值 | 实际值 | 说明 |
|------|--------|--------|------|
| 视频 ID 字段名 | `export_id` | `exportId` 和 `objectId` | 两者相同，均为 `export/...` 格式 |
| 描述字段 | `desc`（字符串） | `desc.description`（嵌套在对象中） | `desc` 是对象，包含 media、location 等 |
| 播放量 | `play_count` | `readCount` | 字段名不同 |
| 点赞数 | `like_count` | `likeCount` | 驼峰命名 |
| 评论数 | `comment_count` | `commentCount` | 驼峰命名 |
| 分享数 | `share_count` | `forwardCount` | 字段名和命名风格都不同 |
| 推荐数 | `recommend_count` | `favCount` | 字段名不同 |
| 分页参数 | `offset/limit` | `currentPage/pageSize` | 分页方式不同 |
| 总数字段 | `total_count` | `data.totalCount` | 嵌套在 data 中 |
| 分页标志 | `has_more` | `data.continueFlag` + `data.lastBuff` | 使用 cursor 机制 |
| API 路径前缀 | `/mmfinderassistant-bin/` | `/micro/content/cgi-bin/mmfinderassistant-bin/` | 多了 `/micro/content/` 前缀 |

---

## 3. 评论列表 API

### 基本信息

| 项目 | 值 |
|------|-----|
| 完整路径 | `/micro/content/cgi-bin/mmfinderassistant-bin/comment/comment_list` |
| 请求方法 | POST |
| Content-Type | `application/json` |
| 状态码 | 200 |

### 请求参数

```json
{
  "exportId": "export/UzFfBgAAxNGhNBNHFw_vjMzT4DCaEaEJczQJgMiJs56loh2HDQ",
  "pageSize": 10,
  "currentPage": 1
}
```

### 响应结构（实际返回）

```json
{
  "errCode": 0,
  "errMsg": "request successful",
  "data": {
    "comment": [
      {
        "levelTwoComment": [
          {
            "levelTwoComment": [],
            "commentId": "14940694699710548560",
            "commentNickname": "io流",
            "commentContent": "666",
            "commentHeadurl": "https://wx.qlogo.cn/finderhead/...",
            "commentCreatetime": "1781069600",
            "commentLikeCount": 0,
            "replyCommentId": "14939408156260698322",
            "replyContent": "哈哈哈哈",
            "lastBuff": "",
            "downContinueFlag": 0,
            "visibleFlag": 0,
            "readFlag": true,
            "displayFlag": 131074,
            "username": "v2_060000231003b20faec8cae38a1bc1d6cf05e934b07767b58b5a89e8e288e33973cff2bc30ff@finder",
            "blacklistFlag": 0,
            "likeFlag": 0
          }
        ],
        "commentId": "14939408156260698322",
        "commentNickname": "io流",
        "commentContent": "哈哈哈哈",
        "commentHeadurl": "https://wx.qlogo.cn/finderhead/...",
        "commentCreatetime": "1780916232",
        "commentLikeCount": 0,
        "lastBuff": "",
        "downContinueFlag": 0,
        "visibleFlag": 0,
        "readFlag": true,
        "displayFlag": 131586,
        "username": "v2_060000231003b20faec8cae38a1bc1d6cf05e934b07767b58b5a89e8e288e33973cff2bc30ff@finder",
        "blacklistFlag": 0,
        "likeFlag": 0
      }
    ],
    "lastBuff": "AATVfYAEAAABAAAAAADkH4r+wlzeftrNmCMqaiAAAADz...",
    "commentCount": 12,
    "downContinueFlag": 0
  }
}
```

### 关键发现（与预期差异）

| 字段 | 预期值 | 实际值 | 说明 |
|------|--------|--------|------|
| 评论 ID | `comment_id` | `commentId` | 驼峰命名 |
| 评论内容 | `content` | `commentContent` | 字段名不同 |
| 昵称 | `nickname` | `commentNickname` | 字段名不同 |
| 头像 | `head_img_url` | `commentHeadurl` | 字段名不同 |
| 创建时间 | `create_time` | `commentCreatetime`（字符串） | 注意是字符串类型 |
| 点赞数 | `like_count` | `commentLikeCount` | 驼峰命名 |
| 回复数 | `reply_count` | 无直接字段 | 通过 `levelTwoComment` 数组长度推断 |
| 评论列表字段 | `list` | `comment` | 字段名完全不同 |
| 分页标志 | `has_more` | `downContinueFlag` + `lastBuff` | 使用 cursor 机制 |

---

## 4. 子回复 API

### 发现

评论列表 API (`comment_list`) 已经包含了子回复，嵌套在每条评论的 `levelTwoComment` 数组中。无需单独的子回复 API 调用。

**子回复结构**：
- 一级评论的 `levelTwoComment` 数组包含该评论的所有回复
- 子回复同样包含 `levelTwoComment` 数组（通常为空）
- 子回复包含 `replyCommentId` 和 `replyContent` 标识被回复的评论

**分页控制**：
- `downContinueFlag`：0 表示无更多回复，非 0 表示还有更多
- `lastBuff`：cursor 字符串，用于加载下一页

### 补充：如果需要单独加载子回复

源码中未发现独立的 `get_reply_list` API。子回复通过 `comment_list` 一次性返回。

---

## 5. 回复发送 API

### 基本信息

| 项目 | 值 |
|------|-----|
| 完整路径 | `/micro/content/cgi-bin/mmfinderassistant-bin/comment/create_comment` |
| 请求方法 | POST |
| Content-Type | `application/json` |

### 请求参数（从源码推断）

```json
{
  "exportId": "视频ID",
  "commentId": "父评论ID（回复评论时需要）",
  "content": "回复内容",
  "replyCommentId": "被回复的评论ID（可选）"
}
```

> 注：未实际发送回复请求，参数结构基于源码分析推断。

### 其他评论操作 API

| 操作 | 路径 | 说明 |
|------|------|------|
| 点赞评论 | `/comment/like_comment` | |
| 删除评论 | `/comment/del_comment` | |
| 置顶评论 | `/comment/set_top_comment` | |
| 更新评论标记 | `/comment/update_comment` | |
| 更新评论已读状态 | `/comment/update_feed_comment` | |
| 拉黑用户 | `/comment/block_user` | |

---

## 6. DOM 选择器验证

### 主应用层（主 DOM）

| 元素 | 预期选择器 | 实际选择器 | 状态 |
|------|-----------|-----------|------|
| 侧边栏容器 | `#side-bar` 或 `.finder-ui-desktop-menu__wrp` | `#side-bar` + `.finder-ui-desktop-menu__wrp` | ✅ 两者均有效 |
| 菜单项 | `getByText('span', '内容管理')` | `.finder-ui-desktop-menu__item` | ✅ 有效 |
| 子菜单项 | `.finder-ui-desktop-sub-menu__item` | `.finder-ui-desktop-sub-menu__item` | ✅ 有效 |
| wujie 容器 | `wujie-app` | `wujie-app.wujie_iframe` | ✅ 有效 |

### 子应用层（wujie shadow DOM 内）

| 元素 | 预期选择器 | 实际选择器 | 状态 |
|------|-----------|-----------|------|
| 评论页面容器 | `.comment-list-container` | `.main-body-wrap.comment-view.interaction-wrap.router-view` | ❌ 预期选择器无效 |
| 评论列表 | `.comment-list` | `.comment-item`（每个评论项） | ⚠️ 无统一容器，直接遍历 `.comment-item` |
| 评论用户昵称 | - | `.comment-user-name` | ✅ |
| 评论内容 | - | `.comment-content` | ✅ |
| 评论时间 | - | `.comment-time` | ✅ |
| 评论头像 | - | `.comment-avatar.finder-role` | ✅ |
| 回复按钮 | `getByText('button', '回复')` | `.action-item`（文本为"回复"，内含 `.action-icon.weui-icon-outlined-comment`） | ⚠️ 不是 button，是 div |
| 发送按钮 | `getByText('button', '发送')` | 未观察到（需要点击回复按钮后才出现） | ⚠️ 待验证 |
| 回复输入框 | `.reply-textarea` 或 `textarea[placeholder*='回复']` | 未观察到（需要点击回复按钮后才出现） | ⚠️ 待验证 |
| 视频列表容器 | - | `.feeds` / `.scroll-list__wrp.feeds-container` | ✅ |
| 视频卡片 | - | `.comment-feed-wrap` / `.comment-feed-wrap.inactive-feed` | ✅ |
| 视频标题 | - | `.feed-title` | ✅ |
| 视频缩略图 | - | `.feed-img` | ✅ |
| 评论数 | - | `.feed-comment-total` | ✅ |

### 侧边栏菜单结构

```
#side-bar
  └─ .finder-ui-desktop-menu__wrp
      ├─ .finder-ui-desktop-menu__item (首页)
      ├─ .finder-ui-desktop-menu__item (内容管理)
      │   └─ .finder-ui-desktop-sub-menu__item (视频/图文/音乐/音频/草稿箱/主页/活动)
      ├─ .finder-ui-desktop-menu__item (互动管理)
      │   └─ .finder-ui-desktop-sub-menu__item (评论/弹幕/私信)
      ├─ .finder-ui-desktop-menu__item (直播)
      ├─ .finder-ui-desktop-menu__item (收入与服务)
      ├─ .finder-ui-desktop-menu__item (数据中心)
      └─ .finder-ui-desktop-menu__item (设置)
```

---

## 7. wujie 微前端架构说明

视频号助手平台使用 **wujie** 微前端框架，关键特征：

1. **DOM 隔离**：子应用运行在 `<wujie-app class="wujie_iframe">` 的 shadow DOM 内
2. **API 路径前缀**：子应用的 API 请求带 `/micro/content/` 前缀
3. **JS 资源**：子应用的 JS 文件从 `res.wx.qq.com` CDN 加载
4. **Shadow DOM 穿透**：使用 Playwright/Puppeteer 时需要先进入 shadow root 再查询元素

---

## 8. 与现有代码的差异总结

### tencentCrawler.ts 需要修正的部分

| 项目 | 当前代码 | 实际值 | 修正建议 |
|------|---------|--------|---------|
| API 路径模式 | `/mmfinderassistant-bin/post/post_list` | `/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list` | 添加 `/micro/content` 前缀 |
| 评论 API 路径 | `/comment/get_comment_list` | `/comment/comment_list` | 去掉 `get_` 前缀 |
| 子回复 API | `/comment/get_reply_list` | 不存在独立 API | 子回复内嵌在 `comment_list` 的 `levelTwoComment` 中 |
| 视频 ID 字段 | `export_id` | `exportId` | 改为驼峰命名 |
| 描述字段 | `desc`（字符串） | `desc.description` | 从嵌套对象中提取 |
| 播放量 | `play_count` | `readCount` | 字段名不同 |
| 点赞数 | `like_count` | `likeCount` | 驼峰命名 |
| 评论数 | `comment_count` | `commentCount` | 驼峰命名 |
| 分享数 | `share_count` | `forwardCount` | 字段名不同 |
| 推荐数 | `recommend_count` | `favCount` | 字段名不同 |
| 分页参数 | `offset/limit` | `currentPage/pageSize` | 分页方式不同 |
| 评论 ID | `comment_id` | `commentId` | 驼峰命名 |
| 评论内容 | `content` | `commentContent` | 字段名不同 |
| 评论昵称 | `nickname` | `commentNickname` | 字段名不同 |
| 评论头像 | `head_img_url` | `commentHeadurl` | 字段名不同 |
| 评论时间 | `create_time` | `commentCreatetime`（字符串） | 字段名和类型都不同 |
| 评论列表字段 | `list` | `comment` | 字段名不同 |
| 回复数 | `reply_count` | 通过 `levelTwoComment.length` 计算 | 无直接字段 |
| 登录 URL | `login.html` | 未观察到实际重定向 | 需进一步验证 |

---

## 9. 完整 API 路径汇总

所有路径均基于 `https://channels.weixin.qq.com`。

### 主应用 API（无前缀）
- `POST /cgi-bin/mmfinderassistant-bin/helper/hepler_merlin_mmdata` - 性能监控
- `POST /cgi-bin/mmfinderassistant-bin/helper/helper_mmdata` - 数据上报
- `POST /cgi-bin/mmfinderassistant-bin/helper/helper_report` - 报告
- `POST /cgi-bin/mmfinderassistant-bin/helper/helper_upload_params` - 上传参数
- `POST /cgi-bin/mmfinderassistant-bin/notification/notification_list` - 通知列表
- `POST /cgi-bin/mmfinderassistant-bin/auth/get_auth_info` - 认证信息
- `POST /cgi-bin/mmfinderassistant-bin/auth/auth_data` - 认证数据
- `POST /cgi-bin/mmfinderassistant-bin/auth/list_talent_relation_by_bind_uin` - 达人关系
- `POST /cgi-bin/mmfinderassistant-bin/auth/mp_finder_window_init` - 初始化
- `POST /cgi-bin/mmfinderassistant-bin/active-auth/is-in-finder-whitelist` - 白名单
- `POST /cgi-bin/mmfinderassistant-bin/vip/get-user-member-service-status` - 会员状态
- `POST /cgi-bin/mmfinderassistant-bin/component/get_admin_bound_component_list` - 组件列表
- `POST /cgi-bin/mmfinderassistant-bin/shop/get_finder_ec_info_for_opening_page` - 电商信息
- `POST /cgi-bin/mmfinderassistant-bin/online_heartbeat` - 心跳

### 子应用 API（`/micro/content` 前缀）
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_list` - 视频列表
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_mcn_list` - MCN 视频列表
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_mega_list` - 大型列表
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_create` - 创建视频
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_delete` - 删除视频
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/post/get_post_info` - 视频详情
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/comment_list` - 评论列表
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/mcn_comment_list` - MCN 评论列表
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/feed_list` - 评论 Feed
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/create_comment` - 发送评论/回复
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/like_comment` - 点赞评论
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/del_comment` - 删除评论
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/update_comment` - 更新评论
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/update_feed_comment` - 更新 Feed 评论
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/set_top_comment` - 置顶评论
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/block_user` - 拉黑用户
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/comment/get_feed_detail` - Feed 详情
- `POST /micro/content/cgi-bin/mmfinderassistant-bin/collection/get_collection_list` - 合集列表

---

## 10. 查询参数说明

所有 API 请求都包含以下 URL 查询参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `_aid` | 应用 ID，每次会话固定 | `788aa51f-0439-475c-b32b-a8cb4c1d3d9a` |
| `_rid` | 请求 ID，每次请求唯一 | `6a2a20eb-d1f67bb1` |
| `_pageUrl` | 当前页面 URL（编码后） | `https:%2F%2Fchannels.weixin.qq.com%2Fmicro%2Fcontent%2Fpost%2Flist` |

---

## 11. 注意事项

1. **API 路径前缀**：子应用 API 必须带 `/micro/content` 前缀，否则会返回 300004 错误
2. **字段命名**：所有字段使用驼峰命名（camelCase），不是蛇形命名（snake_case）
3. **评论时间**：`commentCreatetime` 是字符串类型的时间戳，不是数字
4. **子回复内嵌**：子回复不需要单独 API 调用，已包含在 `comment_list` 响应的 `levelTwoComment` 数组中
5. **分页机制**：使用 `currentPage/pageSize` + `lastBuff/continueFlag` 组合分页
6. **wujie Shadow DOM**：页面元素在 shadow DOM 中，DOM 选择器需要穿透 shadow root
