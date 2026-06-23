# 一键恢复功能设计规格

**日期**: 2026-06-23
**状态**: 已批准（Oracle 审查通过）
**作者**: 矩阵智能运营系统

---

## 1. 目标

在前端监控页面添加三个一键操作功能，方便批量管理监控状态：

1. **一键恢复所有用户** — 启用所有已暂停的监控用户
2. **各用户所有平台恢复** — 启用监控 + 重置状态为 `init`
3. **各用户所有平台清空数据** — 清空视频、评论、监控状态 + 重置用户状态

---

## 2. 功能定义

| 功能 | 操作 | 影响范围 |
|------|------|----------|
| 一键恢复所有用户 | 启用所有已暂停的监控用户 + 重置调度器 | 所有 User 记录 |
| 各用户所有平台恢复 | 启用监控 + 重置状态为 `init` + 重置调度器 | 单个窗口的所有平台 |
| 各用户所有平台清空数据 | 清空视频、评论、监控状态 + 重置用户状态 | 单个窗口的所有平台 |

---

## 3. API 设计

### 3.1 一键恢复所有用户

**端点**: `POST /api/v1/matrix/monitor/accounts/enable-all`

**请求**: 无参数

**响应**:
```json
{
  "success": true,
  "data": {
    "enabledCount": 12
  }
}
```

**实现逻辑**:
```typescript
// 1. 查询所有已暂停的用户
const pausedUsers = await prisma.user.findMany({
  where: { monitoringEnabled: false },
  select: { id: true, fingerprintWindowId: true, platform: true },
});

// 2. 批量启用
await prisma.user.updateMany({
  where: { monitoringEnabled: false },
  data: { monitoringEnabled: true },
});

// 3. 重置调度器
for (const user of pausedUsers) {
  resetSchedulerTimer(user.fingerprintWindowId, user.platform);
}

// 4. 写入操作日志
await prisma.operationLog.create({
  data: {
    action: 'monitor_enable_all',
    details: JSON.stringify({ enabledCount: pausedUsers.length }),
    userId: 'system',
    userName: '一键恢复',
    result: 'success',
    level: 'info',
  },
});
```

### 3.2 恢复用户所有平台

**端点**: `POST /api/v1/matrix/monitor/accounts/:userId/restore-all`

**路径参数**: `userId` — 用户 ID

**响应**:
```json
{
  "success": true,
  "data": {
    "userId": 20,
    "updatedCount": 4
  }
}
```

**实现逻辑**:
```typescript
// 1. 获取用户所在窗口
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: { fingerprintWindowId: true },
});

// 2. 重置该窗口下所有用户（不限平台）
const result = await prisma.user.updateMany({
  where: { fingerprintWindowId: user.fingerprintWindowId },
  data: {
    status: 'init',
    monitoringEnabled: true,
    cooldownUntil: 0,
    consecutiveNoUpdate: 0,
    platformAuthorId: null,
    platformAuthorName: null,
  },
});

// 3. 重置调度器
const allUsers = await prisma.user.findMany({
  where: { fingerprintWindowId: user.fingerprintWindowId },
  select: { fingerprintWindowId: true, platform: true },
});
for (const u of allUsers) {
  resetSchedulerTimer(u.fingerprintWindowId, u.platform);
}

// 4. 写入操作日志
await prisma.operationLog.create({
  data: {
    action: 'monitor_restore_all_platforms',
    details: JSON.stringify({ userId, windowId: user.fingerprintWindowId, updatedCount: result.count }),
    userId: 'system',
    userName: '恢复所有平台',
    result: 'success',
    level: 'info',
  },
});
```

### 3.3 清空用户所有数据

**端点**: `POST /api/v1/matrix/monitor/accounts/:userId/clear-all`

**路径参数**: `userId` — 用户 ID

**响应**:
```json
{
  "success": true,
  "data": {
    "userId": 20,
    "deletedVideos": 15,
    "deletedComments": 230
  }
}
```

**实现逻辑**:
```typescript
// 1. 获取用户所在窗口
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: { fingerprintWindowId: true },
});

// 2. 获取该窗口下所有用户 ID
const windowUsers = await prisma.user.findMany({
  where: { fingerprintWindowId: user.fingerprintWindowId },
  select: { id: true },
});
const userIds = windowUsers.map(u => u.id);

// 3. 取消正在运行的 BullMQ 任务
const activeJobs = await monitorQueue.getJobs(['waiting', 'active', 'delayed']);
for (const job of activeJobs) {
  if (userIds.includes(job.data.userId)) {
    await job.remove().catch(() => {});
  }
}

// 4. 使用事务清空数据
const [deletedComments, deletedVideos, deletedRootCounts, deletedCommentRecords, deletedCommentCounts, deletedMonitorStatus] = await prisma.$transaction([
  // 删除评论
  prisma.comment.deleteMany({
    where: { videoId: { in: await prisma.video.findMany({ where: { userId: { in: userIds } }, select: { id: true } }).then(v => v.map(v => v.id)) } },
  }),
  // 删除视频
  prisma.video.deleteMany({ where: { userId: { in: userIds } } }),
  // 删除根评论计数
  prisma.videoRootCommentCount.deleteMany({
    where: { videoId: { in: await prisma.video.findMany({ where: { userId: { in: userIds } }, select: { id: true } }).then(v => v.map(v => v.id)) } },
  }),
  // 删除评论记录
  prisma.videoCommentRecord.deleteMany({
    where: { videoId: { in: await prisma.video.findMany({ where: { userId: { in: userIds } }, select: { id: true } }).then(v => v.map(v => v.id)) } },
  }),
  // 删除评论计数
  prisma.videoCommentCount.deleteMany({
    where: { videoId: { in: await prisma.video.findMany({ where: { userId: { in: userIds } }, select: { id: true } }).then(v => v.map(v => v.id)) } },
  }),
  // 删除监控状态
  prisma.monitorStatus.deleteMany({
    where: { accountId: { in: userIds.map(id => String(id)) } },
  }),
]);

// 5. 重置用户状态
await prisma.user.updateMany({
  where: { fingerprintWindowId: user.fingerprintWindowId },
  data: {
    status: 'init',
    monitoringEnabled: true,
    cooldownUntil: 0,
    consecutiveNoUpdate: 0,
    platformAuthorId: null,
    platformAuthorName: null,
  },
});

// 6. 写入操作日志
await prisma.operationLog.create({
  data: {
    action: 'monitor_clear_all_user_data',
    details: JSON.stringify({
      userId,
      windowId: user.fingerprintWindowId,
      deletedVideos: deletedVideos.count,
      deletedComments: deletedComments.count,
    }),
    userId: 'system',
    userName: '清空所有数据',
    result: 'success',
    level: 'info',
  },
});
```

---

## 4. 前端设计

### 4.1 监控概览操作栏

在现有操作栏中新增按钮：

```tsx
<button onClick={enableAllUsers} className="btn-primary">
  一键恢复所有用户
</button>
```

**位置**: 在"立即更新全部"按钮旁边

**交互**:
- 点击后调用 `POST /matrix/monitor/accounts/enable-all`
- 成功后显示 toast: "已启用 X 个监控用户"
- 自动刷新监控列表

### 4.2 用户卡片操作

在每个用户卡片的操作区域新增两个按钮：

```tsx
<button onClick={() => restoreAllPlatforms(userId)} className="btn-secondary">
  恢复所有平台
</button>
<button onClick={() => setShowClearConfirm(true)} className="btn-danger">
  清空所有数据
</button>
```

**位置**: 在现有"更新"/"暂停"按钮下方

**交互**:
- "恢复所有平台": 直接调用 API，成功后刷新
- "清空所有数据": 弹出二次确认对话框，确认后调用 API

### 4.3 二次确认对话框

```tsx
{showClearConfirm && (
  <div className="confirm-dialog">
    <p>确定要清空该用户的所有数据吗？</p>
    <p>此操作将删除：</p>
    <ul>
      <li>所有视频记录</li>
      <li>所有评论记录</li>
      <li>监控状态</li>
    </ul>
    <p>此操作不可撤销！</p>
    <button onClick={confirmClear} disabled={clearCountdown > 0}>
      {clearCountdown > 0 ? `确认清空 (${clearCountdown}s)` : '确认清空'}
    </button>
    <button onClick={() => { setShowClearConfirm(false); setClearCountdown(0); }}>
      取消
    </button>
  </div>
)}
```

**安全措施**: 确认按钮默认禁用 3 秒倒计时，防止误触。

### 4.4 Hook 命名

```typescript
// 新增 hooks
useEnableAllUsers()           // POST /matrix/monitor/accounts/enable-all
useRestoreAllPlatforms()      // POST /matrix/monitor/accounts/:userId/restore-all
useClearAllUserData()         // POST /matrix/monitor/accounts/:userId/clear-all

// 已有 hook（不修改）
useClearUserData()            // POST /matrix/monitor/accounts/:userId/clear（单平台）
```

---

## 5. 实现范围

### 5.1 需要修改的文件

| 文件 | 修改内容 | 复用关系 |
|------|----------|----------|
| `apps/ts-api-gateway/src/routes/matrix.ts` | 添加 3 个新 API 端点 | 复用现有 `clear` 逻辑 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 添加按钮和交互逻辑 | 复用现有 UI 组件 |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 添加 3 个 mutation hooks | 新增，不修改现有 |

### 5.2 不需要修改的部分

- 数据库模型（已支持）
- 前端组件结构（复用现有）

---

## 6. 验收标准

1. "一键恢复所有用户"按钮可用，点击后所有暂停的用户恢复启用
2. "恢复所有平台"按钮可用，点击后该用户所有平台状态重置为 `init`
3. "清空所有数据"按钮可用，点击后弹出二次确认（3 秒倒计时），确认后清空数据
4. 所有操作成功后自动刷新监控列表
5. 错误处理：API 失败时显示错误提示
6. 操作日志：所有操作都写入 `operation_logs` 表
7. 调度器重置：启用/恢复操作后调度器立即感知变化
8. 事务安全：清空操作使用数据库事务，失败时回滚
