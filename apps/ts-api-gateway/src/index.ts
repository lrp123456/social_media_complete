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
import systemRouter from './routes/system';
import monitorRouter from './routes/monitor';
import accountsRouter from './routes/accounts';
import tasksRouter from './routes/tasks';
import auditRouter from './routes/audit';
import llmRouter, { groupsRouter, promptsRouter } from './routes/llm';
import uploadRouter from './routes/upload';
import rbacRouter from './routes/rbac';
import notificationsRouter, { wecomRouter } from './routes/notifications';
import configInfraRouter from './routes/config-infra';
import configMediaRouter from './routes/config-media';
import configAutomationRouter from './routes/config-automation';
import configNetworkRouter from './routes/config-network';
import securityRouter from './routes/security';
import matrixRouter from './routes/matrix';
import materialsRouter from './routes/materials';
import operatorsRouter from './routes/operators';
import wecomBotRouter from './routes/wecom-bot';
import llmReplyRouter from './routes/llmReply';

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
app.use(helmet({
  // 兼容跨域 XHR: 关掉 Cross-Origin-Resource-Policy (CORP),
  // 否则浏览器会拦截跨源资源加载(例如 OSS 视频封面回源)。
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
// CORS: 生产/开发都用 origin: true (反射请求 Origin, 配 credentials: false 可放心用),
// 此前 isDevelopment 三元式在 production 传 undefined 等于禁用 CORS,导致前端所有调用被浏览器拦截。
app.use(cors({ origin: true, credentials: false }));
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
app.use('/api/v1/system', systemRouter);
app.use('/api/v1/monitor', monitorRouter);
app.use('/api/v1/accounts', accountsRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/audit', auditRouter);
app.use('/api/v1/llm', llmRouter);
app.use('/api/v1/upload', uploadRouter);
app.use('/api/v1/rbac', rbacRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/notifications/wecom', wecomRouter);         // 板块七: 企业微信通知
app.use('/api/v1/llm/groups', groupsRouter);                  // 板块三: LLM 工作组参数
app.use('/api/v1/llm/prompts', promptsRouter);                // 板块三: 提示词模板
app.use('/api/v1/config-infra', configInfraRouter);           // 板块一: 基础设施变量
app.use('/api/v1/config-media', configMediaRouter);           // 板块四: 智能创作与媒体渲染
app.use('/api/v1/config-automation', configAutomationRouter); // 板块五: 自动化矩阵核心
app.use('/api/v1/config-network', configNetworkRouter);       // 板块六: 网络路由与物理代理
app.use('/api/v1/security', securityRouter);                 // 板块八: 权限安全密钥
app.use('/api/v1/matrix', matrixRouter);                     // 社媒矩阵: 发布+账号+监控+评论
app.use('/api/v1/materials', materialsRouter);               // 素材更新: 采集+归档+统计
app.use('/api/v1/operators', operatorsRouter);               // 操作员管理: 用户+窗口+平台
app.use('/api/v1/wecom-bot', wecomBotRouter);                // 企业微信机器人: 连接+消息+绑定
app.use('/api/v1/llm/reply', llmReplyRouter);               // AI 客服: 回复建议生成

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

// 全局未捕获异常处理 — 防止 patchright "Frame was detached" 等错误导致进程崩溃
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Frame was detached') || msg.includes('Target closed') || msg.includes('Session closed')) {
    logger.warn({ error: msg }, '⚠️ 未捕获的浏览器帧错误（已忽略，防止进程崩溃）');
    return;
  }
  logger.error({ error: msg }, '⚠️ 未处理的 Promise 拒绝');
});

process.on('uncaughtException', (err: Error) => {
  const msg = err?.message || '';
  if (msg.includes('Frame was detached') || msg.includes('Target closed') || msg.includes('Session closed')) {
    logger.warn({ error: msg, stack: err.stack?.slice(0, 200) }, '⚠️ 未捕获的浏览器帧错误（已忽略，防止进程崩溃）');
    return;
  }
  logger.error({ error: msg, stack: err.stack }, '❌ 未捕获异常，进程将退出');
  process.exit(1);
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
