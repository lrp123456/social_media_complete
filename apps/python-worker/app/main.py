"""
Python Worker - FastAPI 入口
纯无状态 API: 接收任务请求 → ARQ 入队 → 202 Accepted
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.config import settings
from app.middleware.trace import TraceMiddleware
from app.middleware.logging import logger
from app.routers import health, tasks
from app.workers.arq_app import close_arq


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    logger.info("🚀 Python Worker 启动")
    logger.info(f"   LiteLLM: {settings.litellm_url}")
    logger.info(f"   Webhook: {settings.ts_webhook_url}")
    yield
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
