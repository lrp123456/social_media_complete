// @ts-api-gateway/lib/logger.ts - Pino 结构化日志（注入 Trace ID）

import pino from 'pino';
import { getTraceId } from '../middleware/trace';
import { isProduction } from '@social-media/shared-config';

/**
 * 子日志器工厂：自动注入当前请求的 traceId
 */
export function createLogger(name: string): pino.Logger {
  return pino({
    name,
    level: isProduction() ? 'info' : 'debug',
    transport: isProduction()
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
    mixin() {
      return { traceId: getTraceId() };
    },
  });
}

/** 根日志器 */
export const logger = createLogger('ts-api-gateway');
