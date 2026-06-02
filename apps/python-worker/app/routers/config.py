"""配置读取路由 - 供 TS 端查询 Python Worker 当前配置"""

from fastapi import APIRouter
from app.config import settings
from app.middleware.logging import logger

router = APIRouter(prefix="/api/v1/config")


@router.get("/status")
async def config_status():
    """返回当前运行时的关键配置（脱敏）"""
    return {
        "litellm_url": settings.litellm_url,
        "ts_webhook_url": settings.ts_webhook_url,
        "output_width": settings.output_width,
        "output_height": settings.output_height,
        "output_fps": settings.output_fps,
    }
