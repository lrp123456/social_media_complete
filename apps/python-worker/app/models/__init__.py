"""
Pydantic 数据模型 - Python Worker
"""

from pydantic import BaseModel, Field


class TaskType:
    material_analyze = "material_analyze"
    video_render = "video_render"
    style_classify = "style_classify"
    tts_synthesize = "tts_synthesize"


# ============================================================
# 请求模型
# ============================================================

class MaterialTaskRequest(BaseModel):
    task_id: str = Field(...)
    task_type: str = Field(default="material_analyze")
    oss_url: str = Field(...)
    options: dict | None = Field(default_factory=dict)


class RenderTaskRequest(BaseModel):
    task_id: str
    task_type: str = Field(default="video_render")
    oss_urls: list[str] = Field(..., min_length=1)
    bgm_oss_url: str | None = None
    narration_text: str | None = None
    output_filename: str = Field(default="rendered_output.mp4")
    options: dict | None = Field(default_factory=dict)


class MaterialUpdateRequest(BaseModel):
    """素材更新请求（热门视频采集）"""
    task_id: str
    task_type: str = "material_update"
    # 旧入口兼容
    oss_urls: list[str] = Field(default_factory=list)
    platform: str = "unknown"
    user_id: str | None = None
    # 新增字段（热门视频采集）
    candidate_id: str | None = None
    video_url: str | None = None
    frame_interval_ms: int = 1000
    evaluate_prompt: str | None = None
    styles: list[dict] | None = None
    min_rating: int = 4


# ============================================================
# 回调模型
# ============================================================

class WebhookCallback(BaseModel):
    task_id: str
    status: str
    result: dict | None = None
    error: str | None = None


class TaskResponse(BaseModel):
    accepted: bool = True
    task_id: str
    arq_job_id: str
