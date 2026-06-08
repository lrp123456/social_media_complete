"use strict";
// Lightweight logger stub for browser-core package
// Production logging is handled by ts-api-gateway's Pino logger
Object.defineProperty(exports, "__esModule", { value: true });
exports.rootLogger = void 0;
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = process.env.LOG_LEVEL || 'info';
function log(level, ...args) {
    if (levels[level] >= levels[currentLevel]) {
        console.log(JSON.stringify({ level, time: new Date().toISOString(), msg: args.join(' ') }));
    }
}
exports.rootLogger = {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    child: (..._args) => exports.rootLogger,
};
//# sourceMappingURL=logger.js.map