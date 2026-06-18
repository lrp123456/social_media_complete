# 修复方案：Stale Jobs 卡死调度器

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 worker 重启后 stale active jobs 卡死调度器、toggle 不同步调度器、cancel-all 不清理 active list 三个 bug

**架构：** Worker 启动时主动清理 Redis 中遗留的 active/stalled jobs；调度器 dedup 改用 `isStalled()` 真实判断；toggle 成功后同步重启调度器；cancel-all 用正确的 Redis 命令清理 list 类型

**技术栈：** BullMQ, Redis, TypeScript, Node.js

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|---------|
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | Worker 启动清理 + stalled 事件处理 | 修改 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | Scheduler dedup 逻辑 | 修改 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | toggle 端点 + cancel-all 端点 | 修改 |
| `apps/ts-api-gateway/src/lib/redlock.ts` | heartbeat 可靠性（可选） | 修改 |

---

## 任务 1：Worker 启动时清理遗留的 active jobs

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts:96-404`

**问题：** Worker 重启后，Redis `bull:platform:active` 列表中残留上一轮 worker 的 job ID。这些 job 处于 "active" 状态但不在新 worker 的内存中。`stalledInterval: 120_000` (2min) 标记它们为 stalled，但 `bull:platform:active` 列表不会被清空，导致调度器 dedup 误判。

- [ ] **步骤 1：在 Worker 创建后添加启动清理逻辑**

在 `apps/ts-api-gateway/src/services/unifiedQueue.ts` 文件末尾的 `platformWorker` 定义之后（约第 404 行后），添加：

```typescript
// ============================================================
// Worker 启动清理：移除上一轮遗留的 active jobs
// ============================================================

platformWorker.on('ready', async () => {
  try {
    const redis = getRedis();
    const queueName = QUEUE_NAME;
    const activeKey = `bull:${queueName}:active`;
    const stalledKey = `bull:${queueName}:stalled`;

    // 读取 active list 中的所有 job ID
    const staleJobIds = await redis.lrange(activeKey, 0, -1);
    if (staleJobIds.length === 0) {
      logger.info('[启动清理] active list 为空，无需清理');
      return;
    }

    logger.info({ count: staleJobIds.length, jobIds: staleJobIds }, '[启动清理] 发现遗留 active jobs，开始清理');

    for (const jobId of staleJobIds) {
      try {
        // 从 active list 移除
        await redis.lrem(activeKey, 1, jobId);
        // 添加到 failed 队列（而不是直接删除，保留失败记录）
        const jobKey = `bull:${queueName}:${jobId}`;
        const jobData = await redis.hgetall(jobKey);
        if (jobData && Object.keys(jobData).length > 0) {
          await redis.hset(jobKey, 'failedReason', JSON.stringify({
            error: 'Worker restarted — job was stale in active list',
            cleanedAt: Date.now(),
          }));
        }
        logger.info({ jobId }, '[启动清理] 已从 active list 移除');
      } catch (cleanErr: any) {
        logger.warn({ jobId, err: cleanErr.message }, '[启动清理] 清理单个 job 失败');
      }
    }

    // 清理 stalled 集合中的同批 jobs
    for (const jobId of staleJobIds) {
      await redis.srem(stalledKey, jobId).catch(() => {});
    }

    logger.info({ cleaned: staleJobIds.length }, '[启动清理] 完成');
  } catch (err: any) {
    logger.error({ err: err.message }, '[启动清理] 失败');
  }
});
```

- [ ] **步骤 2：添加 LREM 导入**

确认 `getRedis` 已导入（文件第 6 行已有）。`lrange` 和 `lrem` 是 redis 客户端的标准方法，无需额外导入。

- [ ] **步骤 3：验证 Worker 事件**

确认 `platformWorker.on('ready', ...)` 是 BullMQ Worker 的合法事件。查阅 BullMQ 文档确认 `ready` 事件在 worker 连接 Redis 后触发。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "fix(worker): clean stale active jobs on startup"
```

---

## 任务 2：Scheduler dedup 过滤 stalled jobs

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:1190-1219`

**问题：** `runOneSchedule` 的去重逻辑用 `monitorQueue.getJobs(['active', 'waiting'])` 获取所有 active+waiting 的 jobs，然后按 userId 去重。但 BullMQ 的 `getJobs(['active'])` 会返回 stalled jobs（因为 stalled jobs 仍在 active list 中），导致调度器误判用户有运行中的任务。

- [ ] **步骤 1：替换 dedup 逻辑**

将 `monitorService.ts` 第 1190-1219 行：

```typescript
    // 去重：查询当前队列中是否已有同用户任务
    const existingJobs = await monitorQueue.getJobs(['active', 'waiting']);
    const activeUserIds = new Set(
      existingJobs.map((j) => (j.data as any).userId).filter(Boolean),
    );
```

替换为：

```typescript
    // 去重：查询当前队列中是否有真正在执行（非 stalled）的同用户任务
    const [activeJobs, waitingJobs] = await Promise.all([
      monitorQueue.getJobs(['active']),
      monitorQueue.getJobs(['waiting']),
    ]);
    const activeUserIds = new Set<number>();
    for (const j of [...activeJobs, ...waitingJobs]) {
      const data = j.data as any;
      if (!data?.userId) continue;
      // 用 isStalled() 过滤掉 stalled jobs
      try {
        const isStalled = await j.isStalled();
        if (!isStalled) {
          activeUserIds.add(data.userId);
        } else {
          logger.debug({ jobId: j.id, userId: data.userId }, '[调度] 跳过 stalled job');
        }
      } catch {
        // isStalled 失败时保守处理：认为非 stalled
        activeUserIds.add(data.userId);
      }
    }
```

- [ ] **步骤 2：确认 `isStalled()` API**

BullMQ Job 对象有 `isStalled()` 方法（返回 `Promise<boolean>`）。查阅 BullMQ 文档确认其行为：当 job 在 active 状态但 worker 未在 `stalledInterval` 内续约时返回 `true`。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix(scheduler): filter stalled jobs from dedup check"
```

---

## 任务 3：toggle 成功后同步重启调度器

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts:1370-1403`

**问题：** `PUT /monitor/accounts/:userId/toggle` 端点只更新数据库中 `monitoringEnabled` 字段，不通知调度器。调度器在内存中维护了一份 `getAllActiveUsers()` 的快照，toggle 后不会自动刷新。

- [ ] **步骤 1：在 toggle 成功后调用 `restartMonitorScheduler()`**

在 `matrix.ts` 第 1398 行（`res.json({ success: true, enabled });`）之前添加：

```typescript
    // 同步重启调度器，使其感知 monitoringEnabled 变化
    try {
      const { restartMonitorScheduler } = await import('../services/monitorService');
      restartMonitorScheduler();
      logger.info({ userId, enabled }, '[toggle] 调度器已重启');
    } catch (restartErr: any) {
      logger.warn({ err: restartErr.message }, '[toggle] 调度器重启失败（不影响 toggle 结果）');
    }
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "fix(toggle): restart scheduler after monitoring toggle"
```

---

## 任务 4：cancel-all 用 LREM 清理 active list

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts:596-604`

**问题：** `cancel-all` 端点用 `srem` (SET remove) 和 `zrem` (ZSET remove) 清理 `bull:platform:active`，但 `bull:platform:active` 是 LIST 类型。`srem` 对 list 无效（静默失败），导致 active list 中的 job 不被移除。

- [ ] **步骤 1：修正 active list 的清理命令**

将 `matrix.ts` 第 596-604 行：

```typescript
        // Step 4: 从集合中移除
        for (const setName of [
          `bull:${queueName}:active`,
          `bull:${queueName}:wait`,
          `bull:${queueName}:waiting`,
          `bull:${queueName}:delayed`,
        ]) {
          await redis.srem(setName, bullJobId).catch(() => {});
          await redis.zrem(setName, bullJobId).catch(() => {});
        }
```

替换为：

```typescript
        // Step 4: 从集合中移除（不同类型用不同命令）
        // active 是 LIST → 用 LREM
        await redis.lrem(`bull:${queueName}:active`, 1, bullJobId).catch(() => {});
        // wait/waiting/delayed 是 ZSET → 用 ZREM
        for (const setName of [
          `bull:${queueName}:wait`,
          `bull:${queueName}:waiting`,
          `bull:${queueName}:delayed`,
        ]) {
          await redis.zrem(setName, bullJobId).catch(() => {});
        }
```

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "fix(cancel-all): use LREM for active list cleanup"
```

---

## 任务 5：测试验证

- [ ] **步骤 1：本地构建**

```bash
cd apps/ts-api-gateway
npm run build
```

预期：编译成功，无类型错误

- [ ] **步骤 2：运行现有测试**

```bash
npx jest src/lib/redlock.test.ts --verbose
```

预期：全部 PASS（redlock.test.ts 测试不涉及本次修改的文件）

- [ ] **步骤 3：Docker 重启验证**

```bash
docker compose restart ts-api-gateway
docker logs -f sm-ts-api 2>&1 | grep -E "启动清理|调度器|stalled"
```

预期日志：
1. `[启动清理] 发现遗留 active jobs，开始清理` — 清理 stale jobs
2. `[启动清理] 完成` — 清理成功
3. `⏰ 调度器启动完成` — 调度器重启
4. `[调度] 完成任务入队` — 新任务被正确入队（不再卡在"全部用户已有任务运行中"）

- [ ] **步骤 4：手动触发验证**

```bash
# 触发 user 3 的监控
curl -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/3/trigger

# 检查 active tasks
curl -s http://localhost:3001/api/v1/matrix/monitor/active-tasks | python3 -m json.tool

# 检查锁状态
curl -s http://localhost:3001/api/v1/system/locks | python3 -m json.tool
```

预期：
- `active-tasks` 返回 1 个 running task
- `locks` 返回 1 个锁（user 3 的 window 68a）

- [ ] **步骤 5：toggle + 调度器同步验证**

```bash
# 暂停 user 3 监控
curl -X PUT http://localhost:3001/api/v1/matrix/monitor/accounts/3/toggle \
  -H 'Content-Type: application/json' -d '{"enabled": false}'

# 等待 3 秒
sleep 3

# 检查调度器状态（应该不再为 user 3 调度）
curl -s http://localhost:3001/api/v1/matrix/monitor/scheduler-status | python3 -m json.tool
```

预期：调度器状态中不再包含 `(68a, douyin)` pair

- [ ] **步骤 6：cancel-all 清理验证**

```bash
# 触发一个任务
curl -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/3/trigger

# 等任务开始
sleep 3

# 取消所有
curl -X POST http://localhost:3001/api/v1/matrix/monitor/active-tasks/cancel-all

# 检查 Redis active list
docker exec sm-redis redis-cli -a 'your_redis_password' --no-auth-warning LLEN 'bull:platform:active'
```

预期：`LLEN` 返回 `0`（active list 被正确清空）

---

## 执行顺序

1. 任务 1（Worker 启动清理）— 独立，可先做
2. 任务 2（Scheduler dedup）— 依赖任务 1 的清理逻辑概念
3. 任务 3（Toggle 同步）— 独立
4. 任务 4（cancel-all 修复）— 独立
5. 任务 5（测试验证）— 依赖 1-4

**任务 1、3、4 可并行执行。任务 2 可与任务 1 并行。**

---

## 临时修复（不改代码）

如果需要立即恢复系统运行，执行以下 Redis 清理：

```bash
# 1. 清空 active list
docker exec sm-redis redis-cli -a 'your_redis_password' --no-auth-warning DEL 'bull:platform:active'

# 2. 清空 stalled 集合
docker exec sm-redis redis-cli -a 'your_redis_password' --no-auth-warning DEL 'bull:platform:stalled'

# 3. 重启 ts-api 让调度器重新初始化
docker restart sm-ts-api
```

这会让调度器重新扫描用户并正确入队。但根本问题（下次重启还会复现）需要上述代码修复。
