# 简单采集模式 + 评论上限设计规格

**日期**: 2026-06-23
**状态**: 已批准
**作者**: 矩阵智能运营系统

---

## 1. 目标

### 1.1 简单采集模式
- 仅采集根评论内容，不采集子评论内容
- 通过总评论数变化判断是否需要采集根评论
- 大幅减少资源消耗（从 30-120 秒/视频降至 5-15 秒/视频）

### 1.2 评论上限
- 每个视频最多采集 30 条根评论（按时间倒序）
- 超过 30 条的视频仅采集最新 30 条

---

## 2. 核心流程

### 2.1 简单模式 Phase3 流程（每个视频）

```
┌─────────────────────────────────────────────────────────┐
│ 阶段二（视频列表）：获取每个视频的总评论数                    │
│   → 总评论数无变化 → 跳过，不采集                          │
│   → 总评论数有变化 → 进入阶段三采集根评论                    │
│                                                          │
│ 阶段三（根评论采集）：                                     │
│   1. 滚动加载根评论（最多 30 条）                           │
│   2. 停止条件：                                           │
│      - API 返回 has_more=0                                │
│      - 已收集 ≥30 条                                      │
│      - 连续 5 次滚动无新 API 响应                          │
│   3. 筛选新根评论：                                        │
│      - 评论时间 > 上次视频监控时间                          │
│      - 且不在已采集的根评论中                               │
│   4. 有新根评论 → 存储 + AI 回复 + 企微通知                 │
│   5. 无新根评论 → 静默（新评论可能是子评论）                 │
└─────────────────────────────────────────────────────────┘
```

### 2.2 停止条件（四平台统一）

满足任一即停止滚动：
1. 抖音: `body.has_more === 0`
   快手: `data.pcursor` 为空/undefined
   小红书: `data.has_more === false`
   视频号: `data.downContinueFlag === 0`
2. 已收集根评论数 ≥ `max_root_comments`（默认 30）
3. 连续 5 次滚动无新 API 响应

### 2.3 新根评论判定

新根评论 = 同时满足以下两个条件：
1. `createTime > lastCheckTime`（上次视频监控时间）
2. `cid` 不在 DB 已有的根评论 cid 集合中

---

## 3. 四平台 API 字段映射

### 3.1 根评论列表

| 平台 | 根评论列表路径 |
|------|---------------|
| 抖音 | `body.comments` |
| 快手 | `data.list` |
| 小红书 | `data.comments` |
| 视频号 | `data.comment` |

### 3.2 has_more 判断

| 平台 | has_more 字段 | 有更多 | 无更多 |
|------|--------------|--------|--------|
| 抖音 | `body.has_more` | `1` | `0` |
| 快手 | `data.pcursor` | 有值（非空） | 空/undefined |
| 小红书 | `data.has_more` | `true` | `false` |
| 视频号 | `data.downContinueFlag` | `≠0` | `0` |

### 3.3 cursor 字段

| 平台 | cursor 字段 |
|------|------------|
| 抖音 | `body.cursor` |
| 快手 | `data.pcursor` |
| 小红书 | `data.cursor` |
| 视频号 | `data.lastBuff` |

### 3.4 评论字段映射

| 平台 | cid | text | userNickname | userUid | diggCount | createTime |
|------|-----|------|--------------|---------|-----------|------------|
| 抖音 | `cid` | `text` | `user.nickname` | `user.uid` | `digg_count` | `create_time` |
| 快手 | `commentId` | `content` | `authorName` | `authorId` | `likedCount` | `timestamp` |
| 小红书 | `id` | `content` | `user_info.nickname` | `user_info.user_id` | `like_count` | `create_time` |
| 视频号 | `commentId` | `commentContent` | `commentNickname` | `username` | `commentLikeCount` | `commentCreatetime` |

---

## 4. 配置结构

### 4.1 config-automation.ts

```typescript
{
  collect: {
    mode: 'simple' | 'deep',        // 默认 'simple'
    max_root_comments: 30,           // 默认 30
  }
}
```

### 4.2 API 端点

```
GET  /api/v1/config-automation
PUT  /api/v1/config-automation
```

---

## 5. 数据库变更

### 5.1 Comment 模型（无新增字段）

现有字段已足够：
- `cid`: 评论唯一标识
- `videoId`: 视频 ID
- `text`: 评论内容
- `userNickname`: 用户昵称
- `userUid`: 用户 UID
- `diggCount`: 点赞数
- `createTime`: 评论时间（BigInt）
- `level`: 评论层级（1=根评论）
- `isNew`: 是否新评论（0/1）

### 5.2 VideoRootCommentCount 模型（已有）

用于存储根评论快照：
- `videoId`: 视频 ID
- `rootCid`: 根评论 CID
- `replyCount`: 子评论数量（简单模式下不使用）

---

## 6. 前端展示

### 6.1 评论列表

- 按 `createTime` 倒序（最新在前）
- `isNew=0`：灰色（首次爬取）
- `isNew=1`：标红（增量检测到的新评论）

### 6.2 配置页面

- 新增"采集模式"切换（简单/深度）
- 新增"根评论上限"输入框（默认 30）

---

## 7. 企微通知（复用现有逻辑）

检测到新根评论 → 调用 `notifyNewComments()`：
1. 构建评论树（根评论 + 子评论数量标记）
2. AI 生成回复建议
3. 发送企微卡片通知

---

## 8. 实现范围

### 8.1 需要修改的文件

1. **config-automation.ts**: 添加 `collect` 配置
2. **douyinCrawler.ts**: 简单模式 Phase3 逻辑
3. **kuaishouCrawler.ts**: 简单模式 Phase3 逻辑
4. **xiaohongshuCrawler.ts**: 简单模式 Phase3 逻辑
5. **tencentCrawler.ts**: 简单模式 Phase3 逻辑
6. **monitorService.ts**: 配置读取 + 模式判断
7. **前端页面**: 配置 UI + 评论展示

### 8.2 不需要修改的部分

- 数据库模型（已支持）
- 企微通知逻辑（复用）
- AI 回复建议（复用）

---

## 9. 验收标准

1. 简单模式下，每个视频采集时间 ≤ 15 秒
2. 评论上限 30 条生效
3. 新根评论正确触发企微通知
4. 总评论数无变化时跳过采集
5. 前端配置切换正常工作
