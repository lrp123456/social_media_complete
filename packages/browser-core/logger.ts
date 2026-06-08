// Lightweight logger stub for browser-core package
// Production logging is handled by ts-api-gateway's Pino logger

const levels: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = process.env.LOG_LEVEL || 'info';

function log(level: string, ...args: unknown[]) {
  if (levels[level] >= levels[currentLevel]) {
    console.log(JSON.stringify({ level, time: new Date().toISOString(), msg: args.join(' ') }));
  }
}

export const rootLogger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
  child: (..._args: unknown[]) => rootLogger,
};
