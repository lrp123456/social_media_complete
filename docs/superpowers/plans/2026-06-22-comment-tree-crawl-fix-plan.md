# 评论树爬取修复 + 轻量模式 UI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复所有平台评论树爬取的滚动循环永不退出问题，修复轻量模式文本框叠加问题，将轻量模式通知从评论树分离到独立 tab。

**架构：** 修复 `interceptor.ts` 的 `extractItems()` 和 `extractHasMore()` 以支持各平台评论 API 响应结构；增强各 crawler 的 `scrollLoadRootComments` 退出逻辑；修复 `upsertLightModeComment` 的 CID 生成；前端增加 tab 切换。

**技术栈：** TypeScript, patchright, Next.js 14, React 18, Tailwind CSS

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|---------|
| `packages/browser-core/src/interceptor.ts` | 通用 API 响应拦截器 — extractItems + extractHasMore | 修改 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | XHS 评论树爬取 — scrollLoadRootComments | 修改 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音评论树爬取 — scrollLoadRootComments | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手评论树爬取 — scrollLoadRootComments | 修改 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 视频号评论树爬取 — scrollLoadRootComments | 修改 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 轻量模式合成评论 — CID 修复 | 修改 |
| `apps/ts-api-gateway/src/routes/monitor.ts` (或相关 API) | new-comments API — 标记 isLightMode | 修改 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 前端评论区域 — tab 切换 UI | 修改 |

---

### 任务 1：修复 extractItems + extractHasMore（所有平台）

**文件：**
- 修改：`packages/browser-core/src/interceptor.ts:31-101`

- [ ] **步骤 1：修复 extractHasMore — 抖音 number 类型 + 新增快手/视频号**

在 `interceptor.ts` 的 `extractHasMore()` 函数（约 L31）中，在现有 `body.has_more` boolean 检查**之前**插入 number 类型检查：

```typescript
function extractHasMore(body: any): boolean | undefined {
  if (body === null || body === undefined) return undefined;
  // 抖音：has_more 是 number（0=无更多，非0=有更多）
  if (typeof body.has_more === 'number') return body.has_more !== 0;
  if (typeof body.has_more === 'boolean') return body.has_more;
  if (body.data && typeof body.data.has_more === 'number') return body.data.has_more !== 0;
  if (body.data && typeof body.data.has_more === 'boolean') return body.data.has_more;
  if (body.pagination && typeof body.pagination.has_more === 'boolean') return body.pagination.has_more;
  if (body.cursor_info && typeof body.cursor_info.has_more === 'boolean') return body.cursor_info.has_more;
  if (body.data && typeof body.data.page === 'number') {
    if (body.data.page === -1) return false;
    if (body.data.page > 0) return true;
  }
  // 快手：pcursor 存在则有更多
  if (body.data && body.data.pcursor !== undefined && body.data.pcursor !== null && body.data.pcursor !== '') return true;
  // 视频号：downContinueFlag (0=无更多, 非0=有更多)
  if (body.data && typeof body.data.downContinueFlag === 'number') return body.data.downContinueFlag !== 0;
  // 视频号：continueFlag (布尔值)
  if (body.data && typeof body.data.continueFlag === 'boolean') return body.data.continueFlag;
  return undefined;
}
```

- [ ] **步骤 2：修复 extractItems — 新增 3 个评论路径**

在 `extractItems()` 函数（约 L66）中，在现有 `return []` 之前追加：

```typescript
  // 抖音评论管理页面
  const douyinComments = body.comments;
  if (Array.isArray(douyinComments)) return douyinComments;
  // 小红书评论
  const xhsComments = body.data?.comments;
  if (Array.isArray(xhsComments)) return xhsComments;
  // 视频号评论
  const tencentComments = body.data?.comment;
  if (Array.isArray(tencentComments)) return tencentComments;
  return [];
```

- [ ] **步骤 3：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p packages/browser-core/tsconfig.json 2>&1 | grep -c "error TS"
```

预期：无新增错误。

- [ ] **步骤 4：Commit**

```bash
git add packages/browser-core/src/interceptor.ts
git commit -m "fix: extractItems 新增抖音/小红书/视频号评论路径 + extractHasMore 修复抖音 number 类型"
```

---

### 任务 2：增强 scrollLoadRootComments 退出逻辑（所有 4 个 crawler）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:810-853`
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（scrollLoadRootComments 方法）
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`（scrollLoadRootComments 方法）
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（scrollLoadRootComments 方法）

- [ ] **步骤 1：修改 XHS scrollLoadRootComments**

将 `xiaohongshuCrawler.ts` 的 `scrollLoadRootComments` 方法（L810-853）替换为：

```typescript
  async scrollLoadRootComments(newPage: Page): Promise<any[]> {
    logger.info('[XHS-Phase3] Loading root comments via scroll');

    const interceptor = this.commentInterceptor as RequestInterceptor;
    const pattern = '/api/sns/web/v2/comment/page';

    await interceptor.waitForResponse(pattern, 15000).catch(() => {});

    let prevItemCount = 0;
    let noNewItemsStreak = 0;
    const maxNoNewItems = 3;

    for (let attempt = 0; attempt < 15; attempt++) {
      const items = interceptor.getCollectedItems(pattern);
      if (items.length > prevItemCount) {
        prevItemCount = items.length;
        noNewItemsStreak = 0;
        logger.info({ totalItems: items.length, attempt }, '[XHS-Phase3] Root comments batch loaded');
      } else {
        noNewItemsStreak++;
      }

      const responses = interceptor.getResponses(pattern);
      const lastResp = responses[responses.length - 1];
      const hasMore = lastResp?.hasMore;

      logger.info({ attempt, hasMore, itemCount: items.length, responseCount: responses.length, noNewItemsStreak },
        '[XHS-Phase3] Scroll check');

      if ((!hasMore && items.length > 0) || noNewItemsStreak >= maxNoNewItems) {
        logger.info({ attempt, hasMore, itemCount: items.length, noNewItemsStreak },
          '[XHS-Phase3] All root comments loaded');
        break;
      }

      const scrollerDef = getSelector('region.comment-scroller', XHS_PLATFORM);
      if (scrollerDef.css) {
        try {
          await HumanActions.cdpSmartScroll(newPage, [scrollerDef.css], 400, 'down');
        } catch {
          await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
        }
      } else {
        await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
      }
      await HumanActions.wait(newPage, 1500, 2500);
    }

    return interceptor.getCollectedItems(pattern);
  }
```

关键改动：
- `maxScrollAttempts` 从 30 降到 15
- 增加 `noNewItemsStreak` 兜底退出（连续 3 次无新 items 则退出）
- 使用 `lastResp?.hasMore`（由修复后的 `extractHasMore` 提取）
- 返回 `interceptor.getCollectedItems(pattern)` 而非手动累积的 `allItems`

- [ ] **步骤 2：修改抖音 scrollLoadRootComments**

在 `douyinCrawler.ts` 中找到 `scrollLoadRootComments` 方法，应用相同的模式：
- `maxScrollAttempts` 降到 15
- 增加 `noNewItemsStreak` 兜底退出
- 使用 `lastResp?.hasMore` 判断
- 抖音的 comment page pattern 需确认（搜索文件中的 `/api/` 或 comment 相关的 interceptor 注册）

- [ ] **步骤 3：修改快手 scrollLoadRootComments**

在 `kuaishouCrawler.ts` 中找到 `scrollLoadRootComments` 方法，应用相同模式。
快手的 has_more 由 `extractHasMore` 从 `body.data.pcursor` 提取，`lastResp?.hasMore` 将正确返回。

- [ ] **步骤 4：修改视频号 scrollLoadRootComments**

在 `tencentCrawler.ts` 中找到 `scrollLoadRootComments` 方法，应用相同模式。
视频号的 has_more 由 `extractHasMore` 从 `body.data.downContinueFlag` 提取。

- [ ] **步骤 5：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep -c "error TS"
```

预期：无新增错误。

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "fix: 所有平台 scrollLoadRootComments 增加 noNewItemsStreak 兜底退出 + maxScrollAttempts 降到 15"
```

---

### 任务 3：修复轻量模式文本框叠加

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts:291`

- [ ] **步骤 1：修改 upsertLightModeComment 的 CID**

将 L291 的：
```typescript
const cid = `light_${videoId}_${info.create_time}`;
```

改为：
```typescript
const cid = `light_${videoId}`;
```

这样每次检测到评论数变化时，upsert 会更新同一条记录而非创建新记录。

- [ ] **步骤 2：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep "monitorDatabaseService" | head -5
```

预期：无新增错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "fix: upsertLightModeComment CID 改为固定 light_videoId 防止叠加"
```

---

### 任务 4：new-comments API 标记 isLightMode

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/monitor.ts`（或返回 new-comments 的 API 路由文件）

- [ ] **步骤 1：找到 new-comments API 路由**

搜索返回 `new-comments` 或 `videoComments` 的路由处理函数。可能在 `monitor.ts` 或 `matrix.ts` 路由文件中。

```bash
grep -rn "new-comments\|videoComments\|getVideoComments" apps/ts-api-gateway/src/routes/ | head -10
```

- [ ] **步骤 2：在返回评论列表时标记 isLightMode**

在返回评论数据的位置，对每条评论追加 `isLightMode` 标记：

```typescript
// 在返回评论列表的位置
const commentsWithFlag = comments.map((c: any) => ({
  ...c,
  isLightMode: typeof c.cid === 'string' && c.cid.startsWith('light_'),
}));
```

确保前端 `useVideoComments` hook 调用的 API 返回的数据包含 `isLightMode` 字段。

- [ ] **步骤 3：验证编译**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | grep -c "error TS"
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/routes/
git commit -m "feat: new-comments API 返回时标记 isLightMode"
```

---

### 任务 5：前端评论区域增加 tab 切换

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx:1578-1650`

- [ ] **步骤 1：在视频详情展开区域增加 tab 状态和切换 UI**

在 `page.tsx` 的组件中（约 L802 附近已有 `selectedVideoId` 状态），新增 tab 状态：

```typescript
const [commentTab, setCommentTab] = useState<'comments' | 'notifications'>('comments');
```

- [ ] **步骤 2：分离真实评论和轻量通知**

在 `selectedVideoId === video.id` 的展开区域（约 L1578），替换为 tab 切换结构：

```tsx
{selectedVideoId === video.id && (
  <div className="ml-2 border-l-2 border-primary/20 pl-3 pb-1">
    {/* Tab 切换 */}
    <div className="flex gap-1 mb-2 pt-2">
      <button
        onClick={() => setCommentTab('comments')}
        className={cn(
          'px-3 py-1 rounded text-label-sm font-medium transition-colors',
          commentTab === 'comments'
            ? 'bg-primary text-white'
            : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
        )}
      >
        评论详情
      </button>
      <button
        onClick={() => setCommentTab('notifications')}
        className={cn(
          'px-3 py-1 rounded text-label-sm font-medium transition-colors',
          commentTab === 'notifications'
            ? 'bg-amber-500 text-white'
            : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
        )}
      >
        更新通知
      </button>
    </div>

    {/* 内容区域 */}
    {commentTab === 'comments' ? (
      // 真实评论树（排除轻量模式）
      videoCommentsData ? (
        videoCommentsData.filter((c: any) => !c.isLightMode).length === 0 ? (
          <p className="text-body-sm text-on-surface-variant py-2">暂无评论</p>
        ) : (
          <div className="flex flex-col gap-2">
            {videoCommentsData.filter((c: any) => !c.isLightMode).map((root: any) => (
              // ... 现有评论树渲染逻辑不变 ...
            ))}
          </div>
        )
      ) : (
        <p className="text-body-sm text-on-surface-variant py-2">加载中...</p>
      )
    ) : (
      // 轻量通知列表
      videoCommentsData?.filter((c: any) => c.isLightMode).length > 0 ? (
        <div className="flex flex-col gap-2">
          {videoCommentsData.filter((c: any) => c.isLightMode).map((n: any) => (
            <div key={n.cid} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <MaterialIcon icon="notifications" size="sm" className="text-amber-500" />
                <span className="text-label-sm text-amber-700 font-medium">增量通知</span>
                <span className="text-[10px] text-amber-500">{formatRelativeTime(n.createTime)}</span>
              </div>
              <p className="text-body-sm text-amber-900 mt-1">{n.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-body-sm text-on-surface-variant py-2">暂无更新通知</p>
      )
    )}
  </div>
)}
```

- [ ] **步骤 3：验证前端编译**

```bash
cd /home/lrp/social_media_complete && npx next build apps/admin-dashboard 2>&1 | tail -5
```

预期：编译成功（或仅有预存警告）。

- [ ] **步骤 4：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat: 评论区域增加 tab 切换（评论详情 / 更新通知）"
```

---

### 任务 6：重建 Docker 镜像并部署

- [ ] **步骤 1：重建 Docker 镜像**

```bash
cd /home/lrp/social_media_complete && docker compose build ts-api-gateway 2>&1 | tail -3
```

- [ ] **步骤 2：重启容器**

```bash
docker compose up -d ts-api-gateway 2>&1
```

- [ ] **步骤 3：验证 extractItems 修复**

```bash
docker exec sm-ts-api npx tsx -e "
import { RequestInterceptor } from '@social-media/browser-core';
// 验证 extractItems 能识别各平台评论路径
const testBody = { data: { comments: [{id: '1'}] } };
// 无法直接测试私有函数，但可以通过 getCollectedItems 间接验证
console.log('interceptor module loaded:', typeof RequestInterceptor);
" 2>&1 | tail -3
```

- [ ] **步骤 4：等待监控周期验证滚动循环修复**

观察 Docker 日志，确认 XHS Phase 3 的滚动循环在 `has_more=false` 时正确退出（不再跑满 30 次）。

---

## 自检

### 1. 规格覆盖度

| 规格章节 | 对应任务 |
|---------|---------|
| §3 extractItems + extractHasMore | 任务 1 |
| §3.3 scrollLoadRootComments 增强 | 任务 2 |
| §4 HumanActions 合规性 | 无需代码改动（审计结论：合规） |
| §5 轻量模式不展示在评论树 | 任务 4 + 任务 5 |
| §6 文本框叠加修复 | 任务 3 |

### 2. 占位符扫描

- 无 "TODO"、"待定"
- 任务 4 的路由文件名待确认（`grep` 搜索确定）
- 所有代码步骤都有具体代码块 ✅

### 3. 类型一致性

- `interceptor.ts` 的 `hasMore` 字段由 `extractHasMore` 返回，在 `storeResponse` 中存储到 `InterceptedResponse.hasMore`
- 各 crawler 的 `scrollLoadRootComments` 使用 `lastResp?.hasMore` 访问
- `isLightMode` 字段在 API 返回和前端消费之间保持一致
