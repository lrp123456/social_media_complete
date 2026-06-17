# 窗口互斥锁重构设计

- **日期**: 2026-06-17
- **状态**: 已批准（待规格自检）
- **范围**: `apps/ts-api-gateway/src/lib/redlock.ts` + 调用方适配
- **非范围**: BullMQ 调度策略、任务取消机制、浏览器连接异常处理

## 1. 背景与问题

### 1.1 现状

系统通过 `WindowMutex`（基于 Redlock）对每个指纹浏览器窗口（`windowId`）加互斥锁，确保同一窗口同一时刻只有一个任务操作浏览器。锁被三处使用：

- `unifiedQueue.ts` — reply / publish / monitor 三类任务的 Worker 入口
- `BasePublisher.ts` — 发布器内部（`skipLock` 分支）
- `pinterest.ts` — 独立调用（本次不动）

锁的并发模型按 windowId 分桶：`window_lock:{windowId}`，不同 windowId 走不同 key 天然并行；Worker `concurrency: 3` 允许多窗口任务同时运行。**本次重构不改变这个并发模型。**

### 1.2 故障现象

1. **进程崩溃后锁残留 30 分钟**：当前 `LOCK_TTL = 30 min`，进程被 kill / OOM / 重启后，Redis 里的锁要等 30 分钟自然过期。日志实测：容器重启 5 秒后新任务被锁拒绝，排队 367 秒才拿到锁。
2. **"立即更新"卡死无逃生**：手动触发监控任务卡在某一步时，后续任务无限排队等锁（旧实现 `acquireWithBackoff` 无限重试但无 abort 通道）。
3. **BasePublisher 锁释放 bug**：`releaseLock()` 把 `page.context()`（BrowserContext 对象）当 `windowId` 传给 `WindowMutex.release`，是死代码。目前被 `unifiedQueue` 的 finally 释放掩盖。
4. **锁不可观测**：Redis 里只有 redlock 的 token 字符串，无法知道是哪个 task、什么类型、跑了多久。

### 1.3 根因

- 锁 TTL（30 min）远大于业务最大执行时间（15 min），仅靠 TTL 兜底，无心跳续约
- 业务层无"锁丢失"感知通道，一旦锁被夺走或 Redis 闪断，业务仍在盲操作浏览器
- owner 元数据缺失

## 2. 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 崩溃后锁恢复 | 心跳续约（TTL=30s，每 10s 续约） | 进程死亡 → 不再续约 → 30s 自动过期。Redlock 官方推荐模式 |
| 续约失败处理 | 业务主动中止 | 避免双任务共享浏览器；通过 AbortSignal 通知业务 |
| 锁级超时 | 不设，仅负责互斥 | 业务超时（5/10/15min）已由 Promise.race 覆盖 |
| owner 元数据 | 伴生 HASH + 查询 API | 调试/运维可观测，不污染 redlock 内部 token |
| BasePublisher 锁代码 | 删除，断言 skipLock=true | 锁职责统一收归 unifiedQueue |
| pinterest.ts | 不动 | 后续独立浏览器，不纳入本次范围 |
| 测试 | 仅单元测试（ioredis-mock + fake timers） | 快、可靠、不依赖 docker |

## 3. 架构

### 3.1 组件结构

单文件 `apps/ts-api-gateway/src/lib/redlock.ts`，对外暴露 `WindowMutex` 类：

```
WindowMutex
├── acquireWithBackoff(windowId, owner, opts?)  → Promise<MutexHandle>  // 公开，无限排队
├── inspect(windowId?)                          → Promise<LockOwnerSnapshot[]>  // 公开，查询
├── acquire(windowId, owner)                    → Promise<MutexHandle>  // 私有，单次尝试
├── tryAcquire(windowId)                        → Promise<Lock>  // 私有，redlock 原始调用
├── startHeartbeat(lock, handle)                → void  // 私有
└── writeOwnerHash / delOwnerHash / expireOwnerHash  // 私有
```

### 3.2 并发模型（不变，显式声明）

```
锁 key: window_lock:{windowId}
├── 一个 windowId 对应一把独立的锁
├── 不同 windowId 的锁互不影响 → 多窗口可并行执行任务
└── 同一 windowId 同一时刻只有一个业务在操作浏览器（窗口锁的全部价值）
```

保证多窗口并行的三个前提（已有，本次不动）：
1. 锁 key 含 windowId
2. Worker `concurrency: 3`
3. 任务调度器按 windowId 分桶入队 + stagger 错峰

### 3.3 Handle 模式

业务不再持有原始 redlock `Lock`，改为持有自管理的 `MutexHandle`：

```ts
interface MutexHandle {
  readonly windowId: string;
  readonly owner: LockOwner;
  readonly signal: AbortSignal;     // 续约失败时 abort
  readonly acquiredAt: number;      // ms timestamp
  release(): Promise<void>;         // 幂等
}

interface LockOwner {
  taskId: string;
  taskType: 'monitor' | 'publish' | 'reply';
  traceId?: string;
}
```

Handle 内部持有：redlock Lock 对象、AbortController、心跳定时器引用、`released` 标志。

### 3.4 心跳续约

- TTL = 30 秒
- 每 10 秒调用 `lock.extend(TTL)` 续约
- 续约成功后 `EXPIRE owner-hash 30s`
- 续约失败（任意原因）→ 立即 `abortController.abort('lock_lost: <reason>')` 并停止后续续约
- **不重试续约**：失败一次就放弃，业务必须感知

### 3.5 owner 元数据（伴生 HASH）

```
window_lock:{windowId}            STRING  redlock 自管（含随机 token）
  TTL: 30s（心跳每 10s 续约）

window_lock:{windowId}:owner      HASH    业务管（伴生）
  TTL: 30s（跟随心跳 EXPIRE 续期）
  fields:
    taskId       string
    taskType     monitor|publish|reply
    traceId      string
    startedAt    ms-timestamp
    host         os.hostname()
    pid          process.pid
```

**生命周期约束**：owner hash 的生命周期严格 ≤ lock key。lock 释放时先 `DEL owner` 再 `lock.release()`；lock 因 TTL 过期时 owner 也会因 TTL 过期（两者同步续期）。绝不出现 lock 已释放但 owner 残留——若发生，inspect 返回的就是"幽灵锁"，靠 owner hash 自身 TTL 最多 30s 自愈。

### 3.6 查询 API

```
GET /admin/locks
→ {
    locks: [
      {
        windowId,
        taskId,
        taskType,
        traceId,
        host,
        pid,
        startedAt,         // ms-timestamp
        ageMs,             // 服务器算的当前持锁时长
        ttlRemainingMs,    // PTTL window_lock:{windowId}
      }, ...
    ],
    serverTime: ms-timestamp,
  }
```

- 不传 windowId → 列出所有持锁窗口
- 传 windowId → 只查这个窗口（数组长度 0 或 1）
- 实现就是 `KEYS window_lock:*:owner` + `HGETALL`，每次调用现查，无缓存
- 仅放在内部管理路由，不加鉴权（与现有 `/admin/*` 风格一致）

### 3.7 内部循环

```
acquireWithBackoff(windowId, owner, opts?):
  loop:
    try:
      lock = redlock.acquire([key], TTL=30s)
      writeOwnerHash(windowId, owner)
      handle = new MutexHandle(lock, owner, abortController)
      startHeartbeat(lock, handle)
      return handle
    catch ResourceLockedError:
      opts.onWaiting?.(...)
      sleep 5s
      continue

heartbeat(lock, handle):
  loop every 10s:
    try:
      lock = await lock.extend(TTL=30s)
      EXPIRE owner-hash 30s
    catch err:
      abortController.abort('lock_lost: ' + err.message)
      stop loop

handle.release():
  if released: return  // 幂等
  released = true
  stopHeartbeat()
  DEL owner-hash       // 先删元数据
  await lock.release() // 再释放锁；失败仅 warn
```

## 4. 调用方变化

| 调用点 | 变化 |
|---|---|
| `unifiedQueue.ts` reply 路径（L106-127） | `acquireWithBackoff(windowId)` → `acquireWithBackoff(windowId, { taskId, taskType:'reply', traceId })`；返回 Handle；finally 改 `handle.release()`；`Promise.race` 增加 `abortPromise(handle.signal)` |
| `unifiedQueue.ts` publish 路径（L141-179） | 同上，taskType='publish' |
| `unifiedQueue.ts` monitor 路径（L201-357） | 同上，taskType='monitor' |
| `BasePublisher.ts` L196-203 `releaseLock()` | 删除 |
| `BasePublisher.ts` L222-227 `cleanup()` 中的锁释放 | 删除 |
| `BasePublisher.ts` L102-104 `if (!skipLock) acquire` 分支 | 改为断言 `skipLock === true`，否则抛错 `'BasePublisher must be called with skipLock=true from unifiedQueue'` |
| `pinterest.ts` | 不动 |
| `monitorService.ts`、`matrix.ts` | 不动（不直接拿锁） |

### 4.1 unifiedQueue 三处统一模板

```ts
let handle: MutexHandle | null = null;
try {
  handle = await WindowMutex.acquireWithBackoff(task.windowId, {
    taskId: task.taskId,
    taskType: 'reply',  // 或 'publish' / 'monitor'
    traceId: getTraceId(),
  });

  await Promise.race([
    executeBusinessLogic(task),
    abortPromise(handle.signal),                                      // 新增：锁丢失中止
    new Promise<never>((_, reject) =>                                 // 保留：业务超时
      setTimeout(() => reject(new Error(`任务超时: ${TIMEOUT_MS/1000}s`)), TIMEOUT_MS)
    ),
  ]);
} catch (err) {
  logger.error(`任务失败: ${task.taskId} - ${err.message}`);
  throw err;
} finally {
  if (handle) await handle.release().catch(() => {});
}
```

### 4.2 abortPromise 工具函数

```ts
function abortPromise(signal: AbortSignal, msg = '锁失效，业务中止'): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error(msg));
    signal.addEventListener('abort', () => reject(new Error(msg)), { once: true });
  });
}
```

放在 `redlock.ts` 同文件导出，或 `lib/abortPromise.ts`。

## 5. 错误流（穷举）

| 场景 | 行为 | 业务感知 |
|---|---|---|
| 拿锁时被占用 | 5s 间隔无限重试，`onWaiting` 回调可取消 | 排队日志每 30s 一条 |
| 拿锁成功 | 写 owner hash，启心跳 | 返回 Handle |
| 心跳续约成功 | `EXPIRE owner 30s` | 无 |
| **心跳续约失败** | 停心跳，`abortController.abort('lock_lost')` | `handle.signal` abort → `Promise.race` 中 `abortPromise` reject → 业务 throw → finally `release()`（幂等，safe） |
| 业务正常完成 | finally `handle.release()` → 停心跳、DEL owner、释放锁 | 任务成功 |
| 业务超时（5/10/15min） | `Promise.race` 的 setTimeout reject → throw → finally release | 任务失败，锁立即释放 |
| **进程崩溃 / OOM kill** | 心跳停止 → 30s 后 lock + owner 同时 TTL 过期 | 后续任务最多等 30s |
| `release()` 时锁已过期（TTL 先到） | `lock.release()` 抛 `ResourceLockedError` → 吞 warn，`DEL owner` 仍尝试 | 无影响 |
| Redis 完全不可达 | 续约失败 → abort 业务；拿锁失败 → 永远排队（需人工介入或等 Redis 恢复） | 业务中止，日志报 `lock_lost` |
| 重复 `release()` 调用 | `released` 标志短路 | 无 |
| `onWaiting` 回调抛错 | 立即停止排队，向上抛 | 任务失败（取消场景） |

**关键不变量**：一旦 `handle.signal` abort，业务**必须**在合理时间内（业务超时上限）退出。`abortPromise` 只是信号，不是强制 kill——业务自身要响应 abort 或被业务超时兜住。这个语义在文档里写明，不靠魔法。

## 6. 测试（仅单元）

`redlock.test.ts` 重写，覆盖：

1. **acquire 成功** → 返回 Handle，owner hash 已写入，心跳启动
2. **acquire 排队** → 第一次失败，第二次成功，`onWaiting` 被调用
3. **acquire 取消** → `onWaiting` 抛错 → `acquireWithBackoff` reject
4. **release 幂等** → 连续调用 3 次不抛错
5. **release 清理** → owner hash 被 DEL，lock 被释放
6. **心跳续约** → mock `lock.extend`，10s 后被调用，owner hash EXPIRE 被调用
7. **续约失败 abort** → mock `lock.extend` reject → `handle.signal.aborted === true`，reason 含 `lock_lost`
8. **inspect** → mock Redis HGETALL，返回结构化 owner 列表
9. **多窗口隔离** → win-A 持锁不影响 win-B acquire（不同 key）

Redis mock 用 `ioredis-mock`（项目已用 jest，无新测试框架）。心跳定时器用 `jest.useFakeTimers()` 控制。

## 7. 迁移注意

- **Redis 残留锁**：上线后旧锁（30min TTL）仍可能残留。上线前手动 `redis-cli DEL window_lock:*` 清理，或等待自然过期。
- **锁 key 不变**：`window_lock:{windowId}` 保持不变，新旧版本锁 key 兼容。
- **无数据库迁移**：owner 元数据全在 Redis。
- **向后兼容**：`acquireWithBackoff` 方法名保留，签名扩展（第二参数从可选 `onWaiting` 改为 `owner` 对象，`onWaiting` 移入 `opts`）。所有调用点在本次一并修改。

## 8. 不变量（自检清单）

- [ ] 同一 windowId 同一时刻只有一个业务持锁
- [ ] 不同 windowId 的锁互不影响（多窗口并行）
- [ ] 进程崩溃后 30s 内锁自动释放
- [ ] 续约失败时业务能感知（signal abort）
- [ ] release 幂等
- [ ] owner hash 生命周期 ≤ lock key 生命周期
- [ ] 锁 key 严格使用 windowId，不混入 platform/userId
