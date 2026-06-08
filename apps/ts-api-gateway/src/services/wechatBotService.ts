// @ts-api-gateway/services/wechatBotService.ts - 企业微信智能机器人长连接服务

import { createLogger } from '../lib/logger';

const logger = createLogger('wecom-bot');

// ============================================================
// 类型定义
// ============================================================

export interface BotConfig {
  botId: string;
  secret: string;
}

export interface BotStatus {
  connected: boolean;
  botId: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

export type MessageHandler = (msg: any) => Promise<void>;

// ============================================================
// Bot Manager (singleton)
// ============================================================

class WeChatBotManager {
  private client: any = null;
  private config: BotConfig | null = null;
  private status: BotStatus = {
    connected: false,
    botId: '',
    connectedAt: null,
    lastMessageAt: null,
    messageCount: 0,
  };
  private messageHandlers: MessageHandler[] = [];
  private pendingLinks = new Map<string, { resolve: (userid: string) => void; timeout: NodeJS.Timeout }>();
  private pendingReplies = new Map<string, {
    videoId: string;
    awemeId: string;
    userId: number;
    windowId: string;
    timeout: NodeJS.Timeout;
  }>();
  private pendingNotifications = new Map<string, {
    videoIds: string[];
    timestamp: number;
  }>();

  async start(config: BotConfig): Promise<BotStatus> {
    if (this.client && this.status.connected) {
      logger.warn('Bot already connected, stopping first...');
      await this.stop();
    }

    this.config = config;

    try {
      const { WSClient } = await import('@wecom/aibot-node-sdk');

      this.client = new WSClient({
        botId: config.botId,
        secret: config.secret,
      });

      // Listen for messages via EventEmitter
      this.client.on('message', async (msg: any) => {
        logger.info(`收到消息: from=${msg.body?.from?.userid}, type=${msg.body?.msgtype}, content=${msg.body?.text?.content}`);

        this.status.lastMessageAt = new Date().toISOString();
        this.status.messageCount++;

        const userid = msg.body?.from?.userid;
        const content = msg.body?.text?.content?.trim();

        // Check if this message matches a pending link request
        if (content && this.pendingLinks.has(content)) {
          const pending = this.pendingLinks.get(content)!;
          clearTimeout(pending.timeout);
          this.pendingLinks.delete(content);
          pending.resolve(userid);
          logger.info(`链接请求 ${content} 已匹配用户 ${userid}`);

          // Reply to user
          try {
            await this.client.reply(msg, {
              msgtype: 'markdown',
              markdown: { content: `✅ 已成功绑定用户ID: **${userid}**` },
            });
          } catch (err) {
            logger.error({ err: (err as Error).message }, '回复消息失败');
          }
          return;
        }

        // Call registered message handlers
        for (const handler of this.messageHandlers) {
          try {
            await handler(msg);
          } catch (err) {
            logger.error({ err: (err as Error).message }, '消息处理器异常');
          }
        }
      });

      this.client.on('connected', () => {
        logger.info('WebSocket 连接已建立');
      });

      this.client.on('authenticated', () => {
        this.status.connected = true;
        this.status.botId = config.botId;
        this.status.connectedAt = new Date().toISOString();
        logger.info(`🤖 企业微信机器人已认证: botId=${config.botId}`);
      });

      this.client.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'WebSocket 错误');
      });

      this.client.on('disconnected', (reason: string) => {
        this.status.connected = false;
        logger.warn(`WebSocket 断开: ${reason}`);
      });

      // Connect
      this.client.connect();

      return { ...this.status };
    } catch (err) {
      logger.error({ err: (err as Error).message }, '机器人连接失败');
      this.status.connected = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '关闭连接时出错');
      }
      this.client = null;
    }

    for (const [code, pending] of this.pendingLinks) {
      clearTimeout(pending.timeout);
      pending.resolve('');
      logger.warn(`链接请求 ${code} 已取消（机器人断开）`);
    }
    this.pendingLinks.clear();

    this.status.connected = false;
    this.status.botId = '';
    logger.info('🤖 企业微信机器人已断开');
  }

  getStatus(): BotStatus {
    return { ...this.status };
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  setPendingReply(
    commentCid: string,
    context: { videoId: string; awemeId: string; userId: number; windowId: string },
    timeoutMs = 300_000,
  ): void {
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      this.pendingReplies.delete(commentCid);
      logger.info({ commentCid }, '待回复上下文超时，已清除');
    }, timeoutMs);

    this.pendingReplies.set(commentCid, { ...context, timeout });
    logger.info({ commentCid, ...context }, '已设置待回复上下文');
  }

  getPendingReply(commentCid: string) {
    return this.pendingReplies.get(commentCid);
  }

  clearPendingReply(commentCid: string): void {
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);
    this.pendingReplies.delete(commentCid);
  }

  trackNotification(userid: string, videoIds: string[]): void {
    this.pendingNotifications.set(userid, { videoIds, timestamp: Date.now() });
    // Auto-expire after 24 hours
    setTimeout(() => {
      this.pendingNotifications.delete(userid);
    }, 24 * 60 * 60 * 1000);
    logger.info({ userid, videoIds }, '已跟踪评论通知，等待用户交互');
  }

  consumeNotification(userid: string): { videoIds: string[]; timestamp: number } | undefined {
    const pending = this.pendingNotifications.get(userid);
    if (pending) {
      this.pendingNotifications.delete(userid);
      return pending;
    }
    return undefined;
  }

  createLinkRequest(timeoutMs = 120_000): { code: string; promise: Promise<string> } {
    const code = String(Math.floor(100000 + Math.random() * 900000));

    const promise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingLinks.delete(code);
        resolve('');
        logger.warn(`链接请求 ${code} 超时`);
      }, timeoutMs);

      this.pendingLinks.set(code, { resolve, timeout });
    });

    logger.info(`创建链接请求: code=${code}, timeout=${timeoutMs}ms`);
    return { code, promise };
  }

  async sendTextMessage(userids: string[], content: string): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    for (const userid of userids) {
      await this.client.sendMessage(userid, {
        msgtype: 'markdown',
        markdown: { content },
      });
    }

    logger.info(`发送消息给 ${userids.join(', ')}: ${content.substring(0, 50)}...`);
  }

  async sendTemplateCard(userids: string[], card: any): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    for (const userid of userids) {
      await this.client.sendMessage(userid, {
        msgtype: 'template_card',
        template_card: card,
      });
    }

    logger.info(`发送模板卡片给 ${userids.join(', ')}`);
  }

  async replyMessage(frame: any, content: string): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    await this.client.reply(frame, {
      msgtype: 'markdown',
      markdown: { content },
    });
  }
}

// Singleton instance
export const botManager = new WeChatBotManager();

// 启动时自动从环境变量连接机器人
async function autoStartBot(): Promise<void> {
  const botId = process.env.WECOM_BOT_ID;
  const secret = process.env.WECOM_BOT_SECRET;

  if (botId && secret) {
    try {
      await botManager.start({ botId, secret });
      logger.info(`🤖 企业微信机器人自动连接成功: botId=${botId}`);

      // 注册评论回复消息处理器
      botManager.onMessage(async (msg: any) => {
        const userid = msg.body?.from?.userid;
        const content = (msg.body?.text?.content || '').trim();
        if (!userid || !content) return;

        // 匹配回复意图: 格式 "回复 <awemeId> <commentCid>"（来自 jump_list type=3）
        const replySetup = content.match(/^回复\s+(\S+)\s+(\S+)$/);
        if (replySetup) {
          const awemeId = replySetup[1];
          const commentCid = replySetup[2];

          // 动态导入 prisma（避免循环依赖）
          const { prisma } = await import('../lib/prisma');
          const user = await prisma.user.findFirst({
            where: { wechatUserid: userid },
            select: { id: true },
          }).catch(() => null);

          if (!user) return;

          const window = await (prisma as any).browserWindow?.findFirst({
            where: { userId: user.id, platform: 'douyin' },
            select: { fingerprintWindowId: true },
          }).catch(() => null);

          if (!window) {
            await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口');
            return;
          }

          botManager.setPendingReply(commentCid, {
            videoId: awemeId, awemeId, userId: user.id, windowId: window.fingerprintWindowId,
          });

          await botManager.sendTextMessage([userid], `💬 已选择回复评论，请直接发送回复内容（5分钟内有效）`);
          return;
        }

        // 匹配实际回复文本（用户不在"回复"前缀模式下直接发送文本）
        for (const [commentCid, ctx] of botManager['pendingReplies']) {
          const { prisma } = await import('../lib/prisma');
          const user = await prisma.user.findFirst({
            where: { wechatUserid: userid },
            select: { id: true },
          }).catch(() => null);

          if (user && ctx.userId === user.id) {
            botManager.clearPendingReply(commentCid);

            // 入队回复任务
            const { monitorQueue } = await import('./monitorService');
            await (monitorQueue as any).add('execute_reply', {
              taskId: `reply_${Date.now()}_${commentCid}`,
              userId: ctx.userId,
              platform: 'douyin',
              windowId: ctx.windowId,
              fingerprintWindowId: ctx.windowId,
              replyData: {
                videoId: ctx.videoId,
                commentCid,
                text: content,
              },
            });

            const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;
            await botManager.sendTextMessage([userid], `✅ 回复已提交: "${preview}"`);
            return;
          }
        }

        // 用户发送任意消息 → 标记通知中的评论为已读
        const notification = botManager.consumeNotification(userid);
        if (notification) {
          try {
            const { prisma } = await import('../lib/prisma');
            let totalMarked = 0;
            for (const videoId of notification.videoIds) {
              const result = await prisma.comment.updateMany({
                where: { videoId, isNew: 1 },
                data: { isNew: 0 },
              });
              totalMarked += result.count;
            }
            logger.info({ userid, videoIds: notification.videoIds, totalMarked }, '用户已读通知中的评论');
          } catch (err) {
            logger.warn({ err: (err as Error).message, userid }, '标记通知评论已读失败');
          }
        }
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '企业微信机器人自动连接失败');
    }
  } else {
    logger.warn('未检测到企业微信机器人环境变量 (WECOM_BOT_ID / WECOM_BOT_SECRET)');
  }
}

setTimeout(() => { autoStartBot().catch(() => {}); }, 3000);
