"""
素材更新任务 - 切分/抽帧/LLM评级/分类落盘
工作流: 下载素材 → FFmpeg场景切分 → 抽帧 → LLM风格评级 → 分类落盘
"""

import os
import shutil
import tempfile
from app.middleware.logging import logger
from app.middleware.trace import get_trace_id
from app.config import settings
from app.services.ffmpeg import download_from_oss
from app.services.llm_client import llm_client
from app.models import WebhookCallback
from app.services.webhook import callback_ts_webhook


MATERIAL_BASE = os.path.join(os.path.expanduser("~"), "data", "materials")


async def process_material_update(task_data: dict) -> dict:
    """
    素材更新主流程
    1. 下载原始素材
    2. FFmpeg 场景切分
    3. 抽帧（视频抽关键帧 / 图片直接评估）
    4. LLM 风格识别 + 等级评估
    5. 分类落盘到 data/materials/{style}/{space}/...
    """
    task_id = task_data["task_id"]
    trace_id = task_data.get("trace_id", task_id)

    logger.info(f"🎬 素材更新开始: {task_id}")

    temp_dir = tempfile.mkdtemp(prefix=f"material_{task_id}_")
    downloaded = []

    try:
        # 1. 下载素材
        oss_urls = task_data.get("oss_urls", [task_data.get("oss_url")])
        platform = task_data.get("platform", "unknown")

        for i, url in enumerate(oss_urls):
            if not url:
                continue
            local = os.path.join(temp_dir, f"source_{i}{_ext_from_url(url)}")
            await download_from_oss(url, local)
            downloaded.append(local)
            logger.info(f"素材下载: {os.path.basename(local)}")

        # 2. 逐素材处理
        results = []
        for src_path in downloaded:
            is_image = src_path.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif'))

            if is_image:
                # 图片：直接 LLM 评级
                result = await _rate_image(src_path)
            else:
                # 视频：场景切分 → 抽帧 → LLM 评级
                segments = await _split_scenes(src_path, temp_dir)
                frames = await _extract_keyframes(segments, temp_dir)
                if frames:
                    result = await _rate_video(frames)
                else:
                    result = {"style": "未分类", "space": "通用", "rating": "3"}

            results.append(result)

        # 3. 分类落盘
        moved = await _classify_and_store(downloaded, results, platform, task_id)

        # 4. 回调 TS
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="completed",
            result={
                "total": len(downloaded),
                "classified": moved,
                "styles": [r["style"] for r in results],
                "material_base": MATERIAL_BASE,
            },
        ))

        logger.info(f"✅ 素材更新完成: {task_id} ({moved}/{len(downloaded)} 分类)")
        return {"status": "completed", "task_id": task_id, "count": moved}

    except Exception as e:
        logger.error(f"❌ 素材更新失败: {task_id} - {e}")
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="failed",
            error=str(e),
        ))
        raise

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================
# 内部辅助函数
# ============================================================

async def _split_scenes(video_path: str, output_dir: str) -> list:
    """FFmpeg 场景切分"""
    import asyncio
    output_pattern = os.path.join(output_dir, "scene_%03d.mp4")
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", "select='gt(scene,0.3)',setpts=N/FRAME_RATE/TB",
        "-f", "segment", "-segment_time", "60",
        "-reset_timestamps", "1",
        "-c:v", "libx264", "-preset", "fast",
        "-y", output_pattern,
    ]
    proc = await asyncio.create_subprocess_exec(*cmd)
    await proc.communicate()

    segments = sorted([
        os.path.join(output_dir, f) for f in os.listdir(output_dir)
        if f.startswith("scene_") and f.endswith(".mp4")
    ])
    logger.info(f"场景切分: {len(segments)} 段")
    return segments


async def _extract_keyframes(segments: list, output_dir: str) -> list:
    """从每个场景段抽一帧"""
    import asyncio
    frames = []
    for i, seg in enumerate(segments):
        frame_path = os.path.join(output_dir, f"frame_{i:03d}.jpg")
        cmd = ["ffmpeg", "-i", seg, "-vframes", "1", "-q:v", "2", "-y", frame_path]
        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()
        if os.path.exists(frame_path):
            frames.append(frame_path)
    logger.info(f"抽帧完成: {len(frames)} 帧")
    return frames


async def _rate_image(image_path: str) -> dict:
    """LLM 图片风格评级"""
    prompt = """分析这张图片，返回 JSON（只返回 JSON 不要其他内容）：
{
  "style": "风格分类: 教程|娱乐|Vlog|评测|开箱|美食|旅行|音乐|时尚|运动|科技|自然",
  "space": "空间分类: 室内|户外|城市|自然|抽象|人物|静物|文字",
  "rating": "品质评级 1-5 (1最低,5最高)",
  "lighting": "光影评估: 明亮|暗调|自然|戏剧性",
  "mood": "情感基调: 温馨|激昂|幽默|严肃|治愈|炫酷"
}"""
    try:
        text = await llm_client.get_content("gemini-2.0-flash", [
            {"role": "user", "content": prompt}
        ])
        import json
        return json.loads(await _parse_json(text))
    except Exception as e:
        logger.warning(f"LLM 评级降级: {e}")
        return {"style": "未分类", "space": "通用", "rating": "3"}


async def _rate_video(frames: list) -> dict:
    """视频综合评级（取多帧平均）"""
    ratings = []
    for frame in frames[:3]:  # 最多评估3帧
        r = await _rate_image(frame)
        ratings.append(r)
    # 取众数风格
    from collections import Counter
    styles = Counter(r["style"] for r in ratings)
    return {
        "style": styles.most_common(1)[0][0],
        "space": ratings[0].get("space", "通用"),
        "rating": str(round(sum(int(r.get("rating", 3)) for r in ratings) / len(ratings))),
    }


async def _classify_and_store(sources: list, results: list, platform: str, task_id: str) -> int:
    """按 style/space/rating 分类落盘"""
    moved = 0
    for src, result in zip(sources, results):
        try:
            style = result.get("style", "未分类")
            space = result.get("space", "通用")
            rating = result.get("rating", "3")

            # 目标路径: data/materials/{style}/{space}/{platform}/{rating}/
            dest_dir = os.path.join(MATERIAL_BASE, style, space, platform, rating)
            os.makedirs(dest_dir, exist_ok=True)

            dest_path = os.path.join(dest_dir, os.path.basename(src))
            shutil.copy2(src, dest_path)
            moved += 1
            logger.info(f"归档: {os.path.relpath(dest_path, MATERIAL_BASE)}")
        except Exception as e:
            logger.warning(f"归档失败: {os.path.basename(src)} - {e}")
    return moved


def _ext_from_url(url: str) -> str:
    """从 URL 提取文件扩展名"""
    import os as _os
    from urllib.parse import urlparse
    ext = _os.path.splitext(urlparse(url).path)[1]
    return ext if ext else ".mp4"


async def _parse_json(text: str) -> str:
    """剥离 Markdown 代码块，返回纯 JSON 字符串"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1])
    return text
