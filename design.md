# 多平台视频评论监控系统 — 设计方案

> 版本：v1.0 | 日期：2026-06-06
> 目标：小红书 / 快手 / 抖音 三平台评论全量初始化 + 增量监控 + 拟人化回复

---

## 一、需求概述

### 1.1 核心目标

1. **首次初始化**：每个平台爬取最新 20 个视频及其所有评论（含多级回复），建立评论库
2. **增量监控**：定期检测评论数变化，发现增长后拉取新增评论并更新库
3. **拟人化回复**：基于 UI 操作（点击/输入/发送）实现自动回复，强防封控

### 1.2 范围

| 平台 | 视频来源 | 评论来源 | 回复入口 |
|------|---------|---------|---------|
| 小红书 | 创作者中心笔记列表 | 主站笔记详情页 | 主站通知页 |
| 快手 | 创作者中心 Profile / 评论管理 | 创作者中心评论管理 | 创作者中心评论管理 |
| 抖音 | 创作者中心内容管理 | 创作者中心评论管理 | 创作者中心评论管理 |

---

## 二、三平台评论 API 对比

### 2.1 视频/笔记列表获取

| 维度 | 小红书 | 快手 | 抖音 |
|------|--------|------|------|
| API | `GET /api/galaxy/v2/creator/note/user/posted` | `GET /rest/cp/creator/analysis/pc/home/photo/list` | `GET /web/api/creator/item/list` |
| 分页 | page(0-based) | page(1-based)+pageSize, totalCount | cursor 游标 |
| 关键 ID | `data.notes[].id` | `data.photoItems[].photoId` | items[].aweme_id |
| 评论数字段 | `comments_count` | `commentCount` | 需单独获取 |
| 签名 | Cookie (a1, webId, websectiga) | **必须** `__NS_sig3` | msToken+a_bogus（浏览器补齐） |

### 2.2 一级评论获取

| 维度 | 小红书 | 快手 | 抖音 |
|------|--------|------|------|
| API | `GET edith.../api/sns/web/v2/comment/page` | `POST /rest/cp/creator/comment/commentList` | `GET .../comment/list/select/` |
| 参数 | note_id, cursor | photoId (body) | aweme_id, cursor, count |
| 分页 | cursor 游标, has_more | **无分页**，一次性返回 | cursor 游标, has_more |
| 总量字段 | interactInfo.commentCount | 无 | total |
| 子评论 | 默认前3条嵌套在 sub_comments[] | **不嵌套**，需独立 API | **不嵌套** (reply_comment=null) |
| 签名 | Cookie + xsec_token | **必须** `__NS_sig3` | msToken+a_bogus |

### 2.3 子回复获取

| 维度 | 小红书 | 快手 | 抖音 |
|------|--------|------|------|
| API | `GET .../comment/sub/page` | `POST .../comment/subCommentList` | `GET .../comment/list/reply/` |
| 参数 | root_comment_id, cursor | commentId, photoId | comment_id, item_id, cursor |
| 分页 | cursor 游标 | **无分页** | cursor 游标 |
| 多级深度 | 2级（平铺，target_comment 区分） | 2级（subCommentCount 恒0） | 2级（level 字段） |
| 签名 | Cookie + xsec_token | **必须** `__NS_sig3` | msToken+a_bogus |

---

## 三、数据库设计

```sql
-- 视频/笔记表
CREATE TABLE videos (
    id              TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,              -- xiaohongshu / kuaishou / douyin
    title           TEXT,
    cover_url       TEXT,
    publish_time    BIGINT,
    comment_count   INTEGER DEFAULT 0,         -- 上次同步值
    last_sync_at    BIGINT,
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(platform, id)
);

-- 评论表（一级评论+子回复统一存储）
CREATE TABLE comments (
    id              TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,
    video_id        TEXT NOT NULL,
    parent_id       TEXT DEFAULT '',            -- 空=一级评论
    root_id         TEXT DEFAULT '',            -- 根评论ID
    level           INTEGER DEFAULT 1,          -- 1=一级, 2=子回复
    content         TEXT NOT NULL,
    author_id       TEXT,
    author_name     TEXT,
    author_avatar   TEXT,
    create_time     BIGINT,
    like_count      INTEGER DEFAULT 0,
    reply_count     INTEGER DEFAULT 0,
    reply_to_id     TEXT DEFAULT '',
    reply_to_name   TEXT DEFAULT '',
    ip_location     TEXT DEFAULT '',
    is_author       BOOLEAN DEFAULT FALSE,
    extra           TEXT DEFAULT '{}',
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(platform, id)
);

CREATE INDEX idx_comments_video ON comments(platform, video_id);
CREATE INDEX idx_comments_parent ON comments(platform, parent_id);
CREATE INDEX idx_comments_root ON comments(platform, root_id);

-- 同步状态表
CREATE TABLE sync_state (
    platform            TEXT PRIMARY KEY,
    video_ids           TEXT,                   -- JSON数组
    last_comment_counts TEXT,                   -- JSON: {video_id: count}
    cursors             TEXT,                   -- JSON: 各视频游标状态
    last_sync_at        BIGINT,
    created_at          TIMESTAMP DEFAULT NOW()
);
```

---

## 四、初始化流程（首次全量）

```
Phase 1: 获取最新 N 个视频
  对每个平台调用视频列表API → 取前20个 → 写入 videos 表

Phase 2: 全量拉取每个视频的所有评论
  for each video:
    ├── 拉取所有一级评论（翻页至 has_more=false）
    └── for each 一级评论 (reply_count > 0):
          拉取所有子回复（翻页至 has_more=false）
    → 写入 comments 表

Phase 3: 记录快照
  更新 sync_state: video_ids / last_comment_counts / cursors
```

### 小红书拉取示意

```python
def fetch_xhs_all(page, note_id):
    cursor = ""
    while True:
        resp = page.evaluate(f"""
            fetch('/api/sns/web/v2/comment/page?note_id={note_id}&cursor={cursor}')
        """)
        for c in resp["data"]["comments"]:
            subs = list(c.get("sub_comments", []))
            if c.get("sub_comment_has_more"):
                subs += fetch_xhs_subs(page, note_id, c["id"], c["sub_comment_cursor"])
            save_comment(c, subs)
        if not resp["data"]["has_more"]: break
        cursor = resp["data"]["cursor"]
```

### 快手拉取示意

```python
def fetch_ks_all(page, photo_id):
    # 一级评论一次性全量返回
    comments = page.evaluate(f"""
        fetch('/rest/cp/creator/comment/commentList', {{
            method:'POST', body: JSON.stringify({{photoId:'{photo_id}', ...}})
        }})
    """)
    for c in comments["data"]["list"]:
        subs = []
        if c["subCommentCount"] > 0:
            subs = page.evaluate(f"""
                fetch('/rest/cp/creator/comment/subCommentList', {{
                    method:'POST', body: JSON.stringify({{commentId:{c['commentId']}, ...}})
                }})
            """)["data"]["list"]
        save_comment(c, subs)
```

### 抖音拉取示意

```python
def fetch_dy_all(page, aweme_id):
    cursor = 0
    while True:
        resp = page.evaluate(f"""
            fetch('.../comment/list/select/?aweme_id={aweme_id}&cursor={cursor}&count=10')
        """)
        for c in resp["comments"]:
            subs = []
            if c["comment_reply_total"] > 0:
                subs = fetch_dy_replies(page, c["reply_id"], aweme_id)
            save_comment(c, subs)
        if resp["has_more"] == 0: break
        cursor = resp["cursor"]
```

---

## 五、增量更新流程

```
定时任务 (每 5-10 分钟)
    │
    ├── Step 1: 刷新视频列表
    │   获取最新20个 → 对比 sync_state.video_ids
    │   → 新视频加入监控（全量拉取评论）
    │   → 移除的视频保留历史数据
    │
    ├── Step 2: 检测评论数变化
    │   foreach monitored video:
    │     new_count = 重新获取 comment_count
    │     old_count = last_comment_counts[video_id]
    │     if new_count > old_count → Step 3
    │
    ├── Step 3: 增量拉取
    │   ┌─ 小红书：拉取最新页 → 按 comment_id 去重 → 新评论入库
    │   ├─ 快手：  重新拉全量 → 按 commentId 差集 → 新评论入库
    │   └─ 抖音：  从上次 cursor 继续 → 新评论入库
    │   → 对新评论拉取子回复
    │
    └── Step 4: 更新快照
        last_comment_counts = {video_id: new_count, ...}
```

---

## 六、拟人化回复集成

回复链路：`增量评论入库 → 规则匹配 → 浏览器拟人化回复`

| 平台 | 回复按钮 | 输入框 | 发送按钮 | 单条延迟 |
|------|---------|--------|---------|---------|
| 小红书 | `div.action-reply` | `textarea.comment-input` | `button.submit` | 10-15s |
| 快手 | `.icon-reply` | `div[contenteditable]` | 发送按钮 | 3-6s |
| 抖音 | `div.item-M3fSkJ`(文本"回复") | `div.input-d24X73[contenteditable]` | 发送按钮(初始disabled) | 6-12s |

操作时序：`snapshot定位 → click回复按钮 → 等待输入框出现 → 逐字keyboard type(50-150ms/字) → 停顿 → click发送 → 等待反馈 → 冷却`

防封控策略：真实浏览器指纹、逐字键入、随机延迟、合理间隔上限、异常降级。

---

## 七、项目结构建议

```
social_media_complete/
├── config/
│   └── platforms.yaml          # 三平台配置
├── core/
│   ├── browser.py              # 浏览器管理
│   ├── fetcher.py              # 评论拉取
│   ├── syncer.py               # 增量同步引擎
│   └── reply_engine.py         # 拟人化回复
├── platforms/
│   ├── xiaohongshu.py
│   ├── kuaishou.py
│   └── douyin.py
├── db/
│   ├── models.py
│   ├── schema.sql
│   └── repository.py
├── rules/
│   └── reply_rules.yaml
├── scheduler.py
├── init.py                     # 首次初始化入口
├── monitor.py                  # 监控主循环
└── requirements.txt
```

---

## 八、实施路线

| 阶段 | 内容 | 产出 |
|------|------|------|
| Phase 1 | 数据库建表 + 配置 | schema.sql, platforms.yaml |
| Phase 2 | 三平台评论拉取器 | fetcher.py + 3 个 platform 模块 |
| Phase 3 | 首次全量初始化 | init.py |
| Phase 4 | 增量同步引擎 | syncer.py + scheduler.py |
| Phase 5 | 拟人化回复集成 | reply_engine.py |
| Phase 6 | 防封控调优 | 延迟/频率/异常处理 |

---

## 九、注意事项

1. **快手签名**：`__NS_sig3` 必须在浏览器上下文中生成
2. **抖音 msToken**：读 API 用相对 URL 可自动补齐签名
3. **小红书多级**：虽支持多级，`comment/sub/page` 返回平铺，`target_comment.id` 区分回复对象
4. **Cookie 保活**：三平台 Cookie 均有有效期，需处理过期重登
5. **频率控制**：初始化视频间 3-5s，增量同步间隔 5-10min