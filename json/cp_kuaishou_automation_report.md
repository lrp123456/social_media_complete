# 快手创作者平台 (cp.kuaishou.com) 自动化抓取调研报告

> 调研日期: 2026-06-05 | 平台版本: buildId `93656870` | 框架: React SPA

---

## 一、菜单结构与路由映射

### 1.1 左侧菜单层级

| 一级菜单 | 二级菜单 | SPA 路由 (URL Path) | 菜单选择器文本 |
|---------|---------|---------------------|--------------|
| 首页 | (无) | `/profile` | `menuitem "首页"` |
| 内容管理 | 作品管理 | `/article/manage/video` | `menuitem "作品管理"` |
| 内容管理 | 合集管理 | `/article/manage/collection` | `menuitem "合集管理"` |
| 互动管理 | 评论管理 | `/article/comment` | `menuitem "评论管理"` |
| 数据中心 | 数据概览 | `/statistics/works` | `menuitem "数据概览"` |
| 数据中心 | 作品分析 | `/statistics/article` | `menuitem "作品分析"` |
| 数据中心 | 直播数据 | `/statistics/live` (推测) | `menuitem "直播数据"` |
| 数据中心 | 粉丝分析 | `/statistics/user/fans` | `menuitem "粉丝分析"` |
| 成长中心 | (未展开) | — | `menuitem "成长中心"` |
| 创作服务 | (未展开) | — | `menuitem "创作服务"` |
| 其他服务 | (未展开) | — | `menuitem "其他服务"` |

### 1.2 导航方式

菜单交互为**点击展开+点击跳转**模式：
1. 点击一级菜单项 → 展开/折叠子菜单（不跳转页面）
2. 点击二级菜单项 → SPA 路由切换，触发 XHR/Fetch 数据加载
3. URL 通过 `history.pushState` 变更，不会整页刷新

**自动化导航流程**：
```javascript
// 1. 点击展开一级菜单
click menuitem "内容管理"   // 展开子菜单

// 2. 获取新快照后点击二级菜单
snapshot -i
click menuitem "作品管理"   // 跳转到 /article/manage/video

// 3. 等待网络空闲
wait --load networkidle
```

---

## 二、各页面 API 详解

### 2.1 首页 (Profile) — `/profile`

#### 视频列表 API

| 属性 | 值 |
|------|---|
| **URL** | `GET https://cp.kuaishou.com/rest/cp/creator/analysis/pc/home/photo/list` |
| **鉴权** | Cookie/Session，**无需 `__NS_sig3`** |
| **分页方式** | page-based（`page` + `pageSize`） |
| **totalCount 路径** | `data.photoList.totalCount` |
| **数据列表路径** | `data.photoList.photoItems[]` |

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | int | 是 | 页码，从 1 开始 |
| `pageSize` | int | 是 | 每页条数，建议 20 |

**响应字段映射**（`photoItems[]` 中每个元素）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `photoId` | string | 视频唯一标识 |
| `title` | string | 标题（含话题 #tag） |
| `cover` | string | 封面图 CDN URL |
| `playUrl` | string | 视频 MP4 播放地址 |
| `duration` | int | 时长（毫秒） |
| `publishTime` | int | 发布时间（毫秒 Unix 时间戳） |
| `playCount` | int | 播放量 |
| `likeCount` | int | 点赞量 |
| `commentCount` | int | 评论量 |
| `collectCount` | int | 收藏量 |
| `followCount` | int | 涨粉量 |
| `fpr` | float | 完播率 (0.0–1.0) |
| `video` | bool | `true`=视频, `false`=图文 |
| `photoStatusTags` | array | 作品状态标签 |
| `promotionDesc` | string/null | 推广描述 |
| `negativeDesc` | string/null | 负反馈描述 |
| `bonusDesc` | string/null | 奖励描述 |

**完整响应 JSON 结构**：
```json
{
  "result": 1,
  "currentTime": 1780658424985,
  "host-name": "public-bjx-...kwaidc.com",
  "data": {
    "photoList": {
      "totalCount": 21,
      "photoItems": [ { ... } ]
    }
  }
}
```

#### Profile 页面其他并行 API

| API 路径 | 用途 |
|----------|------|
| `/rest/cp/creator/pc/home/userInfo` | 用户基本信息 |
| `/rest/cp/creator/pc/home/infoV2` | 主页信息 V2 |
| `/rest/cp/creator/analysis/pc/home/author/overview` | 创作者数据概览 |
| `/rest/cp/creator/pc/home/commentList` | 主页评论列表（Profile 页嵌入使用） |
| `/rest/cp/creator/pc/home/income` | 收入信息 |
| `/rest/cp/creator/analysis/export/task/list` | 导出任务列表 |
| `/rest/cp/works/v2/collection/tab` | 合集信息 |
| `/rest/v2/creator/pc/authority/account/current` | 当前账号权限 |

---

### 2.2 作品管理 — `/article/manage/video`

| 属性 | 值 |
|------|---|
| **URL** | `GET https://cp.kuaishou.com/rest/cp/works/v2/video/pc/photo/list` |
| **鉴权** | 需要 `__NS_sig3` 签名参数 |
| **分页方式** | 待确认（页面含搜索和日期过滤） |

页面功能：
- Tab：全部作品 / 已发布 / 待发布 / 未通过
- 过滤器：开始日期、结束日期、搜索关键词输入框
- 每行展示：视频时长 + 标题
- 与 Profile 页 API 不同，是独立的内容管理接口

---

### 2.3 合集管理 — `/article/manage/collection`

| API | 说明 |
|-----|------|
| `GET /rest/cp/works/v2/collection/tab` | 合集 Tab 信息 |
| `GET /rest/cp/works/v2/collection/list` | 合集列表 |

页面功能：我的合集标签页、创建合集按钮。该账号当前无合集。

---

### 2.4 评论管理 — `/article/comment`

| API | 说明 |
|-----|------|
| `GET /rest/cp/creator/comment/home` | 评论管理首页数据 |
| `GET /rest/cp/creator/comment/commentList` | 评论列表（分页） |
| `GET /rest/cp/creator/comment/commentSwitch` | 评论开关配置 |

**鉴权**：所有评论 API 均需要 `__NS_sig3` 签名参数。

**页面功能**：
- "选择视频" 按钮 → 按视频筛选评论
- Tab：全部评论
- 排序下拉框
- 每条评论操作：回复 / 删除 / 举报 / 置顶
- 评论与视频的关联：通过选择视频按钮确定 `photoId`，API 请求中携带该参数

**注意**：`__NS_sig3` 签名参数由前端框架自动注入，直接调用时需从页面已发出的请求中提取有效 sig3 值。sig3 有时效性，过期需刷新页面重新获取。

---

### 2.5 数据中心 — 数据概览 — `/statistics/works`

| API | 说明 |
|-----|------|
| `GET /rest/cp/creator/analysis/pc/author/overview` | 创作者数据总览 |
| `GET /rest/cp/creator/analysis/pc/author/traffic/source` | 流量来源分布 |
| `GET /rest/cp/creator/analysis/pc/author/diagnose/overview` | 诊断概览 |

页面功能：近7/30/90天切换、导出数据、播放/点赞/粉丝/完播率/评论/分享等指标卡片、流量来源饼图。

---

### 2.6 数据中心 — 作品分析 — `/statistics/article`

| API | 说明 |
|-----|------|
| `GET /rest/cp/creator/analysis/pc/photo/list` | 作品分析列表（与 Profile 页同一接口） |
| `GET /rest/cp/creator/analysis/pc/photo/type` | 作品类型筛选 |

**重要发现**：此页面的 `photo/list` API 与 Profile 页面的 `home/photo/list` **使用同一后端接口路径**，参数和响应结构完全一致，**无需 `__NS_sig3`**。实测 totalCount=21。

页面功能：按时间/播放/点赞/评论排序、公开作品筛选、导出数据、分页。

---

## 三、`__NS_sig3` 签名规则总结

| API 分组 | 是否需要 sig3 | 说明 |
|----------|:---:|------|
| Profile 页视频列表 `home/photo/list` | 否 | 直接传参即可 |
| 作品分析 `analysis/pc/photo/list` | 否 | 同 Profile 页 |
| 作品管理 `works/v2/video/pc/photo/list` | 是 | 内容管理模块 |
| 评论管理 `creator/comment/*` | 是 | 互动管理模块 |
| 通用辅助接口 (`authority/account/current` 等) | 是 | app 初始化时调用 |

**获取 sig3 策略**：在自动化程序中，可从页面首次加载的 Performance API 或 XHR 拦截中提取有效 sig3。由于 sig3 有时效性，建议每次启动新会话时刷新获取。

---

## 四、自动化程序完整流程建议

### 4.1 从登录到获取最新 N 个视频

```
1. 登录
   → 打开 https://cp.kuaishou.com/profile
   → 若重定向到 passport.kuaishou.com 则需要登录
   → 登录后回调链: passport → /rest/infra/sts → /profile

2. 获取视频总数
   GET /rest/cp/creator/analysis/pc/home/photo/list?page=1&pageSize=1
   → 提取 data.photoList.totalCount = N

3. 计算分页参数
   totalPages = ceil(N / 20)   // 建议 pageSize=20
   targetPages = min(totalPages, ceil(目标数量 / 20))

4. 逐页获取
   for page in 1..targetPages:
     GET /rest/cp/creator/analysis/pc/home/photo/list?page={page}&pageSize=20
     → 合并 data.photoList.photoItems

5. 去重排序
   按 photoId 去重，按 publishTime 降序排列
```

### 4.2 获取评论数据

```
1. 进入评论管理页
   → 点击 "互动管理" → 点击 "评论管理"
   → URL: /article/comment

2. 获取 sig3（从页面已发出的 XHR 中提取）
   → 拦截 /rest/cp/creator/comment/home 请求获取 __NS_sig3

3. 调用评论列表
   GET /rest/cp/creator/comment/commentList?page=1&pageSize=20&__NS_sig3=xxx
   （可能还需 photoId 参数按视频筛选）

4. 分页获取全部评论
```

### 4.3 关键技术要点

| 要点 | 说明 |
|------|------|
| 鉴权维持 | Cookie/Session 有效期约数小时，过期需重新登录 |
| CDN URL 时效性 | `playUrl` 和 `cover` 带临时签名，有有效期限制 |
| 时间戳处理 | `publishTime` 为毫秒级 Unix 时间戳 |
| 完播率 | `fpr` 为 0.0–1.0 小数，乘 100 得百分比 |
| sig3 处理 | 优先使用无需 sig3 的 Profile 页 API；需要时从页面提取 |
| 并发控制 | 建议每页请求间隔 200-500ms，避免触发频率限制 |
| SPA 路由 | `history.pushState` 模式，不刷新页面 |

---

## 五、全部 API 端点汇总

### 视频/作品相关
| API | 方法 | 鉴权 |
|-----|------|:---:|
| `/rest/cp/creator/analysis/pc/home/photo/list` | GET | Cookie |
| `/rest/cp/works/v2/video/pc/photo/list` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/pc/photo/list` | GET | Cookie |
| `/rest/cp/creator/analysis/pc/photo/type` | GET | Cookie |

### 评论相关
| API | 方法 | 鉴权 |
|-----|------|:---:|
| `/rest/cp/creator/comment/home` | GET | Cookie+sig3 |
| `/rest/cp/creator/comment/commentList` | GET | Cookie+sig3 |
| `/rest/cp/creator/comment/commentSwitch` | GET | Cookie+sig3 |
| `/rest/cp/creator/comment/report/menu` | GET | Cookie+sig3 |

### 创作者数据
| API | 方法 | 鉴权 |
|-----|------|:---:|
| `/rest/cp/creator/pc/home/userInfo` | GET | Cookie+sig3 |
| `/rest/cp/creator/pc/home/infoV2` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/pc/home/author/overview` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/pc/author/overview` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/pc/author/traffic/source` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/pc/author/diagnose/overview` | GET | Cookie+sig3 |
| `/rest/cp/creator/pc/home/income` | GET | Cookie+sig3 |
| `/rest/cp/creator/analysis/export/task/list` | GET | Cookie+sig3 |

### 合集/作品管理
| API | 方法 | 鉴权 |
|-----|------|:---:|
| `/rest/cp/works/v2/collection/tab` | GET | Cookie+sig3 |
| `/rest/cp/works/v2/collection/list` | GET | Cookie+sig3 |
| `/rest/cp/works/v2/common/pc/current/user` | GET | Cookie+sig3 |

### 通用/系统
| API | 方法 | 鉴权 |
|-----|------|:---:|
| `/rest/v2/creator/pc/authority/account/current` | GET | Cookie+sig3 |
| `/rest/v2/creator/pc/frontend/kswitch/config` | GET | Cookie+sig3 |
| `/rest/v2/creator/pc/notification/unReadCountV3` | GET | Cookie+sig3 |
| `/rest/v2/creator/pc/popup/list` | GET | Cookie+sig3 |
| `/rest/v2/creator/pc/satisfy/list` | GET | Cookie+sig3 |
