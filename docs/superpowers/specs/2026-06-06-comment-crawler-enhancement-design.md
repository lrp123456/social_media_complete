# 评论爬虫增强 + 企业微信通知/回复 — 设计规格

> 版本：v1.0 | 日期：2026-06-06
> 基于项目 v3.0.0 现状，增强现有 Phase 3 评论管道，不另起系统

---

## 零、目标

1. **评论群完整性**：爬取时展开所有子回复，存储完整评论树（根评论 + 所有子回复），确定哪些是新增评论
2. **企业微信通知增强**：用模板卡片（`text_notice` + `button_interaction`）替代当前简陋 markdown，展示完整评论群、标记新增评论
3. **一键回复**：企微端点击按钮触发回复流程，用户发送文本 → 系统在抖音页面上 DOM 执行回复
4. **退出策略修复**：侧边栏目标不在视口时自动滚动

---

## 一、数据库设计

### 1.1 Comment 表增强

现有字段：`id, videoId, cid(唯一), text, userNickname, userUid, diggCount, createTime, replyId, isNew`

新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `rootId` | String? | 根评论 cid（子回复指向顶层评论；根评论为 NULL） |
| `parentId` | String? | 直接父评论 cid（被回复的那条；与 replyId 语义相同） |
| `level` | Int | 1=根评论, 2=子回复 |
| `replyToName` | String? | 被回复用户昵称（如 "张三"） |

`replyId` 保留不删（兼容现有关联逻辑），值与 `parentId` 一致。

### 1.2 VideoRootCommentCount 表（新增）

```prisma
model VideoRootCommentCount {
  id         String   @id @default(uuid())
  videoId    String
  cid        String         // 根评论 cid
  replyCount Int      @default(0)
  updatedAt  DateTime @updatedAt

  @@unique([videoId, cid])
  @@index([videoId])
}
```

**增量优化逻辑**：
- 每次爬取后记录每个根评论的 `replyCount`
- 下次检查：若 `replyCount` 未变 且 该根评论非本次新增 → 跳过"展开回复"DOM 操作
- 大幅减少无效点击/等待

---

## 二、爬虫增强（Phase 3 改造）

### 2.1 新增流程

```
Phase 3 新流程（每个视频）:
  1. openSelectWorkDrawer()          → 打开"选择作品"抽屉
  2. findAndClickVideoInDrawer()     → 定位并点击目标视频（已有）
  3. 等待评论区加载
  4. [新] expandAllReplies()         → DOM 展开所有子回复
     ├── 查询 VideoRootCommentCount → 决定哪些根评论需要展开
     ├── 对需要展开的: 查找"查看N条回复"按钮（selector: selectors.json）
     ├── 逐个点击 → 等待子回复列表出现
     ├── 如果回复区可滚动加载 → scroll → 再次检查展开按钮
     └── 循环直到无展开按钮
  5. [新] 拦截 /comment/list/ 相关 API → 获取完整评论数据
  6. [新] parseCommentTree()         → 解析含层级关系的评论树
  7. 对比 cid 差集 + createTime 过滤 → 确定本次新增评论
  8. 存入 DB（含 rootId/parentId/level/replyToName）
  9. 更新 VideoRootCommentCount
```

### 2.2 评论树解析

```typescript
interface CommentNode {
  cid: string;
  text: string;
  userNickname: string;
  userUid: string;
  createTime: number;
  diggCount: number;
  level: 1 | 2;           // 1=根, 2=子回复
  rootId?: string;         // 根评论 cid
  parentId?: string;       // 直接父评论 cid
  replyToName?: string;    // "回复 @xxx"
}
```

**层级判断**（抖音 DOM 源文件依据）：
- 根评论：无 `.reply-to-lFblpf` 元素
- 子回复：有 `.reply-to-lFblpf` 元素，文本包含 `回复 @xxx`
- 子回复归属：通过 DOM 结构中 `.reply-list-QwXCb_` 的嵌套关系确定 rootId

### 2.3 新增评论判断

1. **cid 差集**：爬取结果 cid − DB 已有 cid = 候选新增
2. **时间过滤**：候选新增中 `createTime > lastSyncTime` = 确认新增
3. **数量验证**：`delta = newTotal - oldTotal`，与差集数量交叉验证

### 2.4 选择器配置

所有新增选择器放入 `apps/ts-api-gateway/data/selectors.json` 的 `douyin` 平台下：

```json
{
  "douyin": {
    "buttons": {
      "btn_expand_replies": {
        "purposes": ["monitor"],
        "primary": "text=/查看\\d+条回复/",
        "fallbacks": ["text=/展开/", "[class*='expand-reply']"],
        "selectorType": "text"
      },
      "btn_reply_comment": {
        "purposes": ["monitor"],
        "primary": "text=/回复/",
        "selectorType": "text"
      },
      "btn_reply_submit": {
        "purposes": ["monitor"],
        "primary": "[class*='submit']",
        "selectorType": "css"
      }
    },
    "regions": {
      "region_reply_list": {
        "purposes": ["monitor"],
        "primary": "[class*='reply-list']",
        "selectorType": "css"
      },
      "region_comment_container": {
        "purposes": ["monitor"],
        "primary": "[class*='container-sXKyMs']",
        "selectorType": "css"
      },
      "region_reply_input": {
        "purposes": ["monitor"],
        "primary": "div[contenteditable]",
        "selectorType": "css"
      }
    }
  }
}
```

选择器通过 `selectorStore.ts` 热更新，无需重启。

---

## 三、企业微信通知与回复

### 3.1 通知消息格式

用 `text_notice` 模板卡片替代当前 markdown 纯文本。

**结构**：
- `source.desc` = "📊 抖音评论更新"
- `emphasis_content` = "N 条新评论" / "来自 M 个视频"
- `horizontal_content_list` = [{视频描述, 新增数量}, ...]
- `quote_area.quote_text` = 完整评论群：
  ```
  张三: 这是真的吗？  🆕
    └ 李四: 同问  🆕
    └ 王五: 假的吧
  ```
  - `🆕` 标记：本次新增评论
  - `└` 缩进：子回复
  - 按 createTime 排序
- `jump_list` / `action_menu` = 回复入口

**关键规则**：
- 每个视频一条卡片消息（不跨视频串频）
- 同一视频多条评论群更新→合并一条
- 仅发送给绑定了企微 userid 的用户

### 3.2 回复流程

```
┌─ 企微端 ───────────────────────┐  ┌─ 系统端 ───────────────────┐
│ 用户看到通知卡片                  │                               │
│   → 点击"回复此评论"按钮          │   → 收到 button_interaction   │
│                                  │      事件回调                  │
│                                  │   → 记录待回复上下文:          │
│                                  │     {videoId, commentCid}      │
│                                  │   → 推送企微消息: "请输入回复内容" │
│                                  │                               │
│ 用户发送文本消息                  │   → messageHandler 匹配       │
│ (如 "感谢支持")                  │      待回复上下文              │
│                                  │   → 通过 CDP 连接浏览器窗口    │
│                                  │   → DOM 定位评论              │
│                                  │   → 点击"回复"按钮            │
│                                  │   → 逐字键入回复文本           │
│                                  │   → 点击发送按钮              │
│                                  │   → 推送企微消息: "✅ 回复成功"  │
└──────────────────────────────────┘  └────────────────────────────┘
```

**回复执行**（在浏览器窗口中）：
1. 通过现有 CDP 连接获取 page
2. `HumanActions.cdpClick` 定位评论的"回复"按钮
3. `HumanActions.cdpType` 逐字键入（50-150ms/字，拟人化）
4. `HumanActions.cdpClick` 点击发送按钮
5. 检测反馈（输入框关闭 = 成功）

回复选择器从 `selectors.json` 读取，外部化可配置。

---

## 四、退出策略修复

**问题**：`executeExitStrategy()` 在 douyin 平台点击侧边栏菜单时，目标元素可能不在视口内，导致 `resolveAndClick` 失败。

**修复**：
1. 在 `tryClickBySelector` 中，对 douyin 平台的 CSS 点击策略之前，检测目标是否在视口内
2. 若不在视口内，定位侧边栏滚动容器并滚动至目标可见
3. 将 `scrollIntoView` 选项从仅快手扩展至 douyin

**实现位置**：`apps/ts-api-gateway/src/crawlers/menuNavigator.ts` `tryClickBySelector()`

**滚动容器选择器**（从 `selectors.json` 读取）：
```json
"douyin": {
  "regions": {
    "region_sidebar_scroll": {
      "purposes": ["monitor", "publish"],
      "primary": ".douyin-creator-master-navigation-list",
      "fallbacks": ["[class*='navigation-list']"],
      "selectorType": "css"
    }
  }
}
```

---

## 五、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `prisma/schema.prisma` | 修改 | Comment 新增 rootId/parentId/level/replyToName；新增 VideoRootCommentCount |
| `apps/ts-api-gateway/data/selectors.json` | 修改 | 新增评论展开/回复相关选择器 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 修改 | Phase 3 增强：expandAllReplies、parseCommentTree、评论树存储 |
| `apps/ts-api-gateway/src/crawlers/menuNavigator.ts` | 修改 | scrollIntoView 扩展至 douyin |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 修改 | sendMonitorNotification 改为模板卡片格式 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 修改 | 新增评论树 upsert、VideoRootCommentCount 操作、回复执行 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 修改 | 新增回复流程消息处理器、待回复上下文管理 |
| `apps/ts-api-gateway/src/routes/wecom-bot.ts` | 可能修改 | 回复事件回调处理 |

---

## 六、测试要点

1. DOM 展开：验证"查看N条回复"按钮定位正确、全部展开（无遗留）
2. 评论树：验证 rootId/parentId/level 正确
3. VideoRootCommentCount：验证增量跳过逻辑生效（replyCount 不变时无点击）
4. 企微通知：验证卡片格式正确、评论群展示完整、🆕标记准确
5. 回复链路：按钮点击→接收文本→DOM 回复→成功反馈
6. 退出策略：验证侧边栏不可见菜单项能正确滚动后点击
7. 选择器热更新：修改 selectors.json 后无需重启生效

---

## 七、风险

1. **抖音 DOM 结构调整**：选择器通过 `selectors.json` 外部化 + fallback 链缓解
2. **大量"查看回复"点击触发风控**：每个视频限制操作次数，间隔随机延迟
3. **企微回复消息长度限制**：企业微信 markdown 消息有 4096 字节限制，超长评论群需截断
4. **待回复上下文并发**：用户可能同时回复多条评论，需维护多条待回复状态（用 commentCid 作为 key）
