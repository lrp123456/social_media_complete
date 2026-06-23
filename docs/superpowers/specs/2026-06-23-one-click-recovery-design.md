# 一键恢复功能设计规格

**日期**: 2026-06-23
**状态**: 已批准
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
| 一键恢复所有用户 | 启用所有已暂停的监控用户 | 所有 User 记录 |
| 各用户所有平台恢复 | 启用监控 + 重置状态为 `init` | 单个用户的所有平台 |
| 各用户所有平台清空数据 | 清空视频、评论、监控状态 + 重置用户状态 | 单个用户的所有平台 |

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
    "updatedCount": 12
  }
}
```

**数据库操作**:
```sql
UPDATE users SET monitoring_enabled = true WHERE monitoring_enabled = false;
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

**数据库操作**:
```sql
UPDATE users 
SET status = 'init', monitoring_enabled = true, cooldown_until = 0 
WHERE fingerprint_window_id = (
  SELECT fingerprint_window_id FROM users WHERE id = ?
) AND platform IN ('douyin', 'kuaishou', 'xiaohongshu', 'tencent');
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

**数据库操作**:
```sql
-- 1. 删除评论
DELETE FROM comments WHERE video_id IN (
  SELECT id FROM videos WHERE user_id IN (
    SELECT id FROM users WHERE fingerprint_window_id = (
      SELECT fingerprint_window_id FROM users WHERE id = ?
    )
  )
);

-- 2. 删除视频
DELETE FROM videos WHERE user_id IN (
  SELECT id FROM users WHERE fingerprint_window_id = (
    SELECT fingerprint_window_id FROM users WHERE id = ?
  )
);

-- 3. 删除监控状态
DELETE FROM monitor_status WHERE account_id IN (
  SELECT id::text FROM users WHERE fingerprint_window_id = (
    SELECT fingerprint_window_id FROM users WHERE id = ?
  )
);

-- 4. 重置用户状态
UPDATE users 
SET status = 'init', monitoring_enabled = true, cooldown_until = 0 
WHERE fingerprint_window_id = (
  SELECT fingerprint_window_id FROM users WHERE id = ?
);
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
<button onClick={() => clearAllData(userId)} className="btn-danger">
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
    <button onClick={confirmClear}>确认清空</button>
    <button onClick={() => setShowClearConfirm(false)}>取消</button>
  </div>
)}
```

---

## 5. 实现范围

### 5.1 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `apps/ts-api-gateway/src/routes/matrix.ts` | 添加 3 个新 API 端点 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 添加按钮和交互逻辑 |
| `apps/admin-dashboard/src/hooks/useApi.ts` | 添加 mutation hooks |

### 5.2 不需要修改的部分

- 数据库模型（已支持）
- 前端组件结构（复用现有）

---

## 6. 验收标准

1. "一键恢复所有用户"按钮可用，点击后所有暂停的用户恢复启用
2. "恢复所有平台"按钮可用，点击后该用户所有平台状态重置为 `init`
3. "清空所有数据"按钮可用，点击后弹出二次确认，确认后清空数据
4. 所有操作成功后自动刷新监控列表
5. 错误处理：API 失败时显示错误提示
