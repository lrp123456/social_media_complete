// @ts-api-gateway/index.ts - Express API Gateway 入口

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { loadConfig, isDevelopment } from '@social-media/shared-config';
import { traceMiddleware } from './middleware/trace';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createLogger } from './lib/logger';

// 路由
import webhookRouter from './routes/webhook';
import publishRouter from './routes/publish';
import configRouter from './routes/config';
import pinterestRouter from './routes/pinterest';
import composeRouter from './routes/compose';

// Workers
import { startTimeoutMonitor } from './services/publishService';
import { startMonitorScheduler } from './services/monitorService';

// ============================================================
// 初始化
// ============================================================

const config = loadConfig();
const logger = createLogger('server');

const app = express();
const PORT = config.TS_API_PORT;

// ============================================================
// 中间件
// ============================================================

// 全局 Trace ID（必须在其他中间件之前）
app.use(traceMiddleware);

// 日志中间件
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url, traceId: (req as any).traceId });
  next();
});

// 安全
app.use(helmet());
app.use(cors({ origin: isDevelopment() ? '*' : config.NODE_ENV === 'production' ? undefined : '*' }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// 路由
// ============================================================

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// API v1
app.use('/api/v1/webhook', webhookRouter);
app.use('/api/v1/publish', publishRouter);
app.use('/api/v1/config', configRouter);
app.use('/api/v1/pinterest', pinterestRouter);
app.use('/api/v1/compose', composeRouter);

// 404
app.use(notFoundHandler);

// 错误处理
app.use(errorHandler);

// ============================================================
// 启动
// ============================================================

app.listen(PORT, () => {
  logger.info(`🚀 TS API Gateway 已启动: http://localhost:${PORT}`);
  logger.info(`📝 环境: ${config.NODE_ENV}`);

  // 启动超时监控（Webhook 补兜）
  startTimeoutMonitor();

  // 启动监控调度器（定时评论检查）
  startMonitorScheduler();
});

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('⚠️  SIGTERM 信号，正在关闭...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('⚠️  SIGINT 信号，正在关闭...');
  process.exit(0);
});

export default app;
