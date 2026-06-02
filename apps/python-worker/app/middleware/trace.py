"""
Trace ID 中间件 - 全链路追踪（Python 端）
基于 python-json-logger + contextvars 实现异步安全的 Trace ID 绑定
"""

import uuid
import time
from contextvars import ContextVar
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# ============================================================
# Trace Context - 全链路追踪上下文
# ============================================================

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="no-trace")
trace_start_time_var: ContextVar[float] = ContextVar("trace_start_time", default=0.0)


def get_trace_id() -> str:
    """获取当前协程的 Trace ID"""
    return trace_id_var.get()


def get_trace_context() -> dict:
    """获取完整的 Trace 上下文"""
    return {
        "trace_id": trace_id_var.get(),
        "elapsed_ms": round((time.time() - trace_start_time_var.get()) * 1000, 2),
    }


def set_trace_id(trace_id: str) -> None:
    """手动设置 Trace ID（用于 ARQ Worker 任务）"""
    trace_id_var.set(trace_id)
    trace_start_time_var.set(time.time())


# ============================================================
# FastAPI Middleware
# ============================================================


class TraceMiddleware(BaseHTTPMiddleware):
    """
    Trace ID 中间件
    - 如果请求带有 X-Trace-Id 头，则继承
    - 否则生成新的 UUID v4
    - 将 trace_id 绑定到 contextvars
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        trace_id = request.headers.get("X-Trace-Id", str(uuid.uuid4()))
        trace_id_var.set(trace_id)
        trace_start_time_var.set(time.time())

        response: Response = await call_next(request)

        # 注入到响应头
        response.headers["X-Trace-Id"] = trace_id
        response.headers["X-Trace-Elapsed-Ms"] = str(
            round((time.time() - trace_start_time_var.get()) * 1000, 2)
        )

        return response
