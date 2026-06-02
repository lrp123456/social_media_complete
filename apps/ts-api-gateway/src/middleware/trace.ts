import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';

// ============================================================
// Trace Context - 全链路追踪上下文
// ============================================================

export interface TraceContext {
  traceId: string;
  startTime: number;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * 获取当前请求的 Trace 上下文（在异步上下文中安全）
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * 获取当前 Trace ID
 */
export function getTraceId(): string {
  return traceStorage.getStore()?.traceId ?? 'no-trace';
}

// ============================================================
// Express Middleware: 自动生成 / 继承 Trace ID
// ============================================================

/**
 * Trace ID 中间件
 * - 如果请求带有 X-Trace-Id 头，则继承
 * - 否则生成新的 UUID v4
 * - 将 traceId 注入到 AsyncLocalStorage 和 Response Header
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] as string) || uuidv4();
  const startTime = Date.now();

  // 注入到响应头
  res.setHeader('X-Trace-Id', traceId);

  // 创建 Trace 上下文并运行
  traceStorage.run({ traceId, startTime }, () => {
    // 注入到 req 对象（方便日志中间件使用）
    (req as any).traceId = traceId;
    (req as any).traceStartTime = startTime;

    next();
  });
}

/**
 * 为 BullMQ Job 生成 Trace ID（继承自父请求上下文）
 */
export function getTraceIdForJob(parentTraceId?: string): string {
  return parentTraceId || uuidv4();
}
