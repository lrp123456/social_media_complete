// @ts-api-gateway/routes/rbac.ts - RBAC 用户管理 API (in-memory)
// User 表缺少 username/email/role 字段，开发阶段用内存存储

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:rbac');

// ============================================================
// 类型定义
// ============================================================

type Role = 'admin' | 'operator' | 'viewer';

interface RbacUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt?: string;
  createdAt: string;
}

// ============================================================
// In-memory 存储（开发阶段使用，后续接 Prisma）
// ============================================================

let nextId = 4;
let rbacUsers: RbacUser[] = [
  {
    id: 1,
    username: 'admin',
    displayName: '管理员',
    email: 'admin@naite.com',
    role: 'admin',
    status: 'active',
    lastLoginAt: new Date().toISOString(),
    createdAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    username: 'operator1',
    displayName: '运营专员A',
    email: 'op1@naite.com',
    role: 'operator',
    status: 'active',
    createdAt: '2025-02-15T00:00:00.000Z',
  },
  {
    id: 3,
    username: 'viewer1',
    displayName: '观察者',
    email: 'viewer@naite.com',
    role: 'viewer',
    status: 'disabled',
    createdAt: '2025-03-01T00:00:00.000Z',
  },
];

// ============================================================
// Zod Schemas
// ============================================================

const createUserSchema = z.object({
  username: z.string().min(2).max(64),
  displayName: z.string().min(1).max(128),
  email: z.string().email().max(256),
  role: z.enum(['admin', 'operator', 'viewer']),
  status: z.enum(['active', 'disabled']).default('active'),
});

const updateUserSchema = z.object({
  username: z.string().min(2).max(64).optional(),
  displayName: z.string().min(1).max(128).optional(),
  email: z.string().email().max(256).optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============================================================
// 辅助：写 OperationLog
// ============================================================

async function writeOpLog(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await prisma.operationLog.create({
      data: {
        action,
        details: JSON.stringify(details),
        userId: 'system',
        userName: 'RBAC API',
        result: 'success',
        level: 'info',
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '写入 OperationLog 失败');
  }
}

// ============================================================
// GET /api/v1/rbac/users — 用户列表
// ============================================================

router.get('/users', (_req: Request, res: Response) => {
  res.json({ success: true, data: rbacUsers });
});

// ============================================================
// POST /api/v1/rbac/users — 创建用户
// ============================================================

router.post('/users', async (req: Request, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);

    // 检查用户名唯一
    if (rbacUsers.some((u) => u.username === body.username)) {
      return res.status(409).json({ success: false, error: `用户名已存在: ${body.username}` });
    }

    const newUser: RbacUser = {
      id: nextId++,
      username: body.username,
      displayName: body.displayName,
      email: body.email,
      role: body.role,
      status: body.status ?? 'active',
      createdAt: new Date().toISOString(),
    };

    rbacUsers.push(newUser);

    await writeOpLog('rbac_create_user', { userId: newUser.id, username: newUser.username });

    res.status(201).json({ success: true, data: newUser });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '创建用户失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// PUT /api/v1/rbac/users/:id — 更新用户
// ============================================================

router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = updateUserSchema.parse(req.body);

    const idx = rbacUsers.findIndex((u) => u.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: `用户不存在: ${id}` });
    }

    // 如果更新 username，检查唯一性
    if (body.username && body.username !== rbacUsers[idx].username) {
      if (rbacUsers.some((u) => u.username === body.username)) {
        return res.status(409).json({ success: false, error: `用户名已存在: ${body.username}` });
      }
    }

    const updated: RbacUser = {
      ...rbacUsers[idx],
      ...(body.username !== undefined && { username: body.username }),
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.email !== undefined && { email: body.email }),
      ...(body.role !== undefined && { role: body.role }),
      ...(body.status !== undefined && { status: body.status }),
    };

    rbacUsers[idx] = updated;

    await writeOpLog('rbac_update_user', { userId: id, changes: body });

    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '更新用户失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// DELETE /api/v1/rbac/users/:id — 删除用户
// ============================================================

router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);

    const idx = rbacUsers.findIndex((u) => u.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: `用户不存在: ${id}` });
    }

    const deleted = rbacUsers.splice(idx, 1)[0];

    await writeOpLog('rbac_delete_user', { userId: id, username: deleted.username });

    res.json({ success: true, data: deleted });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '删除用户失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
