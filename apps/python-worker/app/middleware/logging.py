"""
Python JSON Logger - 结构化日志 + Trace ID 自动注入
"""

import logging
import sys
from .trace import get_trace_id


class TraceIdInjector(logging.Filter):
    """自动注入 trace_id 到日志记录"""
    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = get_trace_id()
        return True


def setup_logger(name: str = "python-worker") -> logging.Logger:
    """创建结构化日志器"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter(
        '{"time": "%(asctime)s", "level": "%(levelname)s", "name": "%(name)s", '
        '"trace_id": "%(trace_id)s", "message": "%(message)s"}',
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.addFilter(TraceIdInjector())

    return logger


logger = setup_logger()
