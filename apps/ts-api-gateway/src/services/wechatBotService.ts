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
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '企业微信机器人自动连接失败');
    }
  } else {
    logger.warn('未检测到企业微信机器人环境变量 (WECOM_BOT_ID / WECOM_BOT_SECRET)');
  }
}

setTimeout(() => { autoStartBot().catch(() => {}); }, 3000);
