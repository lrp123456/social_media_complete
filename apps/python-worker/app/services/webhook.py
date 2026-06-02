"""
Webhook 回调服务 - Python → TS 异步通知
"""

import httpx
from app.config import settings
from app.middleware.logging import logger
from app.models import WebhookCallback
from app.middleware.trace import get_trace_id


async def callback_ts_webhook(callback: WebhookCallback) -> bool:
    """
    异步回调 TS 后端 Webhook
    携带 X-Trace-Id 实现全链路追踪
    """
    trace_id = get_trace_id()

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                settings.ts_webhook_url,
                json=callback.model_dump(),
                headers={"X-Trace-Id": trace_id},
            )
            response.raise_for_status()
            logger.info(f"✅ Webhook 回调成功: {callback.task_id}")
            return True
    except Exception as e:
        logger.error(f"❌ Webhook 回调失败: {callback.task_id} - {e}")
        return False
