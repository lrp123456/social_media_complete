"""
ARQ Worker 任务处理器
process_material: AI 素材分析
process_render: FFmpeg 视频渲染
process_material_update: 素材更新（切分/抽帧/LLM评级/分类落盘）
"""

import json
import os
import tempfile
from arq.worker import func
from app.config import settings
from app.middleware.logging import logger
from app.middleware.trace import set_trace_id
from app.models import WebhookCallback
from app.services.llm_client import llm_client
from app.services.ffmpeg import (
    download_from_oss,
    normalize_video,
    concat_videos,
    upload_to_oss,
)
from app.services.webhook import callback_ts_webhook
from app.workers.arq_app import ArqWorkerConfig


async def startup(ctx):
    """Worker 启动"""
    logger.info("ARQ Worker 启动")


async def shutdown(ctx):
    """Worker 关闭"""
    logger.info("ARQ Worker 关闭")


# ============================================================
# 任务处理函数
# ============================================================


async def process_material(ctx, task_data: dict) -> dict:
    """
    素材分析任务
    1. 从 OSS 获取素材
    2. 调用 LLM 分析内容
    3. 回调 TS Webhook
    """
    task_id = task_data["task_id"]
    trace_id = task_data.get("trace_id", task_id)
    set_trace_id(trace_id)

    logger.info(f"🎬 开始素材分析: {task_id}")

    try:
        oss_url = task_data["oss_url"]
        description = task_data.get("options", {}).get("description", "未知素材")

        # 调用 LLM 分析
        analysis = await llm_client.material_analyze(description)

        # 回调 TS
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="completed",
            result={"analysis": analysis},
        ))

        logger.info(f"✅ 素材分析完成: {task_id}")
        return {"status": "completed", "task_id": task_id}

    except Exception as e:
        logger.error(f"❌ 素材分析失败: {task_id} - {e}")
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="failed",
            error=str(e),
        ))
        raise


async def process_render(ctx, task_data: dict) -> dict:
    """
    视频渲染任务
    1. 从 OSS 下载源素材
    2. 标准化重编码（1080x1920, 30fps, yuv420p）
    3. 拼接多段视频
    4. 上传成品到 OSS
    5. 回调 TS Webhook
    """
    task_id = task_data["task_id"]
    trace_id = task_data.get("trace_id", task_id)
    set_trace_id(trace_id)

    logger.info(f"🎥 开始视频渲染: {task_id} ({len(task_data['oss_urls'])} 段素材)")

    temp_dir = tempfile.mkdtemp(prefix=f"render_{task_id}_")
    downloaded = []
    normalized = []

    try:
        # 1. 下载素材
        for i, url in enumerate(task_data["oss_urls"]):
            local = os.path.join(temp_dir, f"input_{i}.mp4")
            await download_from_oss(url, local)
            downloaded.append(local)

        # 2. 标准化重编码（绝不使用 -c copy）
        for i, path in enumerate(downloaded):
            norm_path = os.path.join(temp_dir, f"norm_{i}.mp4")
            await normalize_video(path, norm_path)
            normalized.append(norm_path)

        # 3. 拼接
        concat_output = os.path.join(temp_dir, task_data.get("output_filename", "output.mp4"))
        if len(normalized) > 1:
            await concat_videos(normalized, concat_output)
        else:
            os.rename(normalized[0], concat_output)

        # 4. 上传到 OSS
        date = task_id[:8]  # YYYYMMDD
        oss_key = f"rendered/{date}/{task_id}.mp4"
        result_url = await upload_to_oss(concat_output, oss_key)

        # 获取视频时长
        duration = 0
        try:
            from app.services.ffmpeg import run_ffprobe
            info = await run_ffprobe(concat_output)
            duration = float(info["format"].get("duration", 0))
        except:
            pass

        # 5. 回调 TS
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="completed",
            result={
                "oss_url": result_url,
                "duration": duration,
                "segments": len(task_data["oss_urls"]),
            },
        ))

        logger.info(f"✅ 视频渲染完成: {task_id} → {result_url}")
        return {"status": "completed", "task_id": task_id, "oss_url": result_url}

    except Exception as e:
        logger.error(f"❌ 视频渲染失败: {task_id} - {e}")
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="failed",
            error=str(e),
        ))
        raise

    finally:
        # 清理临时文件
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)


# 导入素材更新任务
from app.workers.material_tasks import process_material_update

# Worker 配置
class WorkerSettings:
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = ArqWorkerConfig.redis_settings
    functions = [process_material, process_render, process_material_update]
    max_jobs = ArqWorkerConfig.max_jobs
