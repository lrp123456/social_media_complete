// @ts-api-gateway/middleware/errorHandler.ts - 全局错误处理中间件

import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger';
import { getTraceId } from './trace';

const logger = createLogger('error-handler');

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const traceId = getTraceId();

  logger.error({
    traceId,
    method: req.method,
    url: req.url,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: err.message,
    traceId,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Not Found: ${req.method} ${req.url}`,
    traceId: getTraceId(),
  });
}
