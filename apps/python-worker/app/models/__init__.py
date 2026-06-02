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
