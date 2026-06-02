"""
Python JSON Logger - 结构化日志 + Trace ID 自动注入
使用 python-json-logger + contextvars
"""

import logging
import sys
from datetime import datetime, timezone
from pythonjsonlogger import json
from .trace import get_trace_id


class TraceIdInjector(logging.Filter):
    """自动注入 trace_id 到日志记录"""
    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = get_trace_id()
        return True


def setup_logger(name: str = "python-worker") -> logging.Logger:
    """创建结构化 JSON 日志器"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    formatter = json.JsonFormatter(
        fmt="%(timestamp)s %(level)s %(name)s %(message)s",
        timestamp=True,
    )
    handler.setFormatter(formatter)

    logger.addHandler(handler)
    logger.addFilter(TraceIdInjector())

    return logger


# 根日志器
logger = setup_logger()
