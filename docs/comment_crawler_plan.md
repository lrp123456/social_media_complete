# Social Media Complete — 评论全量爬取与回复增量开发方案

> 版本：v1.0 | 日期：2026-06-06
> 基于项目 v3.0.0 现状分析，方案仅描述**新增内容**，不修改现有代码

---

## 零、与现有项目的关系

### 0.1 现有基础（可直接复用）

| 现有能力 | 位置 | 复用方式 |
|---------|------|---------|
| 浏览器管理 | `packages/browser-core/` | crawler 通过 TS-API 获取 CDP 连接 |
| RoxyBrowser 指纹浏览器 | `browserManager.ts` | 复用窗口池，避免并发冲突 |
| HumanActions CDP 操作 | `humanActions.ts` (1294行) | 所有 DOM 操作走 HA 委托层 |
| 选择器配置体系 | `selectors.json` + `selectorConfig.ts` | 新增评论相关选择器条目 |
| Prisma ORM + Schema | `prisma/schema.prisma` | 复用 comments / videos / video_comment_counts 表 |
| BullMQ 任务队列 | `publishService.ts` | 新增 `crawlQueue` / `replyQueue` |
| ARQ 任务队列 | `python-worker/app/workers/` | crawler 作为 ARQ 任务执行 |
| Redlock 互斥锁 | `redlock.ts` | 爬虫任务加锁防并发 |
| Trace ID 链路 | `middleware/trace.ts` | 爬虫任务携带 trace_id |
| 监控调度器 | `monitorService.ts` | 对接新增的爬虫结果 |
| 选择器热更新 | `selectorStore.ts` | 评论选择器支持热更新 |

### 0.2 增量范围（仅新增，不修改）

```
新增文件清单：
│
├── apps/python-worker/app/crawlers/          # 【核心新增】爬虫采集层
│   ├── __init__.py
│   ├── base_crawler.py                      # 评论爬虫抽象基类 (BaseCommentCrawler)
│   ├── xiaohongshu_crawler.py               # 小红书评论爬虫
│   ├── kuaishou_crawler.py                  # 快手评论爬虫
│   └── douyin_crawler.py                    # 抖音评论爬虫
│
├── apps/python-worker/app/crawlers/reply/    # 【核心新增】评论回复引擎
│   ├── __init__.py
│   ├── base_reply_engine.py                 # 回复引擎抽象基类
│   ├── xiaohongshu_reply.py                 # 小红书回复
│   ├── kuaishou_reply.py                    # 快手回复
│   └── douyin_reply.py                      # 抖音回复
│
├── apps/python-worker/app/crawlers/tasks.py  # ARQ 爬虫任务入口
│
├── apps/ts-api-gateway/src/services/
│   └── crawlService.ts                      # 爬虫调度服务 (BullMQ)
│
├── apps/ts-api-gateway/src/routes/
│   └── crawl.ts                             # 爬虫管理 API
│
├── data/
│   └── comment_selectors.json               # 评论专用选择器（与 selectors.json 互补）
│
└── docs/
    └── comment_crawler_design.md            # 本方案文档
```

---

## 一、三平台评论 UI 交互模式总结

### 1.1 小红书 (www.xiaohongshu.com/explore/{note_id})

```
DOM 结构:
  DIV.comments-el
    DIV.total              → "共 113 条评论"（总数含子回复，但可能有差值）
    DIV.list-container     → 滚动加载锚点
      DIV.parent-comment   → 一级评论容器
        DIV.comment-item   → 一级评论主体
        DIV.reply-container
          DIV.comment-item.comment-item-sub  → 子回复
          DIV.comment-menu.comment-menu-sub  → 含"展开X条回复"按钮

翻页机制:
  一级评论: IntersectionObserver 滚动触发，最后一条 .parent-comment 进入视口即可
  子回复:   手动点击"展开 X 条回复" → 加载首批(≤10条)
           若 subCommentHasMore=true → 出现"展开更多回复" → 二次点击加载剩余

展开子回复全量操作流程:
  1. 等待评论区加载 → 滚动至底部触发一级翻页（循环至 hasMore=false）
  2. 对所有 sub_comment_count > 0 的评论:
     a. 点击文本匹配 "展开 \d+ 条回复" 的 clickable div
     b. 等待 .reply-container 内新增 .comment-item-sub
     c. 检测"展开更多回复"按钮 → 若存在则再点击 → 等待
     d. 按钮消失 = 该评论子回复全部展开完毕
```

### 1.2 快手 (cp.kuaishou.com/article/comment)

```
DOM 结构:
  .comment
    .comment__header
      .comment__header__video-btn  → "选择视频"按钮
    .comment__content
      .comment-list
        .auto-load-list           → 评论列表容器
          .comment-item            → 一级评论
            .comment-item__content
              .comment-item__content__expand-btn  → "展开查看N条回复"
            .comment-item__content__sub-comments  → 子回复区(展开后出现)
              .comment-sub-item    → 子回复

视频切换:
  点击"选择视频" → .drawer.video-list 从右侧滑出
  → .auto-load-list 滚动加载（初始10条 → 滚动到底加载全部）
  → 点击视频项 → Drawer关闭，评论列表切换

展开子回复全量操作流程:
  1. 对当前视频的所有一级评论:
     a. 查找 .comment-item__content__expand-btn（文本匹配 /展开查看\d+条回复/）
     b. 点击 → .comment-item__content__sub-comments 出现
     c. 子回复一次性全部展开，无需二次操作
     d. 展开后按钮变为"收起回复"文本
  2. 切换视频: 点击"选择视频" → 滚动 Drawer 加载全部 → 逐个点击视频 → 重复步骤1
```

### 1.3 抖音 (creator.douyin.com/creator-micro/interactive/comment)

```
DOM 结构:
  container-AFENbv
    header-TONxG8                → "评论管理"
    cover-WUCGcS                 → 视频封面
    divider-vbLa9B
    tabs-content
      operations-o6e97h
        container-Pr4RHc         → 三个筛选下拉框："全部/未回复/含问题/可能打扰"
        right-EN20ei             → "选择作品" + "发送"按钮
      评论列表区
        DIV.container-sXKyMs     → 每条评论（一级+子回复统一容器）
          comment-content-text-JvmAKq  → 评论文本
          reply-to-lFblpf        → 子回复的"回复 @XX"引用
          operations-WFV7Am      → 操作栏（操作按钮 + "查看X条回复"）

视频切换:
  点击"选择作品" → 弹出视频面板 → 每个视频显示含子回复的总评论数
  → 点击视频项 → 评论列表刷新

展开子回复全量操作流程:
  1. 对当前视频:
     a. 所有评论已在同一容器一次性渲染（无传统分页）
     b. 查找文本匹配"查看\d+条回复"的 clickable 元素
     c. 点击 → reply-list-QwXCb_ 出现，全部子回复一次性加载
     d. 按钮变为"收起"文本
  2. 切换视频: 点击"选择作品" → 点击下一个视频 → 重复步骤1
```

### 1.4 三平台对比速查

| 维度 | 小红书 | 快手 | 抖音 |
|------|--------|------|------|
| 页面入口 | 主站笔记详情页 | 创作者中心/评论管理 | 创作者中心/评论管理 |
| 一级评论翻页 | 滚动触发 IntersectionObserver | 一次性全量（commentList API） | 一次性全量 |
| 子回复加载 | 首批≤10条，需二次点击 | 一次性全量 | 一次性全量 |
| 展开按钮文本 | `展开 \d+ 条回复` → `展开更多回复` | `展开查看\d+条回复` | `查看\d+条回复` |
| 视频切换 | 直接替换URL | Drawer 抽屉 + 点击 | 弹出面板 + 点击 |
| 评论总数口径 | 页面数含子回复（有缺口） | 含子回复 | 含子回复 |
| 签名依赖 | Cookie + xsec_token | `__NS_sig3` | msToken+a_bogus |

---

## 二、数据库层

### 2.1 利用现有表

现有 Prisma Schema 已有以下相关表，**无需新建表**：

```prisma
model Video {
  id           String   @id
  userId       String?
  platform     String?
  description  String?
  createTime   BigInt?
  commentCount Int?
  metrics      Json?
  user         User?    @relation(fields: [userId], references: [id])
  comments     Comment[]
}

model Comment {
  id           String   @id
  videoId      String?
  cid          String?          // 平台评论ID
  text         String?
  userNickname String?
  userUid      String?
  diggCount    Int?
  isNew        Boolean?
  replyId      String?          // 父评论ID（用于嵌套）
  video        Video?   @relation(fields: [videoId], references: [id])
}

model VideoCommentCount {
  id           String   @id
  videoId      String?
  platform     String?
  totalCount   Int?             // 总评论数
  rootCount    Int?             // 一级评论数
  replyCount   Int?             // 子回复数
  // ...
}
```

### 2.2 建议新增字段（可选微调）

如果 Comment 模型需要区分一级评论和子回复，建议新增：

```prisma
model Comment {
  // ... 现有字段 ...
  parentId      String?          // 父评论ID（为空=一级评论）
  rootId        String?          // 根评论ID（子回复指向顶层一级评论）
  level         Int     @default(1)  // 1=一级, 2=子回复
  replyToId     String?          // 被回复的评论ID
  replyToName   String?          // 被回复用户昵称
}
```

> 注意：现有 Comment 模型已有 `replyId` 字段，可直接复用为 rootId。

---

## 三、爬虫采集层设计

### 3.1 整体架构

```
                        BullMQ crawlQueue
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  CrawlService (TS)                         │
│  - 接收爬虫任务请求                                          │
│  - 分配 RoxyBrowser 窗口                                    │
│  - 调用 ARQ 任务                                            │
└─────────────────────────────┬─────────────────────────────┘
                              │ Webhook (Trace-ID)
┌─────────────────────────────▼─────────────────────────────┐
│            BaseCommentCrawler (Python, 模板方法)             │
│                                                             │
│  crawl_video(video_id) → Template Method (final)            │
│    ├── 1. navigate_to_video(video_id)       ← 子类实现      │
│    ├── 2. expand_all_sub_replies()          ← 模板方法       │
│    ├── 3. extract_comments_from_dom()       ← 子类实现      │
│    ├── 4. parse_comment_tree(raw)           ← 基类实现      │
│    └── 5. persist_to_db(comments)            ← 基类实现      │
│                                                             │
│  full_init(platform) → 全量初始化                            │
│    └── 获取最新20个视频 → for each → crawl_video()            │
│                                                             │
│  incremental_sync(video_id, last_state) → 增量同步           │
│    └── 检测评论数变化 → crawl_video() → 差集入库              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 BaseCommentCrawler 模板方法（Python）

```python
# apps/python-worker/app/crawlers/base_crawler.py

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
import json
import time

@dataclass
class CommentNode:
    """评论树节点"""
    cid: str
    video_id: str
    platform: str
    level: int = 1
    content: str = ""
    author_id: str = ""
    author_name: str = ""
    author_avatar: str = ""
    create_time: int = 0
    like_count: int = 0
    reply_count: int = 0
    reply_to_id: str = ""
    reply_to_name: str = ""
    ip_location: str = ""
    is_author: bool = False
    sub_comments: list["CommentNode"] = field(default_factory=list)


class BaseCommentCrawler(ABC):
    """评论爬虫抽象基类 — 遵循模板方法模式 (参照 BasePublisher)"""
    
    def __init__(self, platform: str, cdp_page):
        self.platform = platform
        self.page = cdp_page
    
    # ========== 模板方法（final，子类不应覆盖） ==========
    
    async def crawl_video(self, video_id: str) -> list[CommentNode]:
        """爬取单个视频所有评论 — 模板方法"""
        await self._navigate_to_video(video_id)
        await self._wait_for_comments_loaded()
        await self._scroll_to_load_all_root_comments()
        await self._expand_all_sub_replies()
        raw = await self._extract_comments_from_dom()
        tree = self._parse_comment_tree(raw)
        await self._persist_to_db(tree)
        return tree
    
    async def full_init(self, video_ids: list[str]) -> dict:
        """全量初始化 — 爬取指定视频列表的所有评论"""
        results = {}
        for vid in video_ids:
            results[vid] = await self.crawl_video(vid)
            await self._cooldown(3, 5)
        return results
    
    async def incremental_sync(self, video_id: str, last_total: int) -> tuple[int, list[CommentNode]]:
        """增量同步 — 返回(新总数, 新增评论列表)"""
        new_total = await self._get_comment_count(video_id)
        if new_total <= last_total:
            return new_total, []
        
        all_comments = await self.crawl_video(video_id)
        existing_cids = await self._get_existing_cids(video_id)
        new_comments = [c for c in all_comments if c.cid not in existing_cids]
        
        # 仅持久化新增评论
        for c in new_comments:
            await self._persist_single(c)
        
        return new_total, new_comments
    
    # ========== 子类必须实现的抽象方法 ==========
    
    @abstractmethod
    async def _navigate_to_video(self, video_id: str):
        """导航到视频/笔记的评论页"""
        ...
    
    @abstractmethod
    async def _extract_comments_from_dom(self) -> list[dict]:
        """从 DOM 中提取评论原始数据（所有评论已展开后调用）"""
        ...
    
    @abstractmethod
    async def _get_comment_count(self, video_id: str) -> int:
        """获取视频当前评论总数"""
        ...
    
    # ========== 子类可选覆盖的方法 ==========
    
    async def _wait_for_comments_loaded(self):
        """等待评论区加载完成"""
        pass
    
    async def _scroll_to_load_all_root_comments(self):
        """滚动加载所有一级评论（小红书需要，快手/抖音无需）"""
        pass
    
    async def _expand_all_sub_replies(self):
        """展开所有子回复 — 通用模板方法，特殊平台可覆盖"""
        while True:
            expand_btns = await self._find_expand_buttons()
            if not expand_btns:
                break
            for btn_selector in expand_btns:
                try:
                    await self._click_button(btn_selector)
                    await self._random_delay(0.3, 0.8)
                except Exception:
                    continue
            await self._random_delay(1.0, 2.0)
    
    async def _find_expand_buttons(self) -> list[str]:
        """查找所有展开按钮的选择器列表"""
        raise NotImplementedError
    
    # ========== 基类通用方法 ==========
    
    def _parse_comment_tree(self, raw: list[dict]) -> list[CommentNode]:
        """将原始数据解析为 CommentNode 树"""
        ...
    
    async def _persist_to_db(self, comments: list[CommentNode]):
        """批量持久化到 PostgreSQL"""
        ...
    
    async def _persist_single(self, comment: CommentNode):
        """单条持久化"""
        ...
    
    async def _get_existing_cids(self, video_id: str) -> set[str]:
        """查询已有评论ID集合"""
        ...
    
    async def _click_button(self, selector: str):
        """通过 HumanActions 点击按钮"""
        ...
    
    async def _random_delay(self, min_s: float, max_s: float):
        """随机延迟"""
        ...
    
    async def _cooldown(self, min_s: float, max_s: float):
        """操作间冷却"""
        ...
```

### 3.3 小红书爬虫关键实现

```python
# apps/python-worker/app/crawlers/xiaohongshu_crawler.py

class XiaohongshuCrawler(BaseCommentCrawler):
    
    async def _navigate_to_video(self, note_id: str):
        # 构造笔记详情页 URL
        url = f"https://www.xiaohongshu.com/explore/{note_id}"
        # 滚动到评论区
        await self._scroll_to_selector(".comments-el")
    
    async def _scroll_to_load_all_root_comments(self):
        """小红书一级评论是滚动触发的 IntersectionObserver"""
        while True:
            parent_comments = await self._query_all(".parent-comment")
            # 滚动最后一条进入视口
            last = parent_comments[-1]
            await self._scroll_into_view(last)
            await self._random_delay(1.0, 2.0)
            # 检查是否有新评论加载
            new_count = await self._count(".parent-comment")
            if new_count == len(parent_comments):
                break
    
    async def _find_expand_buttons(self) -> list[str]:
        """小红书: 查找"展开 X 条回复"和"展开更多回复"按钮"""
        buttons = []
        # 方式一: 文本匹配
        btns1 = await self._query_all_with_text(r'展开(更多|\s*\d+\s*条)回复')
        buttons.extend(btns1)
        return buttons
    
    async def _extract_comments_from_dom(self) -> list[dict]:
        """从 DOM 提取评论数据"""
        return await self.page.evaluate("""
            () => {
                const results = [];
                const parents = document.querySelectorAll('.parent-comment');
                parents.forEach(p => {
                    const rootItem = p.querySelector('.comment-item:not(.comment-item-sub)');
                    if (!rootItem) return;
                    
                    const root = {
                        cid: rootItem.getAttribute('data-comment-id') || '',
                        content: rootItem.querySelector('.note-text')?.textContent || '',
                        author_name: rootItem.querySelector('.name')?.textContent || '',
                        level: 1,
                        sub_comments: []
                    };
                    
                    const subItems = p.querySelectorAll('.comment-item.comment-item-sub');
                    subItems.forEach(sub => {
                        root.sub_comments.push({
                            cid: sub.getAttribute('data-comment-id') || '',
                            content: sub.querySelector('.note-text')?.textContent || '',
                            author_name: sub.querySelector('.name')?.textContent || '',
                            reply_to_name: sub.querySelector('.reply-target')?.textContent?.replace('回复 ', '') || '',
                            level: 2
                        });
                    });
                    
                    results.push(root);
                });
                return results;
            }
        """)
    
    async def _get_comment_count(self, note_id: str) -> int:
        count_text = await self._text_content(".total")
        # "共 113 条评论" → 113
        import re
        match = re.search(r'(\d+)', count_text)
        return int(match.group(1)) if match else 0
```

### 3.4 快手爬虫关键实现

```python
class KuaishouCrawler(BaseCommentCrawler):
    
    async def _navigate_to_video(self, photo_id: str):
        """已在评论管理页面，切换视频"""
        # 点击"选择视频"打开 Drawer
        await self._click_button(".comment__header__video-btn")
        await self._random_delay(0.5, 1.0)
        # 滚动 Drawer 加载全部视频
        await self._scroll_drawer_to_load_all()
        # 点击目标视频
        await self._click_video_item(photo_id)
        await self._wait_for_comments_loaded()
    
    async def _scroll_drawer_to_load_all(self):
        """滚动 Drawer 加载全部视频"""
        while True:
            count_before = await self._count(".drawer .video-item")
            await self._scroll_selector_bottom(".drawer__content")
            await self._random_delay(1.0, 2.0)
            count_after = await self._count(".drawer .video-item")
            if count_after == count_before:
                break
    
    async def _find_expand_buttons(self) -> list[str]:
        """快手: 展开查看N条回复"""
        # 用 HumanActions 的 getByText 匹配正则
        return [r'/展开查看\d+条回复/']
    
    async def _extract_comments_from_dom(self) -> list[dict]:
        return await self.page.evaluate("""
            () => {
                const results = [];
                document.querySelectorAll('.comment-item').forEach(item => {
                    const content = item.querySelector('.comment-item__content');
                    if (!content) return;
                    
                    const root = {
                        cid: item.getAttribute('data-comment-id') || '',
                        content: content.querySelector('.comment-item__content__detail')?.textContent || '',
                        author_name: content.querySelector('.comment-item__content__username')?.textContent || '',
                        level: 1,
                        sub_comments: []
                    };
                    
                    content.querySelectorAll('.comment-sub-item').forEach(sub => {
                        root.sub_comments.push({
                            cid: sub.getAttribute('data-comment-id') || '',
                            content: sub.querySelector('.comment-item__content__detail')?.textContent || '',
                            author_name: sub.querySelector('.comment-item__content__username')?.textContent || '',
                            level: 2
                        });
                    });
                    
                    results.push(root);
                });
                return results;
            }
        """)
```

### 3.5 抖音爬虫关键实现

```python
class DouyinCrawler(BaseCommentCrawler):
    
    async def _navigate_to_video(self, aweme_id: str):
        """已在评论管理页面，点击"选择作品"切视频"""
        await self._click_button('button:has-text("选择作品")')
        await self._random_delay(0.5, 1.0)
        # 在视频面板中点击目标视频
        await self._click_video_by_aweme_id(aweme_id)
        await self._random_delay(1.0, 2.0)
    
    async def _find_expand_buttons(self) -> list[str]:
        """抖音: 查看X条回复"""
        return [r'/查看\d+条回复/']
    
    async def _extract_comments_from_dom(self) -> list[dict]:
        return await self.page.evaluate("""
            () => {
                const results = [];
                const containers = document.querySelectorAll('.container-sXKyMs');
                containers.forEach(c => {
                    const textEl = c.querySelector('.comment-content-text-JvmAKq');
                    if (!textEl) return;
                    
                    const replyToEl = c.querySelector('.reply-to-lFblpf');
                    const isSub = !!replyToEl;
                    
                    const comment = {
                        cid: c.getAttribute('data-cid') || '',
                        content: textEl.textContent || '',
                        level: isSub ? 2 : 1,
                        reply_to_name: isSub ? (replyToEl.textContent?.replace('回复 @', '') || '') : '',
                        sub_comments: []
                    };
                    
                    if (!isSub) {
                        const replyList = c.querySelector('.reply-list-QwXCb_');
                        if (replyList) {
                            replyList.querySelectorAll('.container-sXKyMs').forEach(sub => {
                                const subText = sub.querySelector('.comment-content-text-JvmAKq');
                                const subReply = sub.querySelector('.reply-to-lFblpf');
                                if (subText) {
                                    comment.sub_comments.push({
                                        cid: sub.getAttribute('data-cid') || '',
                                        content: subText.textContent || '',
                                        reply_to_name: subReply ? subReply.textContent?.replace('回复 @', '') || '' : '',
                                        level: 2
                                    });
                                }
                            });
                        }
                    }
                    
                    results.push(comment);
                });
                return results;
            }
        """)
```

---

## 四、评论回复引擎

### 4.1 架构

```
BaseReplyEngine (Python)
├── reply_to_comment(comment_id, text) → Template Method
│   ├── navigate_to_comment_page()      ← 子类实现
│   ├── locate_comment(comment_id)       ← 子类实现
│   ├── click_reply_button()            ← 子类实现
│   ├── type_reply_text(text)           ← 基类实现（HumanActions 逐字键入）
│   └── click_submit_button()           ← 子类实现
│
├── batch_reply(comments: [(id, text)]) → 批量回复
│   └── Redlock 加锁 → for each → reply → 冷却 → 解锁
```

### 4.2 三平台回复 DOM 操作

| 平台 | 回复按钮 | 输入框 | 发送按钮 | 反馈检测 |
|------|---------|--------|---------|---------|
| 小红书 | `div.action-reply` | `textarea.comment-input` | `button.submit` | 输入框关闭 = 成功 |
| 快手 | `.icon-reply` | `div[contenteditable="true"]` | 有独立发送按钮 | DOM 级反馈 |
| 抖音 | `div.item-M3fSkJ` (文本"回复") | `div.input-d24X73[contenteditable]` | 发送按钮(初始disabled) | disabled→enabled→disabled |

### 4.3 拟人化策略（防封控，用户强偏好）

```python
class BaseReplyEngine(ABC):
    """拟人化回复引擎"""
    
    async def _human_type(self, text: str):
        """逐字键入，模拟人类打字"""
        for char in text:
            await self.page.keyboard.type(char)  # 或 CDP Input.dispatchKeyEvent
            await asyncio.sleep(random.uniform(0.05, 0.15))  # 50-150ms/字
    
    async def _human_click(self, selector: str):
        """拟人点击：先移动鼠标 → 随机微停顿 → 点击"""
        await self._mouse_move_to(selector, trajectory="bezier")
        await asyncio.sleep(random.uniform(0.1, 0.3))
        await self._click(selector)
    
    async def batch_reply(self, tasks: list[tuple[str, str]], cooldown: tuple = (10, 30)):
        """批量回复，每条间隔10-30秒随机冷却"""
        for comment_id, text in tasks:
            success = await self.reply_to_comment(comment_id, text)
            if success:
                await self._record_reply(comment_id, text)
            await asyncio.sleep(random.uniform(*cooldown))
```

---

## 五、增量更新机制

### 5.1 两种更新模式

| 模式 | 触发条件 | 逻辑 |
|------|---------|------|
| **全量初始化** | 首次使用 / 新增监控视频 | 爬取视频所有评论（含展开全部子回复） |
| **增量更新** | 定时检测（每5-10分钟） | 对比评论总数 → 拉取新增评论 → 差集入库 |

### 5.2 增量检测策略（按平台）

```python
# 检测评论数变化
async def detect_changes(platform: str, video_id: str, last_total: int) -> dict:
    """返回: {"new_total": int, "delta": int, "new_comments": list}"""
    
    new_total = await crawler._get_comment_count(video_id)
    if new_total <= last_total:
        return {"new_total": new_total, "delta": 0, "new_comments": []}
    
    # 全量爬取（因为需要展开所有回复才能拿到完整结构）
    all_comments = await crawler.crawl_video(video_id)
    
    existing_cids = await db.get_comment_cids(platform, video_id)
    new_comments = [
        c for c in all_comments 
        if c.cid not in existing_cids and c.create_time > last_sync_time
    ]
    
    return {
        "new_total": new_total,
        "delta": len(new_comments),
        "new_comments": new_comments
    }
```

### 5.3 增量答案：哪些评论是新增的

全量爬取后，通过以下方式确定新增评论：

1. **按 cid 差集**：爬取结果与 DB 中已有 cid 做差集 = 新增评论
2. **按时间过滤**：新增评论中取 `create_time > last_sync_time` 的 = 本次新增
3. **按数量验证**：`delta = new_total - old_total`，与差集数量交叉验证

```
全量爬取结果 (所有评论已展开)
    │
    ├── 已有 cid (在 DB 中)  → 跳过
    │
    └── 新 cid (不在 DB 中)
         │
         ├── create_time > last_sync_time → 本次新增评论
         └── 可触发回复规则匹配
```

---

## 六、ARQ 任务与 BullMQ 调度

### 6.1 Python ARQ 任务

```python
# apps/python-worker/app/crawlers/tasks.py

from arq import cron
from app.crawlers.base_crawler import BaseCommentCrawler

async def crawl_full_init(ctx, platform: str, user_id: str):
    """全量初始化任务"""
    crawler = create_crawler(platform, ctx)
    videos = await get_latest_videos(platform, limit=20)
    results = await crawler.full_init([v.id for v in videos])
    # 回调 TS 端更新状态
    await webhook.notify("crawl_init_complete", {
        "platform": platform, "video_count": len(results)
    })

async def crawl_incremental_sync(ctx, platform: str):
    """增量同步任务"""
    crawler = create_crawler(platform, ctx)
    state = await get_sync_state(platform)
    
    for video_id, last_total in state["last_counts"].items():
        new_total, new_comments = await crawler.incremental_sync(video_id, last_total)
        if new_comments:
            # 触发回复规则匹配
            await enqueue_reply_check(platform, new_comments)
        state["last_counts"][video_id] = new_total
    
    await save_sync_state(platform, state)

# ARQ 定时任务
ARQ_CRON_JOBS = [
    cron(crawl_incremental_sync, minute={0, 10, 20, 30, 40, 50}, kwargs={"platform": "xiaohongshu"}),
    cron(crawl_incremental_sync, minute={5, 15, 25, 35, 45, 55}, kwargs={"platform": "kuaishou"}),
]
```

### 6.2 TS 端 BullMQ 调度

```typescript
// apps/ts-api-gateway/src/services/crawlService.ts

import { Queue, Worker } from 'bullmq';

export const crawlQueue = new Queue('crawl-queue', { connection: redis });

// 全量初始化
export async function startFullInit(platform: string, userId: string) {
    await crawlQueue.add('full_init', { platform, userId }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60000 }
    });
}

// 增量同步
export async function startIncrementalSync(platform: string) {
    await crawlQueue.add('incremental_sync', { platform }, {
        repeat: { every: 300000 }  // 每5分钟
    });
}
```

---

## 七、选择器配置新增

### 7.1 comment_selectors.json 结构

```json
{
  "xiaohongshu": {
    "comment_page": {
      "container": ".comments-el",
      "list_container": ".list-container",
      "parent_comment": ".parent-comment",
      "comment_item": ".comment-item:not(.comment-item-sub)",
      "sub_comment_item": ".comment-item.comment-item-sub",
      "total_count": ".total",
      "expand_button": {
        "primary": "text=/展开 \\d+ 条回复/",
        "more": "text=/展开更多回复/"
      }
    },
    "reply": {
      "reply_button": "div.action-reply",
      "input": "textarea.comment-input",
      "submit": "button.submit"
    }
  },
  "kuaishou": {
    "comment_page": {
      "video_btn": ".comment__header__video-btn",
      "drawer": ".drawer.video-list",
      "drawer_content": ".drawer__content",
      "video_item": ".video-item",
      "comment_list": ".auto-load-list",
      "comment_item": ".comment-item",
      "sub_comment_item": ".comment-sub-item",
      "expand_button": "text=/展开查看\\d+条回复/"
    },
    "reply": {
      "reply_button": ".icon-reply",
      "input": "div[contenteditable=\"true\"]",
      "submit": "发送按钮选择器"
    }
  },
  "douyin": {
    "comment_page": {
      "select_video_btn": "button:has-text(\"选择作品\")",
      "comment_container": ".container-sXKyMs",
      "comment_text": ".comment-content-text-JvmAKq",
      "reply_list": ".reply-list-QwXCb_",
      "expand_button": "text=/查看\\d+条回复/",
      "reply_to": ".reply-to-lFblpf"
    },
    "reply": {
      "reply_button": "div.item-M3fSkJ:has-text(\"回复\")",
      "input": "div.input-d24X73[contenteditable]",
      "submit": "发送按钮选择器"
    }
  }
}
```

---

## 八、实施路线

| 阶段 | 文件名 | 内容 | 依赖 |
|------|--------|------|------|
| **Phase 1** | `base_crawler.py` | BaseCommentCrawler 抽象基类 | 无 |
| **Phase 2** | `xiaohongshu_crawler.py` | 小红书爬虫（滚动+展开+提取） | Phase 1 |
| **Phase 3** | `kuaishou_crawler.py` | 快手爬虫（Drawer切换+展开） | Phase 1 |
| **Phase 4** | `douyin_crawler.py` | 抖音爬虫（面板切换+展开） | Phase 1 |
| **Phase 5** | `tasks.py` | ARQ 任务入口 + 全量初始化 | Phase 2-4 |
| **Phase 6** | `comment_selectors.json` | 评论选择器配置 | Phase 2-4 |
| **Phase 7** | `crawlService.ts` + `crawl.ts` | TS 端调度 API | Phase 5 |
| **Phase 8** | `base_reply_engine.py` + 三平台实现 | 拟人化回复引擎 | Phase 5 |
| **Phase 9** | 增量同步逻辑 | incremental_sync + 定时任务 | Phase 5 |
| **Phase 10** | 联调 + 防封控调优 | 延迟/频率/异常处理 | Phase 8-9 |

---

## 九、风险与注意事项

1. **快手签名**：`__NS_sig3` 是浏览器上下文动态生成，爬虫必须在 RoxyBrowser 窗口中运行
2. **小红书 xsec_token**：每次笔记访问需要从创作者平台或通知页获取 xsec_token
3. **抖音 msToken**：ARQ 任务需通过 TS 端 CDP 连接在浏览器窗口内执行，不能独立发 HTTP 请求
4. **Cookie 过期**：长时运行需处理 Cookie 保活，建议每个平台维持专用窗口
5. **评论总数口径差异**：小红书页面显示 commentCount 与实际展开后统计可能有缺口（已删除/隐藏评论），增量检测以实际爬取数为准
6. **速率限制**：爬虫单窗口串行操作，视频间冷却 3-5 秒，回复间冷却 10-30 秒
