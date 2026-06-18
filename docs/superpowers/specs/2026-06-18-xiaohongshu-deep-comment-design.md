# 小红书深度评论采集 + 评论回复 — 设计文档

> 日期：2026-06-18  
> 状态：设计审查  
> 关联文档：`docs/xiaohongshu_comment_detail_research.md`、`docs/xiaohongshu_monitoring_flow.md`

---

## 1. 背景与目标

小红书创作者中心（`creator.xiaohongshu.com`）没有专门的评论管理页面（与抖音/快手不同），因此无法在创作者中心内部直接采集评论树。

当前系统仅支持小红书 **light 模式**（通过笔记列表 API 追踪评论数量变化，不采集评论内容），deep 模式被强制禁用。

### 目标

1. **deep 模式**：支持小红书完整评论树的采集（一级评论 + 子评论），对齐抖音/快手的 Phase 1→2→3 三阶段流水线
2. **评论回复**：支持在笔记评论区执行回复操作（手动回复 + AI 建议回复），对齐抖音 `replyToComment` 流程
3. **视频生命周期管理**：全平台统一处理视频删除、私密化、新增等场景
4. **选择器外置化**：所有涉及的选择器放入 `selectors.json`，优先文本选择器，参考抖音"先定位容器再操作"的模式

### 约束

- 主站（`www.xiaohongshu.com`）与创作者中心（`creator.xiaohongshu.com`）账号不互通，需两次独立登录校验
- 必须通过"点击笔记管理页面的缩略图"方式进入主站（不能直接 `page.goto` 构造 URL）
- 私密视频（`仅自己可见`）的缩略图不可点击跳转，必须提前过滤
- 所有选择器必须外置化到 `selectors.json`，优先文本选择器
- 操作模式：先定位容器，再在容器内定位按钮/元素（参照抖音 `comment_root_container` 模式）

---

## 2. 总体架构

### 2.1 能力矩阵

| 能力 | 入口 | 任务类型 | 说明 |
|------|------|----------|------|
| **Light 监控**（保留）| 调度器定时触发 | `monitor` | 仅追踪评论数变化，创建合成 Comment |
| **Deep 监控**（新增）| 调度器定时触发，`crawl_settings.xiaohongshu='deep'` | `monitor` | Phase 1→2→3，采集完整评论树 |
| **手动回复**（新增）| `POST /api/v1/matrix/monitor/comments/:id/reply` | `reply` | `executeReplyAction` 新增 xiaohongshu 分支 |
| **AI 建议回复**（新增）| `POST /api/v1/matrix/monitor/comments/:id/accept-reply` | `reply` | 采纳 AI 建议后执行回复 |

### 2.2 三阶段监控流水线（Deep 模式）

```
Phase 0: 创作者中心登录态校验
  └─ 失败 → 截 QR 发企微（platform=xiaohongshu 创作者）→ 终止本轮

Phase 1: 笔记列表扫描 + 私密过滤（必须执行，light 模式也用）
  ├─ 拦截 /api/galaxy/v2/creator/note/user/posted
  ├─ 滚动加载至 maxMonitorVideos（默认 20）
  ├─ 从响应解析：id, comments_count, permission_code
  ├─ ★ 关键过滤：仅保留 permission_code === 0（公开）的笔记
  ├─ reconcileVideosForUser（新函数）：upsert 可见视频 + 删除不再可见的视频
  └─ 对比数据库 → 构建 commentsQueue：仅含【评论数增加】的视频

Phase 2: 主站登录态校验（仅 deep 模式且队列非空）
  ├─ context.newPage() 打开 www.xiaohongshu.com
  ├─ 检测登录：region.mainsite-user-avatar 存在？
  ├─ 未登录 → captureAndSendQR（主站标识）→ 关标签页 → 回退 light
  └─ 已登录 → 关标签页 → 进 Phase 3

Phase 3: 串行逐视频采集评论树
  for each item in commentsQueue:
    ├─ 3a locateNoteCard: 定位笔记卡片（def: region.note-card-by-id）
    ├─ 3b clickThumbnailAndWaitNewTab: 监听 popup → 点击缩略图 → 新 page
    ├─ 3c registerCommentInterceptor: 注册 /comment/page + /comment/sub/page
    ├─ 3d scrollLoadRootComments: 滚动 .note-scroller → 翻页到 has_more=false
    ├─ 3e expandSubCommentsForRoots: 遍历 sub_comment_count>0 的根 → 点"展开" → 翻页
    ├─ 3f buildCommentTree: 解析 API 响应 → 构建评论树
    ├─ 3g 入库: upsertCommentTree + upsertRootCommentCounts + deleteStaleRootCounts + updateCommentCount
    ├─ 3h newPage.close() → page.bringToFront()
    └─ 视频间间隔 5-10 秒

Phase 4: 退出策略
  └─ executeExitStrategy
```

### 2.3 Light / Deep 模式对比

| 模式 | Phase 1 | Phase 2 | Phase 3 | 输出 |
|------|---------|---------|---------|------|
| light | ✓（含私密过滤）| ✗ | ✗ | 评论数变化合成 Comment |
| deep  | ✓（含私密过滤）| ✓ | ✓ | 完整评论树入 Comment 表 |

---

## 3. 视频生命周期管理（全平台统一改造）

### 3.1 场景矩阵

| 场景 | 源端状态 | DB 状态 | 期望行为 |
|------|----------|---------|----------|
| A. 新视频发布 | 可见 | 不存在 | 入库（若有评论 → 进队列）|
| B. 视频删除 | 不可见 | 存在 | 删除 DB 记录 |
| C. XHS 改私密 | `permission_code=1` | 存在 | 删除 DB 记录 |
| D. 私密→公开 | `permission_code=0` | 不存在 | 视为新视频 |
| E. 评论数变化 | 可见 | 存在 | 进队列采集 |
| F. 评论数不变 | 可见 | 存在 | 更新元数据 |
| G. 超 maxVideos | 不在源端前 N 条 | 存在 | 删除 |

### 3.2 新增统一函数 `reconcileVideosForUser`

```typescript
/**
 * 协调用户视频列表与 DB，统一处理生命周期（替代 upsertVideosBatch + truncateVideosByUser）
 *
 * 调用方负责传入【已过滤可监控的视频列表】（公开 + 未删除·前 N 条）
 * DB 中存在但不在输入列表中的视频 → 删除（场景 B/C/G 合并处理）
 *
 * 保护机制：若 visibleVideos 为空且 DB 有视频，跳过删除（避免 API 异常误删）
 */
export async function reconcileVideosForUser(
  userId: number,
  visibleVideos: Array<{
    aweme_id: string;
    description: string;
    create_time: number;
    comment_count: number;
    metrics?: any;
  }>,
  maxVideos: number,
): Promise<{
  newVideoIds: string[];
  removedVideoIds: string[];
  unchangedCount: number;
}>
```

**算法（事务内）：**

```
sourceIds = visibleVideos.slice(0, maxVideos).map(v => v.aweme_id)
dbIds = SELECT id FROM videos WHERE userId = ?

if sourceIds.length === 0 && dbIds.length > 0:
  skip deletion (保护机制)
else:
  toRemove = dbIds.filter(id => !sourceIds.includes(id))
  删除 toRemove（级联清理 Comment / VideoCommentRecord 等）
  UPSERT visibleVideos.slice(0, maxVideos)
```

### 3.3 全平台调用方修改

| 平台 | 现在 | 改造后 |
|------|------|--------|
| 抖音 | `upsertVideosBatch + truncateVideosByUser` | `reconcileVideosForUser` |
| 快手 | 同上 | 同上 |
| 视频号 | 同上 | 同上 |
| 小红书 | 同上 + 私密过滤前置 | `permission_code === 0` 过滤 + `reconcileVideosForUser` |

旧函数标记 `@deprecated`，保留向后兼容。

---

## 4. 数据模型

### 4.1 Video 表（无变更）

保持现有 schema：
```prisma
model Video {
  id           String   @id
  userId       Int      @map("user_id")
  description  String   @default("")
  createTime   BigInt   @map("create_time")
  commentCount Int      @default(0) @map("comment_count")
  metrics      String   @default("{}")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  comments Comment[]
}
```

**不引入 `xsecToken`/`permissionCode`/`isPrivate` 字段**——私密视频**永不入库**，`xsec_token` 在 Phase 1 内存中持有。

### 4.2 Comment 表（无变更）

复用现有 schema 的 **`upsertCommentTree`** 函数已有字段。

### 4.3 XHS 评论 API → Comment 表映射

| Comment 字段 | 一级评论（comment/page）| 子评论（sub/page）|
|-------------|----------------------|------------------|
| `cid` | `comment.id` | `sub.id` |
| `level` | 1 | 2 |
| `rootId` | null | 最外层根 `comment.id` |
| `parentId` | null | `sub.target_comment.id` 或 root.id |
| `replyToName` | null | `sub.target_comment.user_info.nickname` |
| `replyId` | "0" | `sub.target_comment.id` 或 root.id |
| `text` | `comment.content` | `sub.content` |
| `userNickname` | `comment.user_info.nickname` | `sub.user_info.nickname` |
| `userUid` | `comment.user_info.user_id` | `sub.user_info.user_id` |
| `diggCount` | `parseInt(comment.like_count, 10)` | `parseInt(sub.like_count, 10)` |
| `createTime` | `Math.floor(comment.create_time / 1000)` | `Math.floor(sub.create_time / 1000)` |
| `isAuthor` | `show_tags.includes('is_author')` | `sub.show_tags.includes('is_author')` |

---

## 5. 选择器配置（22 项新增）

### 5.1 分类清单

**A. 缩略图点击（3 项）**

| 键 | 主选择器 | 类型 | 用途 |
|----|----------|------|------|
| `region.note-card-by-id` | `.note-card[data-impression*="\"noteId\":\"{noteId}\""]` | css | 按 noteId 定位笔记卡片 |
| `region.note-card-cover` | `.note-card__cover .media-body` | css | 缩略图可点击区域 |
| `region.note-card-private-marker` | `getByText("仅自己可见", exact=True)` | text | 私密防护检测 |

**B. 主站登录态检测（3 项）**

| 键 | 主选择器 | 类型 | 用途 |
|----|----------|------|------|
| `region.mainsite-user-avatar` | `.user.side-bar-component` | css | 登录后右上角头像 |
| `region.mainsite-login-modal` | `getByText("登录", exact=True)` | text | 未登录弹窗 |
| `region.mainsite-qr-code` | `.qrcode-img` | css | QR 码图片 |

**C. 评论区容器与采集（9 项）**

| 键 | 主选择器 | 类型 | 用途 |
|----|----------|------|------|
| `region.comments-container` | `.comments-el` | css | 评论区根容器 |
| `region.comment-scroller` | `.note-scroller` | css | 评论滚动容器 |
| `region.comment-total` | `.comments-container .total` | css | "N 条评论"文本 |
| `region.comment-root-container` | `.comment-item:not(.comment-item-sub)` | css | 根评论容器 |
| `region.comment-sub-container` | `.comment-item.comment-item-sub` | css | 子评论容器 |
| `region.comment-author-name` | `.author .name` | css | 作者昵称 |
| `region.comment-content-text` | `.content .note-text` | css | 评论正文 |
| `region.comment-author-tag` | `getByText("作者", exact=True)` | text | 作者标识 |
| `btn.expand-sub-comments` | `getByText("展开")` | text | "展开 N 条回复"按钮 |

**D. 评论回复（5 项）**

| 键 | 主选择器 | 类型 | 用途 |
|----|----------|------|------|
| `btn.reply-comment` | `getByText("回复", exact=True)` | text | 评论的"回复"按钮 |
| `region.reply-input-area` | `.bottom-container [contenteditable="true"]` | css | 回复输入区域 |
| `tb.reply-input` | `.bottom-container [contenteditable="true"]` | css | 回复输入框 |
| `btn.reply-submit` | `getByText("发送", exact=True)` | text | 发送按钮 |
| `btn.reply-cancel` | `getByText("取消", exact=True)` | text | 取消按钮 |

**E. 笔记管理页定位（2 项，已有基础上补充 key mapping）**

### 5.2 menuSelectors.ts 键映射

```typescript
'region.note-card-by-id': 'region_note_card_by_id',
'region.note-card-cover': 'region_note_card_cover',
'region.note-card-private-marker': 'region_note_card_private_marker',
'region.mainsite-user-avatar': 'region_mainsite_user_avatar',
'region.mainsite-login-modal': 'region_mainsite_login_modal',
'region.mainsite-qr-code': 'region_mainsite_qr_code',
'region.comments-container': 'region_comments_container',
'region.comment-scroller': 'region_comment_scroller',
'region.comment-total': 'region_comment_total',
'region.comment-root-container': 'region_comment_root_container',
'region.comment-sub-container': 'region_comment_sub_container',
'region.comment-author-name': 'region_comment_author_name',
'region.comment-content-text': 'region_comment_content_text',
'region.comment-author-tag': 'region_comment_author_tag',
'region.reply-input-area': 'region_reply_input_area',
'btn.expand-sub-comments': 'btn_expand_sub_comments',
'btn.reply-comment': 'btn_reply_comment',
'btn.reply-submit': 'btn_reply_submit',
'btn.reply-cancel': 'btn_reply_cancel',
'tb.reply-input': 'tb_reply_input',
```

### 5.3 操作模式（参照抖音）

> 先定位容器 → 在容器内查找/操作元素 → 文本选择器优先

```typescript
// 示例：展开子评论
const rootContainer = newPage.locator('[id="comment-{cid}"]').first();
const expandBtn = rootContainer.locator('text=展开').first();
await HumanActions.cdpHumanClick(newPage, expandBtn);
```

---

## 6. 评论回复流程

### 6.1 入口

`apps/ts-api-gateway/src/services/monitorService.ts` 中 `executeReplyAction` 新增 'xiaohongshu' 分支，委托给 `xiaohongshuCrawler.replyToComment`。

### 6.2 回复 6 阶段

```
Phase 1: 数据准备（executeReplyAction 中完成）
Phase 2: 进入笔记详情页（与监控路径一致：creator→缩略图→新标签页）
Phase 3: 评论定位（cid 强主键 + 文本 + 昵称三重匹配）
Phase 4: 点击回复按钮（容器内 btn.reply-comment）
Phase 5: 输入内容并发送（cdpInputText + 点击 btn.reply-submit）
Phase 6: 退出（关标签页 + bringToFront）
```

### 6.3 ReplyTarget 接口（共享化）

从 `douyinCrawler.ts` 提取到 `apps/ts-api-gateway/src/crawlers/replyTypes.ts`，新增 `cid` 字段：

```typescript
export interface ReplyTarget {
  cid?: string;              // ★ XHS 强主键
  text: string;
  level: 1 | 2;
  username: string;
  subReplyCount?: number;
  rootText?: string;
  rootUsername?: string;
  rootSubReplyCount?: number;
  createTime?: number;
}
```

---

## 7. 配置与集成

### 7.1 解除 deep 模式限制

- `routes/matrix.ts`: 移除 `platform === 'xiaohongshu' && mode === 'deep'` 的拒绝逻辑
- `monitorService.ts`: `runXiaohongshuCheck` 移除强制 light，改为 `const crawlMode = await db.getCrawlMode('xiaohongshu')`
- 默认模式仍为 `light`，需用户显式切换

### 7.2 QR 登录集成

- 创作者中心未登录：复用现有 `captureAndSendQR`（platform='xiaohongshu'）
- 主站未登录：新增选择器，captureAndSendQR 选择器列表扩展 `xiaohongshu_main` 条目

### 7.3 集成点清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `prisma/schema.prisma` | 无变更 | — |
| `monitorDatabaseService.ts` | 新增 `reconcileVideosForUser` | 旧函数 `@deprecated` |
| `replyTypes.ts` | **新建** | 共享 ReplyTarget 接口 |
| `douyinCrawler.ts` | 修改 | reconcileVideosForUser + 共享 ReplyTarget 导入 |
| `kuaishouCrawler.ts` | 修改 | 同上 |
| `tencentCrawler.ts` | 修改 | 同上 |
| `xiaohongshuCrawler.ts` | **大改** | 新增 Phase 2/3 + replyToComment + 私密过滤 |
| `menuSelectors.ts` | 修改 | CRAWLER_KEY_MAP 新增 22 个键 |
| `selectors.json` | 修改 | XHS 节点新增 22 条目 |
| `monitorService.ts` | 修改 | runXiaohongshuCheck 三阶段 + executeReplyAction XHS 分支 |
| `routes/matrix.ts` | 修改 | 移除 deep 模式拒绝 |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| xsec_token 短时效 | Phase 1 每 cycle 重新拉取，不落库 |
| 缩略图 popup 超时 | timeout=15s，超时跳过该视频 |
| reconcileVideosForUser 误删 | 保护机制：source 为空且 DB 有数据时跳过删除 |
| 主站风控 | 30 分钟冷却 + 视频间 5-10s 间隔 |
| 子评论渐进分页 | 循环判断展开按钮是否继续存在 → 不存在即加载完毕 |
| 恢复发送验证 | 三种验证方式：API code=0 / DOM 新评论 / 输入框清空（任一即可）|

---

## 9. 实施阶段

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P0** | 新增 `reconcileVideosForUser` + 保护机制 | — |
| **P1** | 全平台调用方迁移到新函数 | P0 |
| **P2** | XHS Phase 1 私密过滤 + 解除 deep 限制 | P1 |
| **P3** | selectors.json + menuSelectors.ts 新增 22 键 | P2 |
| **P4** | replyTypes.ts 共享接口 + 更新 import | P3 |
| **P5** | XHS Phase 2 主站登录校验 + QR 流程 | P3 |
| **P6** | XHS Phase 3 评论树采集 | P5 |
| **P7** | XHS replyToComment | P6 |
| **P8** | 端到端验证 | P7 |

---

## 10. 废弃的设计决策

1. ~~Video 表新增 `xsecToken`/`permissionCode`/`isPrivate` 字段~~ → 私密视频不入库，可见性在 Phase 1 API 解析时过滤
2. ~~通过 `page.goto` 直接导航到主站~~ → 必须点击缩略图（主站与 creator 账号不互通）
3. ~~每个视频独开新标签页~~ → 保留该方案（串行单击逐个采集）
