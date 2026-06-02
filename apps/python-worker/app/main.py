"""
Python Worker - FastAPI 入口
纯无状态 API: 接收任务请求 → ARQ 入队 → 202 Accepted
"""

import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.config import settings
from app.middleware.trace import TraceMiddleware
from app.middleware.logging import logger
from app.routers import health, tasks, config as config_router
from app.workers.arq_app import close_arq

_config_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    global _config_task

    logger.info("🚀 Python Worker 启动")
    logger.info(f"   LiteLLM: {settings.litellm_url}")
    logger.info(f"   Webhook: {settings.ts_webhook_url}")

    # 启动 Config Manager 监听器（后台长驻任务）
    from app.services.config_manager import config_listener
    _config_task = asyncio.create_task(
        config_listener(settings.redis_url, "config:updates")
    )
    logger.info("🎧 Config Manager 已启动")

    yield

    # 关闭
    if _config_task:
        _config_task.cancel()
    await close_arq()
    logger.info("👋 Python Worker 关闭")


app = FastAPI(
    title="Social Media Python Worker",
    description="AI & Media Processing Engine",
    version="3.0.0",
    lifespan=lifespan,
)

# 全局 Trace ID 中间件
app.add_middleware(TraceMiddleware)

# 路由
app.include_router(health.router)
app.include_router(tasks.router)
app.include_router(config_router.router)
