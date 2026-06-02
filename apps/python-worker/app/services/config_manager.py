"""
Config Manager - Redis Pub/Sub 热配置监听器
订阅 config:updates 频道，运行时原地替换 Settings 属性
"""

import asyncio
import json
from typing import Callable, Dict, Any
import redis.asyncio as aioredis

from app.middleware.logging import logger

# 存储所有监听器回调
_config_listeners: Dict[str, list[Callable]] = {}


def on_config_update(config_key: str):
    """装饰器：注册配置变更回调"""
    def decorator(func: Callable):
        if config_key not in _config_listeners:
            _config_listeners[config_key] = []
        _config_listeners[config_key].append(func)
        return func
    return decorator


async def apply_config_update(key: str, new_value: Any):
    """触发配置变更回调"""
    from app.config import settings

    # 更新 Settings 对象
    if hasattr(settings, key):
        old_value = getattr(settings, key)
        setattr(settings, key, new_value)
        logger.info(f"⚡ 配置热更新: {key} = {new_value} (旧值: {old_value})")
    else:
        logger.warning(f"⚠️ 未知配置键: {key}")

    # 触发注册的回调
    if key in _config_listeners:
        for callback in _config_listeners[key]:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(new_value)
                else:
                    callback(new_value)
            except Exception as e:
                logger.error(f"配置回调执行失败 [{key}]: {e}")


async def config_listener(redis_url: str, channel: str = "config:updates"):
    """
    长驻任务: 监听 Redis Pub/Sub 配置更新频道
    在 FastAPI lifespan 中作为后台任务启动
    """
    redis = aioredis.from_url(redis_url)
    pubsub = redis.pubsub()

    try:
        await pubsub.subscribe(channel)
        logger.info(f"🎧 Config Manager 已订阅: {channel}")

        async for message in pubsub.listen():
            if message["type"] != "message":
                continue

            try:
                data = json.loads(message["data"])
                config_type = data.get("type", "unknown")
                logger.info(f"📡 收到配置广播: {config_type}")

                # 处理不同类型的配置更新
                if config_type == "config_updated":
                    config_key = data.get("configKey", data.get("key"))
                    config_value = data.get("configValue", data.get("value"))
                    if config_key:
                        await apply_config_update(config_key, config_value)

                elif config_type == "llm_key_rotated":
                    # LLM API Key 轮换
                    await apply_config_update("litellm_api_key", data.get("new_key", ""))

                elif config_type == "selector_updated":
                    # 选择器更新 - 触发 SelectorRegistry 重载
                    for callback in _config_listeners.get("selectors", []):
                        await callback(data)

                elif config_type == "full_reload":
                    # 全量重载所有配置
                    for key, value in data.get("config", {}).items():
                        await apply_config_update(key, value)

            except json.JSONDecodeError:
                logger.warning(f"无效的配置消息: {message['data']}")
            except Exception as e:
                logger.error(f"配置处理异常: {e}")

    except asyncio.CancelledError:
        logger.info("Config Manager 监听已取消")
    except Exception as e:
        logger.error(f"Config Manager 连接异常: {e}")
    finally:
        await pubsub.unsubscribe(channel)
        await redis.close()
