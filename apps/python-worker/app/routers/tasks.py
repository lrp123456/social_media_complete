"""
任务接收路由
POST /api/v1/tasks/material  - 素材分析
POST /api/v1/tasks/render    - 视频渲染
POST /api/v1/tasks/material-update - 素材更新(切分/抽帧/评级/落盘)
立即返回 202 Accepted，后台 ARQ 处理
"""

from fastapi import APIRouter, Response
from pydantic import BaseModel
from app.models import MaterialTaskRequest, RenderTaskRequest, TaskResponse
from app.workers.arq_app import get_arq_queue
from app.middleware.logging import logger


class MaterialUpdateRequest(BaseModel):
    """素材更新请求"""
    task_id: str
    task_type: str = "material_update"
    oss_urls: list[str]
    platform: str
    user_id: str | None = None


router = APIRouter(prefix="/api/v1/tasks")


@router.post("/material", status_code=202)
async def submit_material_task(req: MaterialTaskRequest, response: Response):
    """提交素材分析任务"""
    queue = await get_arq_queue()

    job = await queue.enqueue_job(
        "process_material",
        req.model_dump(),
        _job_id=req.task_id,
    )

    logger.info(f"Material 任务已入队: {req.task_id} (job={job.job_id})")

    return TaskResponse(
        accepted=True,
        task_id=req.task_id,
        arq_job_id=job.job_id,
    )


@router.post("/render", status_code=202)
async def submit_render_task(req: RenderTaskRequest, response: Response):
    """提交视频渲染任务"""
    queue = await get_arq_queue()

    job = await queue.enqueue_job(
        "process_render",
        req.model_dump(),
        _job_id=req.task_id,
    )

    logger.info(f"Render 任务已入队: {req.task_id} (job={job.job_id})")

    return TaskResponse(
        accepted=True,
        task_id=req.task_id,
        arq_job_id=job.job_id,
    )


@router.post("/material-update", status_code=202)
async def submit_material_update(req: MaterialUpdateRequest, response: Response):
    """提交素材更新任务（切分/抽帧/LLM评级/分类落盘）"""
    queue = await get_arq_queue()

    job = await queue.enqueue_job(
        "process_material_update",
        req.model_dump(),
        _job_id=req.task_id,
    )

    logger.info(f"MaterialUpdate 任务已入队: {req.task_id}")

    return TaskResponse(
        accepted=True,
        task_id=req.task_id,
        arq_job_id=job.job_id,
    )
