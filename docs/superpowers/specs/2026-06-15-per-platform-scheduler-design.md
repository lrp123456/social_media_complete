# Per-(Window, Platform) Scheduler — Design Spec

**Date:** 2026-06-15
**Status:** Approved
**Approach:** Plan B — Single queue + per-(window, platform) scheduler state

## Problem

The monitoring scheduler currently uses **global** state (`schedulerMode`, `consecutiveNoUpdates`, one `setTimeout` timer) shared across all platforms and windows. This causes:

1. **Unfair idle detection**: One platform's frequent updates reset `consecutiveNoUpdates` globally, preventing other platforms from ever entering idle (long-interval) mode
2. **Single point of scheduling**: All platforms share one countdown timer — no per-platform visibility
3. **Over-coupled manual trigger**: `resetSchedulerTimer()` clears the global timer and calls `scheduleNext(0)` which triggers a wasteful `runOneSchedule` that always finds all users already queued

## Design

### Core Change: SchedulerState per (windowId, platform)

Replace these global variables:

```
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerIntervalMs = 900_000;
let nextScheduledRunAt = 0;
let schedulerMode: 'active' | 'idle' = 'active';
let consecutiveNoUpdates = 0;
```

With a `Map` keyed by `"windowId_platform"`:

```typescript
interface SchedulerState {
  timer: NodeJS.Timeout | null;
  intervalMs: number;
  nextRunAt: number;
  lastRunAt: number;
  mode: 'active' | 'idle';
  consecutiveNoUpdates: number;
  pendingTaskCount: number;
  scheduleAfterCompletion: boolean;
}

const schedulerStates = new Map<string, SchedulerState>();
```

The key format is `${windowId}_${platform}` (e.g., `"fp_abc123_douyin"`).

### What stays unchanged

- Single `platform` BullMQ queue
- Single `platformWorker` 
- `WindowMutex` for same-window serialization
- `enqueueMonitor()` / `runOneSchedule()` entry point
- `reportMonitorComplete(hadUpdate)` — now routes to the correct SchedulerState

### What changes

#### 1. `getOrCreateSchedulerState(windowId, platform)`

Factory that returns the per-(window, platform) state, initializing with random active-mode interval on first access.

#### 2. `runOneSchedule(windowId, platform)`

Narrowed scope: only enqueues users matching the **specific** (windowId, platform) pair. No longer iterates all users globally.

#### 3. `scheduleNext(windowId, platform, forceInterval?)`

Sets `nextRunAt = Date.now() + interval` for that specific state, creates a per-state `setTimeout`. Logs with `[windowId:platform]` prefix.

#### 4. `reportMonitorComplete(windowId, platform, hadUpdate)`

Updates the specific state:
- `hadUpdate=true` → `consecutiveNoUpdates = 0`, `mode = 'active'`
- `hadUpdate=false` → `consecutiveNoUpdates++`, if threshold exceeded → `mode = 'idle'`
- `pendingTaskCount--`
- If `pendingTaskCount === 0 && scheduleAfterCompletion` → `scheduleNext(windowId, platform)`

**Signature change**: now requires `windowId` and `platform` parameters (caller in `unifiedQueue.ts` already has `task.windowId` and `task.platform`).

#### 5. `resetSchedulerTimer(windowId, platform)` — manual trigger support

On manual trigger:
- Does NOT call `scheduleNext(0)` / `runOneSchedule` (the task is already enqueued directly by the API route)
- Only sets `scheduleAfterCompletion = true` so that after the current batch completes, `scheduleNext` is called
- If `pendingTaskCount === 0`: sets `scheduleAfterCompletion = true` (next `reportMonitorComplete` will trigger `scheduleNext`)
- If `pendingTaskCount > 0`: already handled, `scheduleAfterCompletion` will be checked on each completion

Actually simplified: just set `scheduleAfterCompletion = true`. The completion path handles the rest.

#### 6. `getSchedulerStatus()` → `getAllSchedulerStatuses()`

Returns a map of all (windowId, platform) → status, plus a compound summary. Frontend can show per-platform countdowns.

```typescript
interface PlatformSchedulerStatus {
  windowId: string;
  platform: string;
  intervalMs: number;
  lastRunAt: number;
  nextRunAt: number;
  remainingMs: number;
  mode: 'active' | 'idle';
  consecutiveNoUpdates: number;
}
```

#### 7. API route changes

- `GET /monitor/scheduler-status` → returns `{ statuses: PlatformSchedulerStatus[] }` instead of single status
- `POST /monitor/accounts/:userId/trigger` → calls `resetSchedulerTimer(user.windowId, user.platform)` instead of global `resetSchedulerTimer()`
- `POST /monitor/trigger-all` → calls `resetSchedulerTimer()` for each unique (windowId, platform) pair

### Frontend changes

- Replace single countdown card with per-(window, platform) countdown list
- Each card shows: platform icon, window label, countdown, mode badge (active/idle), interval
- "立即更新全部" button calls trigger-all (unchanged API)
- Individual "立即更新评论" still calls per-user trigger

### Initialization

On server start, scan all `monitoringEnabled` users, group by (windowId, platform), and call `scheduleNext()` for each unique pair to seed the initial timers. The existing `startScheduler()` function is adapted to iterate over the grouped keys.

### Migration

- Remove global variables (lines 1055-1064 in monitorService.ts)
- Add `schedulerStates` Map and `getOrCreateSchedulerState()`
- Update function signatures
- Update all call sites: `unifiedQueue.ts` (worker completion), `matrix.ts` (API routes), `operators.ts` (login status changes)
- No database migration needed — state is in-memory only

### Edge Cases

1. **Window with no active users**: Timer fires, `runOneSchedule` finds no users to enqueue → calls `scheduleNext` as normal (no-op cycle is harmless)
2. **User changes window assignment**: Rare but possible. Old state remains (will be cleaned up on next restart). New window gets fresh state on first access.
3. **Race between manual trigger and auto timer**: `scheduleAfterCompletion` flag ensures only one `scheduleNext` call. The `runOneSchedule` dedup check (`activeUserIds`) prevents double-enqueue.
4. **Server restart loses in-memory state**: All states re-initialize from active users on startup. `consecutiveNoUpdates` resets to 0 (acceptable — fresh start should be active mode).
