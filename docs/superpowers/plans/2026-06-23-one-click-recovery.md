# 一键恢复功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现三个一键操作功能：一键恢复所有用户、恢复用户所有平台、清空用户所有数据

**架构：** 在 `matrix.ts` 中添加 3 个新 API 端点，在前端添加按钮和交互逻辑，使用数据库事务确保数据一致性

**技术栈：** TypeScript, Prisma, React, React Query, BullMQ

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `apps/ts-api-gateway/src/routes/matrix.ts` | 添加 3 个新 API 端点 | 修改 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 添加按钮和交互逻辑 | 修改 |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 添加 3 个 mutation hooks | 修改 |

---

## 任务 1：添加「一键恢复所有用户」API

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：添加 API 端点**

在 `matrix.ts` 中添加新路由：

```typescript
/** POST /matrix/monitor/accounts/enable-all — 一键恢复所有用户 */
router.post('/monitor/accounts/enable-all', async (_req: Request, res: Response) => {
  try {
    // 1. 查询所有已暂停的用户
    const pausedUsers = await prisma.user.findMany({
      where: { monitoringEnabled: false },
      select: { id: true, fingerprintWindowId: true, platform: true },
    });

    if (pausedUsers.length === 0) {
      return res.json({ success: true, data: { enabledCount: 0 } });
    }

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

    res.json({ success: true, data: { enabledCount: pausedUsers.length } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '一键恢复所有用户失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat: add enable-all users API endpoint"
```

---

## 任务 2：添加「恢复用户所有平台」API

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：添加 API 端点**

在 `matrix.ts` 中添加新路由：

```typescript
/** POST /matrix/monitor/accounts/:userId/restore-all — 恢复用户所有平台 */
router.post('/monitor/accounts/:userId/restore-all', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid userId' });
    }

    // 1. 获取用户所在窗口
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fingerprintWindowId: true },
    });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

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

    res.json({ success: true, data: { userId, updatedCount: result.count } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '恢复用户所有平台失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat: add restore-all platforms API endpoint"
```

---

## 任务 3：添加「清空用户所有数据」API

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：添加 API 端点**

在 `matrix.ts` 中添加新路由：

```typescript
/** POST /matrix/monitor/accounts/:userId/clear-all — 清空用户所有数据 */
router.post('/monitor/accounts/:userId/clear-all', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid userId' });
    }

    // 1. 获取用户所在窗口
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fingerprintWindowId: true },
    });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

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

    // 4. 获取所有视频 ID
    const videos = await prisma.video.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const videoIds = videos.map(v => v.id);

    // 5. 使用事务清空数据
    const [deletedComments, deletedVideos, deletedRootCounts, deletedCommentRecords, deletedCommentCounts, deletedMonitorStatus] = await prisma.$transaction([
      prisma.comment.deleteMany({ where: { videoId: { in: videoIds } } }),
      prisma.video.deleteMany({ where: { userId: { in: userIds } } }),
      prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: videoIds } } }),
      prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: videoIds } } }),
      prisma.videoCommentCount.deleteMany({ where: { videoId: { in: videoIds } } }),
      prisma.monitorStatus.deleteMany({ where: { accountId: { in: userIds.map(id => String(id)) } } }),
    ]);

    // 6. 重置用户状态
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

    // 7. 写入操作日志
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

    res.json({
      success: true,
      data: {
        userId,
        deletedVideos: deletedVideos.count,
        deletedComments: deletedComments.count,
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '清空用户所有数据失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat: add clear-all user data API endpoint"
```

---

## 任务 4：添加前端 mutation hooks

**文件：**
- 修改：`apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **步骤 1：添加 useEnableAllUsers hook**

```typescript
/** 一键恢复所有用户 */
export function useEnableAllUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/matrix/monitor/accounts/enable-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}
```

- [ ] **步骤 2：添加 useRestoreAllPlatforms hook**

```typescript
/** 恢复用户所有平台 */
export function useRestoreAllPlatforms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post(`/matrix/monitor/accounts/${userId}/restore-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}
```

- [ ] **步骤 3：添加 useClearAllUserData hook**

```typescript
/** 清空用户所有数据 */
export function useClearAllUserData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post(`/matrix/monitor/accounts/${userId}/clear-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}
```

- [ ] **步骤 4：验证前端构建**

```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard
npm run build
```

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat: add one-click recovery mutation hooks"
```

---

## 任务 5：添加前端按钮和交互逻辑

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：导入新 hooks**

在文件顶部添加导入：

```typescript
import { useEnableAllUsers, useRestoreAllPlatforms, useClearAllUserData } from '@/hooks/useApi';
```

- [ ] **步骤 2：在 MonitorTab 中使用 hooks**

```typescript
const enableAllUsers = useEnableAllUsers();
const restoreAllPlatforms = useRestoreAllPlatforms();
const clearAllUserData = useClearAllUserData();
```

- [ ] **步骤 3：添加「一键恢复所有用户」按钮**

在监控概览操作栏中添加：

```tsx
<button
  onClick={() => enableAllUsers.mutate()}
  disabled={enableAllUsers.isPending}
  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
>
  {enableAllUsers.isPending ? '恢复中...' : '一键恢复所有用户'}
</button>
```

- [ ] **步骤 4：添加「恢复所有平台」和「清空所有数据」按钮**

在用户卡片操作区域添加：

```tsx
<div className="flex gap-2 mt-2">
  <button
    onClick={() => restoreAllPlatforms.mutate(userId)}
    disabled={restoreAllPlatforms.isPending}
    className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
  >
    恢复所有平台
  </button>
  <button
    onClick={() => setShowClearConfirm(userId)}
    className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
  >
    清空所有数据
  </button>
</div>
```

- [ ] **步骤 5：添加二次确认对话框**

```tsx
{showClearConfirm && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg p-6 max-w-md">
      <h3 className="text-lg font-bold mb-4">确认清空数据</h3>
      <p className="mb-4">确定要清空该用户的所有数据吗？此操作将删除：</p>
      <ul className="list-disc list-inside mb-4 text-gray-600">
        <li>所有视频记录</li>
        <li>所有评论记录</li>
        <li>监控状态</li>
      </ul>
      <p className="mb-4 text-red-600 font-semibold">此操作不可撤销！</p>
      <div className="flex gap-4">
        <button
          onClick={() => {
            clearAllUserData.mutate(showClearConfirm, {
              onSuccess: () => setShowClearConfirm(null),
            });
          }}
          disabled={clearAllUserData.isPending || clearCountdown > 0}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
        >
          {clearCountdown > 0 ? `确认清空 (${clearCountdown}s)` : '确认清空'}
        </button>
        <button
          onClick={() => { setShowClearConfirm(null); setClearCountdown(0); }}
          className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
        >
          取消
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **步骤 6：添加倒计时逻辑**

```typescript
const [showClearConfirm, setShowClearConfirm] = useState<number | null>(null);
const [clearCountdown, setClearCountdown] = useState(0);

useEffect(() => {
  if (showClearConfirm !== null) {
    setClearCountdown(3);
    const timer = setInterval(() => {
      setClearCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }
}, [showClearConfirm]);
```

- [ ] **步骤 7：验证前端构建**

```bash
npm run build
```

- [ ] **步骤 8：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat: add one-click recovery UI buttons and confirm dialog"
```

---

## 任务 6：集成测试

**文件：**
- 测试：手动测试 + API 验证

- [ ] **步骤 1：重建 Docker 容器**

```bash
docker compose build --no-cache ts-api-gateway admin-dashboard
docker compose up -d
```

- [ ] **步骤 2：测试「一键恢复所有用户」API**

```bash
curl -s -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/enable-all | python3 -m json.tool
```

- [ ] **步骤 3：测试「恢复用户所有平台」API**

```bash
curl -s -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/20/restore-all | python3 -m json.tool
```

- [ ] **步骤 4：测试「清空用户所有数据」API**

```bash
curl -s -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/20/clear-all | python3 -m json.tool
```

- [ ] **步骤 5：验证操作日志**

```bash
docker exec sm-ts-api npx tsx -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const logs = await p.operationLog.findMany({
    where: { action: { in: ['monitor_enable_all', 'monitor_restore_all_platforms', 'monitor_clear_all_user_data'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(JSON.stringify(logs, null, 2));
  await p.\$disconnect();
})();
"
```

- [ ] **步骤 6：Final Commit**

```bash
git add -A
git commit -m "feat: complete one-click recovery feature"
```

---

## 自检清单

1. **规格覆盖度：**
   - ✅ 一键恢复所有用户（任务 1）
   - ✅ 恢复用户所有平台（任务 2）
   - ✅ 清空用户所有数据（任务 3）
   - ✅ 前端 hooks（任务 4）
   - ✅ 前端 UI（任务 5）
   - ✅ 集成测试（任务 6）

2. **占位符扫描：**
   - ✅ 无 "待定"、"TODO"
   - ✅ 所有步骤都有完整代码

3. **类型一致性：**
   - ✅ API 响应格式一致
   - ✅ Hook 命名一致

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-23-one-click-recovery.md`。

两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
