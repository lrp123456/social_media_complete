"""
Python Worker 配置 - pydantic-settings
冷启动从环境变量加载，禁止从本地 .json 文件读取
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 服务器
    app_name: str = "python-worker"
    debug: bool = False

    # PostgreSQL (仅用于冷启动加载配置)
    database_url: str = "postgresql+asyncpg://localhost:5432/social_media"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # OSS
    oss_region: str = "cn-beijing"
    oss_bucket: str = "naite-mes"
    oss_endpoint: str = "img.naite.cc"
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""

    # TS Webhook 回调
    ts_webhook_url: str = "http://localhost:3001/api/v1/webhook/python-callback"

    # LiteLLM proxy
    litellm_url: str = "http://localhost:4000"
    litellm_api_key: str = ""

    # FFmpeg 输出标准
    output_width: int = 1080
    output_height: int = 1920
    output_fps: int = 30
    output_pix_fmt: str = "yuv420p"

    model_config = {"env_file": ".env", "case_sensitive": False}


settings = Settings()
