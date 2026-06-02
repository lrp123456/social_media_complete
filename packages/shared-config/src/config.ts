// @social-media/shared-config/config.ts - 环境变量加载与校验

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  // 数据库
  DATABASE_URL: z.string().url().default('postgresql://localhost:5432/social_media'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // 服务器
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TS_API_PORT: z.coerce.number().default(3001),
  TZ: z.string().default('Asia/Shanghai'),

  // OSS
  OSS_REGION: z.string().default('cn-beijing'),
  OSS_BUCKET: z.string().default('naite-mes'),
  OSS_ENDPOINT: z.string().default('img.naite.cc'),
  OSS_ACCESS_KEY_ID: z.string(),
  OSS_ACCESS_KEY_SECRET: z.string(),

  // Python Worker
  PYTHON_WORKER_URL: z.string().url().default('http://localhost:8000'),

  // LiteLLM
  LITELLM_URL: z.string().url().default('http://localhost:4000'),
  LITELLM_API_KEY: z.string().default(''),

  // 指纹浏览器
  ROXY_BROWSER_URL: z.string().url().default('http://localhost:54345'),
  BIT_BROWSER_URL: z.string().url().default('http://localhost:54346'),

  // 通知
  WECHAT_WEBHOOK_URL: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('配置校验失败:', result.error.format());
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === 'production';
}

export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === 'development';
}
