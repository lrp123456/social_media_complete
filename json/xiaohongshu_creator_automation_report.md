# 小红书创作者中心自动化抓取调研报告

> 调研日期：2026-06-05
> 目标平台：creator.xiaohongshu.com
> 报告版本：v1.0


---

## 一、菜单结构与页面导航

### 1.1 侧边栏菜单结构

| 层级 | 菜单名称 | 路由路径 | CSS 选择器 |
|------|---------|---------|-----------|
| 一级 | 首页 | /new/home | .d-menu-item__title -> 首页 |
| 一级 | 笔记管理 | /new/note-manager | .d-menu-item__title -> 笔记管理 |
| 一级 | 数据看板 | /statistics/ | .d-menu-item__title -> 数据看板 |
| 二级 | 账号概览 | /statistics/account/v2 | .d-menu-horizontal-icon |
| 二级 | 内容分析 | /statistics/data-analysis | .d-menu-horizontal-icon |
| 二级 | 粉丝数据 | /statistics/fans-data | .d-menu-horizontal-icon |
| 一级 | 活动中心 | /new/events | .d-menu-item__title |
| 一级 | 笔记灵感 | /new/inspiration | .d-menu-item__title |
| 一级 | 创作学院 | /new/skill-hub | .d-menu-item__title |
| 一级 | 创作百科 | /creator/encyclopedia | .d-menu-item__title |

菜单组件特征：侧边栏使用 d-menu-item class，一级菜单文本在 .d-menu-item__title，二级菜单用 .d-menu-horizontal-icon；Vue Router SPA。

### 1.2 关键路由速查

| 路由 | 功能 |
|------|------|
| /new/home | 首页 Dashboard |
| /new/note-manager | 笔记管理 |
| /statistics/account/v2 | 账号概览 |
| /statistics/data-analysis | 内容分析 |
| /statistics/fans-data | 粉丝数据 |
| /statistics/note-detail | 笔记详情(?id=) |
| /new/events | 活动中心 |
| /new/inspiration | 笔记灵感 |


---

## 二、API 接口清单

### 2.1 笔记列表 API

| 项目 | 详情 |
|------|------|
| URL | https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted |
| 方法 | GET |
| 参数 | tab=0 (全部), page=0 (0-based) |

**响应结构**:

```json
{
  "code": 0, "success": true, "msg": "成功",
  "data": {
    "notes": [{
      "id": "6a05e65b00000000360194b5",
      "display_title": "自动发布测试",
      "type": "video",
      "view_count": 1,
      "likes": 0,
      "comments_count": 0,
      "collected_count": 0,
      "shared_count": 0,
      "images_list": [{"url": "..."}],
      "video_info": {"duration": 6},
      "xsec_token": "...",
      "xsec_source": "pc_creatormng"
    }]
  }
}
```

**字段映射**:

| 字段路径 | 含义 | 类型 |
|---------|------|------|
| data.notes[].id | 笔记唯一ID | string |
| data.notes[].display_title | 标题 | string |
| data.notes[].type | video/normal | string |
| data.notes[].view_count | 观看数 | int |
| data.notes[].likes | 点赞数 | int |
| data.notes[].comments_count | 评论数 | int |
| data.notes[].collected_count | 收藏数 | int |
| data.notes[].shared_count | 分享数 | int |
| data.notes[].permission_msg | 可见性描述 | string |
| data.notes[].images_list[].url | 封面图URL | string |
| data.notes[].video_info.duration | 视频时长(秒) | int |
| data.notes[].xsec_token | 安全令牌 | string |

**分页**: page 参数 0-based，返回数组长度 < 预期 page_size 即末页。

### 2.2 内容分析-笔记分析列表 API

| 项目 | 详情 |
|------|------|
| URL | https://creator.xiaohongshu.com/api/galaxy/creator/datacenter/note/analyze/list |
| 方法 | GET |
| 参数 | type=0 (0=全部/1=图文/2=视频), page_size=10, page_num=1 (1-based) |

**字段映射**:

| 字段路径 | 含义 | 类型 |
|---------|------|------|
| data.note_infos[].id | 笔记ID | string |
| data.note_infos[].title | 标题 | string |
| data.note_infos[].cover_url | 封面图 | string |
| data.note_infos[].type | 1=图文/2=视频 | int |
| data.note_infos[].read_count | 阅读数 | int |
| data.note_infos[].like_count | 点赞数 | int |
| data.note_infos[].comment_count | 评论数 | int |
| data.note_infos[].share_count | 分享数 | int |
| data.note_infos[].fav_count | 收藏数 | int |
| data.note_infos[].post_time | 发布时间(Unix ms) | int64 |
| data.note_infos[].audit_status | 审核状态(1=通过) | int |

**分页**: page_num(1-based) + page_size，note_infos 长度 < page_size 即末页。

### 2.3 账号概览 API

| API | URL | 方法 | 说明 |
|-----|-----|------|------|
| 观看时段 | /api/galaxy/v2/creator/datacenter/audience/view/periods | GET | 24小时分段数据 |
| 流量来源 | /api/galaxy/v2/creator/datacenter/audience/source/account | GET | 各渠道占比 |

### 2.4 粉丝数据 API

| API | URL | 方法 |
|-----|-----|------|
| 粉丝总览 | /api/galaxy/creator/data/fans/overall_new | GET |
| 活跃粉丝 | /api/galaxy/creator/data/active_fans_new | GET |

粉丝总览响应字段：data.seven.fans_count / rise_fans_count / leave_fans_count，含逐日涨粉/掉粉列表。

### 2.5 直播相关 API

| API | URL | 方法 | 参数 |
|-----|-----|------|------|
| 直播列表 | /api/galaxy/v2/creator/live_rooms | GET | start_time, end_time, page, page_size |
| 直播概览 | /api/galaxy/v2/creator/datacenter/livedata/overview | POST | - |

### 2.6 其他 API

| API | URL | 方法 | 说明 |
|-----|-----|------|------|
| 权限查询 | /api/galaxy/creator/datacenter/permission/query | GET | 数据看板权限状态 |
| 用户视频 | /api/galaxy/creator/user/video | GET | 用户视频数据 |



---

## 三、鉴权机制分析

### 3.1 Cookie 结构

| Cookie | 用途 | 必要性 |
|--------|------|--------|
| a1 | 用户身份认证令牌 | **必须** |
| webId | 设备/浏览器标识 | **必须** |
| websectiga | Web安全令牌(防CSRF) | **必须** |
| xsecappid | 应用标识(固定:ugc) | **必须** |
| gid | 全局用户标识 | 辅助 |
| sec_poison_id | 防投毒UUID | 辅助 |
| ets | 时间戳 | 辅助 |
| loadts | 加载时间戳 | 辅助 |

### 3.2 鉴权结论

1. **Cookie 驱动鉴权**: API 依赖浏览器自动携带 Cookie，a1+webId+websectiga 为必需
2. **无显式签名参数**: URL 中未发现 sign/timestamp/nonce 等签名参数
3. **xsec_token 机制**: 笔记数据携带 xsec_token + xsec_source(pc_creatormng)，用于敏感操作校验
4. **直接 fetch 失败**: 控制台 fetch() 返回 {code:-1,success:false}，说明存在额外请求头校验(Referer/自定义 Header)
5. **同域 API**: API 与前端同域(creator.xiaohongshu.com)，无跨域问题
6. **不可纯 API 调用**: 脱离浏览器环境的 HTTP 客户端无法工作，必须走 agent-browser 自动化

---

## 四、笔记详情页

| 项目 | 详情 |
|------|------|
| URL | https://creator.xiaohongshu.com/statistics/note-detail?id={note_id} |
| Tab | 笔记诊断 / 核心数据 / 观看来源 / 观众画像 |
| 限制 | 观看数 >= 100 才显示完整分析 |
| 数据源 | 复用 content-analysis API 的 note_infos 数组，无独立详情 API |

---

## 五、评论数据获取方案

创作者中心**无独立评论管理页面**（Vue Router 无评论路由）。评论数可从以下字段获取：

- 笔记列表 API: data.notes[].comments_count
- 内容分析 API: data.note_infos[].comment_count

如需获取评论内容，需通过主站接口(未验证):
```
GET /api/sns/web/v2/comment/page?note_id={note_id}&cursor={cursor}
```
注意：主站评论接口可能需要独立的 x-s/x-s-common 请求头签名。



---

## 六、自动化抓取流程

### 6.1 抓取最新N个笔记

```
1. agent-browser open "https://creator.xiaohongshu.com/new/home"
2. agent-browser wait --load networkidle
3. 如跳转到 /login: snapshot -i -C → fill 手机号 → fill 验证码 → click 登录
4. agent-browser open "https://creator.xiaohongshu.com/new/note-manager"
5. agent-browser wait --load networkidle
6. eval 注入 fetch/XHR 拦截器(存入 localStorage)
7. agent-browser wait 3000
8. eval "localStorage.getItem('_xhs_api')" 提取响应
9. 修改 page 参数分页，直到返回 notes 数量 < 预期 page_size
10. 提取: id, display_title, type, time, view_count, likes, comments_count, collected_count, shared_count
```

### 6.2 抓取笔记分析数据

```
1. agent-browser open "https://creator.xiaohongshu.com/statistics/data-analysis"
2. 拦截 API: GET /api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1
3. 递增 page_num 分页至 note_infos 为空
4. 提取: id, title, read_count, like_count, comment_count, share_count, fav_count, post_time, type
```

### 6.3 SPA 导航建议

推荐用 Vue Router 导航避免刷新导致监控脚本丢失:

```javascript
var app = document.querySelector('[id="app"]').__vue_app__;
app.config.globalProperties.$router.push("/statistics/data-analysis");
```

### 6.4 关键 CSS 选择器

| 用途 | 选择器 |
|------|--------|
| Vue App 根节点 | [id="app"] |
| 侧边栏菜单项 | .d-menu-item |
| 菜单标题 | .d-menu-item__title |
| 二级菜单 | .d-menu-horizontal-icon |



---

## 七、API 汇总速查表

| # | API 路径 | 方法 | 用途 | 分页 |
|---|---------|------|------|------|
| 1 | /api/galaxy/v2/creator/note/user/posted | GET | 笔记列表 | page(0-based) |
| 2 | /api/galaxy/creator/datacenter/note/analyze/list | GET | 内容分析 | page_num+page_size |
| 3 | /api/galaxy/v2/creator/datacenter/audience/view/periods | GET | 观看时段 | 无 |
| 4 | /api/galaxy/v2/creator/datacenter/audience/source/account | GET | 流量来源 | 无 |
| 5 | /api/galaxy/creator/data/fans/overall_new | GET | 粉丝总览 | 无 |
| 6 | /api/galaxy/creator/data/active_fans_new | GET | 活跃粉丝 | 无 |
| 7 | /api/galaxy/v2/creator/live_rooms | GET | 直播列表 | page+page_size |
| 8 | /api/galaxy/v2/creator/datacenter/livedata/overview | POST | 直播概览 | 无 |
| 9 | /api/galaxy/creator/user/video | GET | 用户视频 | 无 |
| 10 | /api/galaxy/creator/datacenter/permission/query | GET | 权限查询 | 无 |

---

## 八、注意事项

1. **数据权限延迟**: 新账号申请数据看板后需次日查看（API 返回 tip_msg: 已为您申请数据权限，次日可查看）
2. **观看阈值**: 笔记详情需观看 >=100 才有完整分析
3. **无评论管理**: 创作者中心无评论管理，仅 count 字段
4. **API 鉴权严格**: 脱离浏览器纯API调用不可行
5. **Cookie 时效**: a1/websectiga 可能过期，长时运行需处理重登
6. **xsec_token**: 敏感操作的安全令牌，可能在后续更新中收紧
