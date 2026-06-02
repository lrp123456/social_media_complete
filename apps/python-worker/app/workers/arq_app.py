"""
ARQ 异步队列 - Python Worker
基于 Redis 的轻量级高并发异步队列 (替代 Celery)
"""

from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from app.config import settings
from app.middleware.logging import logger

_pool: ArqRedis | None = None


async def get_arq_queue() -> ArqRedis:
    """获取 ARQ 队列连接（单例）"""
    global _pool
    if _pool is None:
        redis_settings = RedisSettings.from_dsn(settings.redis_url)
        _pool = await create_pool(redis_settings)
        logger.info("ARQ 队列已连接")
    return _pool


async def close_arq():
    """关闭 ARQ 连接"""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("ARQ 队列已关闭")


# ARQ Worker 配置
class ArqWorkerConfig:
    """ARQ Worker 配置"""
    functions: list = []  # 在 tasks.py 中注册
    redis_settings: RedisSettings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs: int = 20
    job_timeout: int = 3600  # 1小时超时
    poll_delay: float = 0.5
