# 抖音创作者中心 (creator.douyin.com) 自动化抓取技术调研报告

> 调研日期: 2026-06-05 | 平台: Windows 11 | 浏览器: Chrome 148

---

## 一、菜单结构与页面导航

### 1.1 完整菜单树

| 一级菜单 | 二级菜单 | 页面路由 | 备注 |
|---------|---------|---------|------|
| **首页** | - | `/creator-micro/home` | 数据总览+创作灵感 |
| **活动管理** | - | (iframe) | goofy子应用 |
| **内容管理** | 作品管理 | `/creator-micro/content/manage` | 核心页面 |
| | 合集管理 | `/creator-micro/content/collection/manage` | |
| | 共创中心 | `/creator-micro/content/cooperate_center` | |
| | 原创保护中心 | `/creator-micro/content/original_protection` | |
| **互动管理** | 关注管理 | (iframe) | goofy子应用 |
| | 粉丝管理 | (iframe) | goofy子应用 |
| | **评论管理** | `/creator-micro/interactive/comment` | 选择作品查看评论 |
| | 弹幕管理 | (iframe) | goofy子应用 |
| | 私信管理 | (iframe) | goofy子应用 |
| **数据中心** | 账号总览 | (iframe) | goofy子应用 |
| | **作品分析** | `/creator-micro/data-center/content` | 投稿分析/投稿列表 |
| | 粉丝分析 | (iframe) | goofy子应用 |
| | 重点关心 | (iframe) | goofy子应用 |
| **变现中心** | 变现广场 | (iframe) | goofy子应用 |
| | 我的任务 | (iframe) | goofy子应用 |
| | 我的收入 | (iframe) | goofy子应用 |
| **创作中心** | 创作灵感 | (iframe) | goofy子应用 |
| | 学习中心 | (iframe) | goofy子应用 |
| | 抖音指数 | (iframe) | goofy子应用 |

### 1.2 自动化点击路径

页面左侧菜单使用 menuitem 元素，需先展开一级菜单再点击二级菜单：

```
# agent-browser 命令序列
open https://creator.douyin.com/creator-micro/home

# 内容管理 -> 作品管理
click @e4    # 展开"内容管理"
click @e5    # 进入"作品管理"

# 互动管理 -> 评论管理
click @e9    # 展开"互动管理"
click @e12   # 进入"评论管理"

# 数据中心 -> 作品分析
click @e15   # 展开"数据中心"
click @e17   # 进入"作品分析"
```

### 1.3 页面元素特征

**作品管理页 (content/manage)**:
- 搜索框: textbox "搜索作品"
- 标签筛选: "全部作品" | "已发布" | "审核中" | "未通过"
- 作品卡片含: 缩略图、标题、日期、播放/点赞/评论/分享数
- 操作: 编辑作品、设置权限、删除作品

**作品分析页 (data-center/content)**:
- Tab: "投稿作品" "直播场次"
- Radio: "投稿分析" "投稿列表"
- 日期选择器 + 导出数据按钮
- 指标: 投稿量、点击率、5s完播率、2s跳出率、播放时长、点赞/评论量等

---

## 二、API 清单

### 2.1 核心 API 总览

| API 路径 | 方法 | Cookie | 签名必须 | 用途 |
|---------|------|--------|---------|------|
| `/web/api/creator/item/list` | GET | 是 | **否** | 作品列表 |
| `/aweme/v1/creator/pc/user/info/` | GET | 是 | 否 | PC用户信息 |
| `/aweme/v1/creator/user/info/` | GET | 是 | 否 | 创作者信息 |
| `/web/api/media/user/info/` | GET | 是 | 否 | 媒体用户信息 |
| `/aweme/v1/creator/notice/comment/` | GET | 是 | 否 | 评论通知 |
| `/aweme/v1/creator/user_message/notice/` | GET | 是 | 否 | 消息通知 |
| `/aweme/v1/creator/user_message/unread_count/` | GET | 是 | 否 | 未读数 |
| `/aweme/v1/creator/msg/top` | GET | 是 | 否 | 置顶消息 |
| `/web/api/media/anchor/search` | GET | 是 | CSRF | 锚点搜索 |
| `/web/api/v1/im/token/` | GET | 是 | 否 | IM Token |
| `/passport/token/beat/web` | GET | 是 | 否 | Token心跳 |
| `/aweme/v1/web/oversea/judgment/` | GET | 是 | 否 | 海外判断 |

### 2.2 作品列表 API (核心)

**URL**: `GET https://creator.douyin.com/web/api/creator/item/list`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `count` | int | 是 | 每页条数(建议20) |
| `fields` | string | 推荐 | 逗号分隔字段列表 |
| `cursor` | int64 | 否 | 分页游标，首次不传 |
| `status_list[]` | string | 否 | PUBLISHED/AUDITING/FAILED |
| `start_time` | int64 | 否 | 起始时间戳(毫秒) |
| `end_time` | int64 | 否 | 结束时间戳(毫秒) |
| `msToken` | string | 否 | 签名token(可省略) |
| `a_bogus` | string | 否 | 反爬签名(可省略) |

**推荐 fields 值**:
```
id,type,user_id,create_time,description,cover,metrics,visibility,review,video_info,collaborative,downloadable
```

**响应 JSON 结构**:
```json
{
  "status_code": 0,
  "status_msg": "",
  "BaseResp": { "StatusMessage": "success" },
  "total": 5,
  "has_more": true,
  "max_cursor": 1700000000000,
  "min_cursor": 1750000000000,
  "items": [
    {
      "id": 7636302453062782000,
      "type": 2,
      "user_id": "...",
      "create_time": 1746388800,
      "description": "...",
      "cover": {
        "uri": "tos-cn-...",
        "url_list": ["https://p3.douyinpic.com/..."]
      },
      "video_info": { "duration": 26, "is_vr": false },
      "visibility": { "close_friend": 0, "part_see": 0, "status": 3 },
      "review": { "status": 2 },
      "metrics": {
        "view_count": "1234",
        "like_count": "56",
        "comment_count": "3",
        "share_count": "2",
        "favorite_count": "10",
        "download_count": "0",
        "dislike_count": "0",
        "danmaku_count": "0",
        "avg_view_proportion": "0.351714",
        "avg_view_second": "9.000000",
        "completion_rate": "0.000000",
        "completion_rate_5s": "1.000000",
        "bounce_rate_2s": "0.000000",
        "fan_view_proportion": "0.000000",
        "homepage_visit_count": "0",
        "like_rate": "", "comment_rate": "", "share_rate": "",
        "favorite_rate": "", "dislike_rate": "",
        "subscribe_count": "0", "unsubscribe_count": "0"
      }
    }
  ]
}
```

### 2.3 字段映射速查

| 业务含义 | JSON路径 | 类型 |
|---------|---------|------|
| 作品ID | `item.id` | int64 |
| 类型(1图文/2视频) | `item.type` | int |
| 发布时间 | `item.create_time` | Unix秒 |
| 描述 | `item.description` | string |
| 封面图 | `item.cover.url_list[]` | string[] |
| 视频时长 | `item.video_info.duration` | int(秒) |
| 可见性 | `item.visibility.status` | 1公开/2好友/3私密 |
| 播放量 | `item.metrics.view_count` | string |
| 点赞数 | `item.metrics.like_count` | string |
| 评论数 | `item.metrics.comment_count` | string |
| 分享数 | `item.metrics.share_count` | string |
| 收藏数 | `item.metrics.favorite_count` | string |
| 平均观看比例 | `item.metrics.avg_view_proportion` | string |
| 平均观看时长 | `item.metrics.avg_view_second` | string(秒) |
| 完播率 | `item.metrics.completion_rate` | string |
| 5s完播率 | `item.metrics.completion_rate_5s` | string |
| 2s跳出率 | `item.metrics.bounce_rate_2s` | string |
| 粉丝观看占比 | `item.metrics.fan_view_proportion` | string |
| 主页访问 | `item.metrics.homepage_visit_count` | string |

### 2.4 分页方式

**游标分页 (Cursor-based)**:

```
首次: GET ...?count=20 -> { total, has_more, max_cursor, min_cursor, items }
翻页: GET ...?count=20&cursor={max_cursor} -> 下一页数据
```

- `total`: 作品总数
- `has_more`: 是否还有更多
- `max_cursor` / `min_cursor`: 翻页游标(int64毫秒时间戳)

### 2.5 评论 API

**评论通知**: `GET /aweme/v1/creator/notice/comment/?aid=2906&app_name=aweme_creator_platform&device_platform=web`

响应:
```json
{
  "comments": [],
  "extra": { "now": 1780662557000 },
  "status_code": 0,
  "status_msg": ""
}
```

**按作品获取评论**: 需在评论管理页选择作品后触发，精确API端点待补充。

---

## 三、鉴权方式

### 3.1 Cookie 列表

| Cookie | 作用 |
|--------|------|
| `passport_csrf_token` | 登录态CSRF Token |
| `passport_csrf_token_default` | 默认CSRF Token |
| `passport_assist_user` | 辅助用户标识 |
| `csrf_session_id` | Session ID |
| `bd_ticket_guard_client_data` | 客户端票据 |
| `x-web-secsdk-uid` | 安全SDK UID |
| `__security_mc_1_s_sdk_crypt_sdk` | SDK加密Key |

### 3.2 签名参数验证结论

| 结论 | API |
|------|-----|
| **无需签名** | `/web/api/creator/item/list` |
| **无需签名** | `/aweme/v1/creator/notice/comment/` |
| **无需签名** | `/aweme/v1/creator/pc/user/info/` |
| **需要CSRF** | `/web/api/media/anchor/search` |

> **关键发现**: msToken 和 a_bogus 在所有XHR请求中出现，但实测可省略。同源Cookie请求即可正常调用绝大多数API。

### 3.3 CSRF保护

仅 `/web/api/media/anchor/search` 注册了CSRF保护：
```javascript
secsdk.csrf.setProtectedHost({
  TOKEN_PATH: "/web/api/media/anchor/search",
  GET: "*"
})
```

---

## 四、自动化抓取方案

### 4.1 抓取最新N个视频 (Python)

```python
import requests, time

COOKIES = {"passport_csrf_token": "YOUR_TOKEN", ...}

def fetch_items(count=20, cursor=None):
    resp = requests.get(
        "https://creator.douyin.com/web/api/creator/item/list",
        params={
            "count": count,
            "cursor": cursor,
            "fields": "id,type,create_time,description,cover,metrics,visibility,review,video_info"
        },
        cookies=COOKIES,
        headers={"Referer": "https://creator.douyin.com/"}
    )
    return resp.json()

def fetch_all(max_items=100):
    items, cursor = [], None
    while len(items) < max_items:
        data = fetch_items(min(20, max_items - len(items)), cursor)
        if data["status_code"] != 0: break
        items.extend(data.get("items", []))
        if not data.get("has_more"): break
        cursor = data.get("max_cursor")
        time.sleep(0.5)
    return items[:max_items]
```

### 4.2 评论获取方案

1. 通过 `item/list` 获取所有作品ID
2. 进入 `/creator-micro/interactive/comment` 选择作品触发评论API
3. 抓包获取按作品评论的精确API端点
4. 对每个作品分页拉取评论

### 4.3 反爬建议

- 请求间隔 >= 500ms
- 使用真实浏览器 User-Agent
- Referer 设为 `https://creator.douyin.com/`
- Cookie过期需重新登录

---

## 五、技术架构

| 组件 | 技术 |
|------|------|
| 前端 | React 17 + Semi Design |
| 微前端 | systemjs + Module Federation |
| HTTP | axios |
| 安全 | bytegoofy secsdk |
| CDN | lf-fe-creator.douyinstatic.com |
| 监控 | Slardar APM |
| 路由 | Hash Router + History API |

### 架构示意

```
creator.douyin.com
|-- 左侧菜单 (React)  |-- 主内容区 (SPA)
|                      |   |-- /creator-micro/*  (子路由页面)
|                      |   |-- iframe (goofy子应用: 直播/收益等)
|-- API Layer: /web/api/creator/* + /aweme/v1/creator/*
```

---

## 六、总结

1. 作品列表 `/web/api/creator/item/list` 是核心入口，游标分页，返回25+指标
2. **msToken/a_bogus 非必须** - 同源Cookie即可调用绝大多数API
3. 鉴权完全基于Cookie会话，无需额外Token Header
4. 评论API `/aweme/v1/creator/notice/comment/` 获取通知，按作品评论需进入管理页触发
5. 20个菜单项覆盖内容/互动/数据/变现/创作全功能
6. 7个一级菜单含19个二级菜单，约半数通过iframe加载独立子应用
