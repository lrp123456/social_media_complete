# 视频号创作者平台 API 调研提示词

## 🎯 调研目标

请登录微信视频号助手平台 (channels.weixin.qq.com)，通过浏览器 DevTools Network 面板验证以下 API 接口的真实路径、请求参数和响应结构。

---

## 📋 调研清单

### 1. 登录流程验证

**目标**: 验证登录状态检测和二维码获取

**操作步骤**:
1. 导航到 `https://channels.weixin.qq.com/platform`
2. 检查是否被重定向到 `/login`
3. 如果需要登录，观察登录页面的 iframe 结构
4. 记录二维码图片的 DOM 选择器

**需要记录**:
- [ ] 登录页 URL 跳转规则
- [ ] 二维码 iframe 的 `src` 属性格式
- [ ] 二维码图片的 CSS 选择器（用于截图）
- [ ] 登录成功后的跳转 URL

---

### 2. 视频列表 API (Phase 1)

**目标**: 验证视频列表接口

**操作步骤**:
1. 登录后导航到 `https://channels.weixin.qq.com/platform/post/list`
2. 打开 DevTools → Network → XHR 筛选
3. 刷新页面或滚动加载更多
4. 找到包含视频列表的 API 请求

**需要记录**:
- [ ] API 完整路径（预期: `/mmfinderassistant-bin/post/post_list`）
- [ ] 请求方法 (GET/POST)
- [ ] 请求 Headers（特别是 Cookie 格式）
- [ ] 请求 Body 参数（offset, limit, type 等）
- [ ] 响应 JSON 结构（特别关注）:
  ```json
  {
    "errcode": 0,
    "errmsg": "ok",
    "list": [
      {
        "export_id": "???",
        "desc": "???",
        "create_time": 0,
        "object_stat": {
          "play_count": 0,
          "like_count": 0,
          "comment_count": 0,
          "share_count": 0,
          "recommend_count": 0
        }
      }
    ],
    "total_count": 0,
    "has_more": false
  }
  ```
- [ ] 确认视频 ID 字段名（是 `export_id` 还是其他？）
- [ ] 确认分页参数（offset/limit 或 cursor？）

---

### 3. 评论列表 API (Phase 2-3)

**目标**: 验证评论采集接口

**操作步骤**:
1. 导航到 `https://channels.weixin.qq.com/platform/comment`
2. 选择一个有评论的视频
3. 在 Network 面板筛选 XHR
4. 观察评论加载的 API 请求

**需要记录**:
- [ ] API 完整路径（预期: `/mmfinderassistant-bin/comment/get_comment_list` 或类似）
- [ ] 请求方法 (GET/POST)
- [ ] 请求 Body 参数:
  ```json
  {
    "export_id": "视频ID",
    "offset": 0,
    "limit": 20,
    "sort_type": 1,
    "status": 0
  }
  ```
- [ ] 响应 JSON 结构:
  ```json
  {
    "errcode": 0,
    "list": [
      {
        "comment_id": "???",
        "content": "???",
        "nickname": "???",
        "head_img_url": "???",
        "create_time": 0,
        "like_count": 0,
        "reply_count": 0,
        "is_author_reply": false
      }
    ],
    "total_count": 0,
    "has_more": false
  }
  ```
- [ ] 确认评论 ID 字段名（是 `comment_id` 还是其他？）
- [ ] 确认排序参数（sort_type 的含义）

---

### 4. 子回复 API (Phase 3)

**目标**: 验证评论回复接口

**操作步骤**:
1. 在评论列表中点击"展开回复"或类似按钮
2. 观察 Network 面板中的新请求
3. 记录子回复 API

**需要记录**:
- [ ] API 完整路径（预期: `/mmfinderassistant-bin/comment/get_reply_list` 或类似）
- [ ] 请求参数:
  ```json
  {
    "comment_id": "父评论ID",
    "export_id": "视频ID",
    "offset": 0,
    "limit": 20
  }
  ```
- [ ] 响应结构（是否与一级评论相同？）
- [ ] 子回复的层级标识字段

---

### 5. 回复发送 API (可选)

**目标**: 验证评论回复接口

**操作步骤**:
1. 在评论区点击"回复"按钮
2. 输入回复内容并发送
3. 观察发送请求

**需要记录**:
- [ ] API 路径
- [ ] 请求参数（comment_id, content 等）
- [ ] 响应格式

---

### 6. DOM 选择器验证

**目标**: 验证关键 UI 元素的 CSS 选择器

**需要验证的元素**:

| 元素 | 预期选择器 | 验证结果 |
|------|-----------|---------|
| 侧边栏容器 | `#side-bar` 或 `.finder-ui-desktop-menu__wrp` | |
| "内容管理" 菜单 | `getByText('span', '内容管理')` | |
| "视频" 子菜单 | `.finder-ui-desktop-sub-menu__item:has(span:has-text('视频'))` | |
| "互动管理" 菜单 | `getByText('span', '互动管理')` | |
| "评论" 子菜单 | `.finder-ui-desktop-sub-menu__item:has(span:has-text('评论'))` | |
| 切换视频按钮 | `getByText('button', '切换视频')` | |
| 回复按钮 | `getByText('button', '回复')` | |
| 发送按钮 | `getByText('button', '发送')` | |
| 回复输入框 | `.reply-textarea` 或 `textarea[placeholder*='回复']` | |
| 评论列表容器 | `.comment-list-container` 或 `wujie-app .comment-list` | |

---

## 🔧 技术注意事项

### wujie 微前端特殊处理
视频号使用 wujie 微前端框架，DOM 结构特殊：
- 主应用 DOM 和子应用 DOM 是隔离的
- 视频列表和评论列表在 `<wujie-app>` 容器内
- CSS 选择器需要穿透 wujie 容器：`wujie-app .video-card`
- API 请求路径带 `/micro/content/` 前缀

### Cookie 格式
- 域名: `channels.weixin.qq.com`
- 关键 Cookie 字段（需要记录）

### 请求 Headers
- 必需的 Headers（如 Referer, Origin 等）
- 是否有特殊签名机制

---

## 📤 输出格式

请按以下格式整理调研结果：

```markdown
## 视频号 API 调研报告

### 1. 登录流程
- 登录 URL: 
- 二维码选择器: 
- 登录成功标志: 

### 2. 视频列表 API
- 路径: 
- 方法: 
- 请求参数: 
- 响应结构: 
- 分页机制: 

### 3. 评论列表 API
- 路径: 
- 方法: 
- 请求参数: 
- 响应结构: 
- 排序参数: 

### 4. 子回复 API
- 路径: 
- 方法: 
- 请求参数: 
- 响应结构: 

### 5. DOM 选择器验证
[表格形式列出验证结果]

### 6. 发现的问题/差异
[列出与预期不符的地方]
```

---

## ⚠️ 风险提示

1. **登录有效期**: Cookie 可能几小时后过期，需要重新登录
2. **风控检测**: 频繁请求可能触发验证码，建议间隔 3-5 秒
3. **API 变更**: 微信可能随时更新 API，以实际验证为准
4. **数据隐私**: 调研过程中可能看到真实用户数据，请勿泄露

---

## 📚 参考文档

- 设计文档: `docs/superpowers/specs/2026-06-10-tencent-video-monitor-design.md`
- 详细方案: `dom源文件/视频号/视频号视频监控方案.md`
- 现有实现: `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`
