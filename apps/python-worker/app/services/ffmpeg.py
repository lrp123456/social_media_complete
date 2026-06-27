"""
FFmpeg 视频渲染服务
标准化输出: 1080x1920, 30fps, yuv420p
严禁 -c copy 避免音画不同步
"""

import asyncio
import os
import tempfile
from app.config import settings
from app.middleware.logging import logger


async def download_from_oss(oss_url: str, local_path: str) -> str:
    """从 OSS 下载文件到临时路径"""
    import oss2
    from urllib.parse import urlparse

    parsed = urlparse(oss_url)
    key = parsed.path.lstrip("/")

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, f"https://{settings.oss_endpoint}", settings.oss_bucket)

    # 异步下载
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bucket.get_object_to_file(key, local_path))

    logger.info(f"OSS 下载完成: {key} → {local_path}")
    return local_path


async def download_from_url(url: str, local_path: str, timeout: float = 120.0) -> str:
    """
    从 HTTP/HTTPS 直链下载文件到本地路径（流式下载）。
    用于素材更新热门视频采集场景，与 download_from_oss 并存。
    """
    import httpx

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(local_path, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    f.write(chunk)

    logger.info(f"HTTP 下载完成: {url} → {local_path}")
    return local_path


async def run_ffprobe(video_path: str) -> dict:
    """获取视频信息"""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video_path,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    import json
    return json.loads(stdout)


async def normalize_video(
    input_path: str,
    output_path: str,
) -> str:
    """
    标准化重编码
    1080x1920, 30fps, yuv420p - 绝不使用 -c copy
    """
    cmd = [
        "ffmpeg", "-i", input_path,
        "-vf", f"scale={settings.output_width}:{settings.output_height}:force_original_aspect_ratio=decrease,pad={settings.output_width}:{settings.output_height}:(ow-iw)/2:(oh-ih)/2",
        "-r", str(settings.output_fps),
        "-pix_fmt", settings.output_pix_fmt,
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-y",
        output_path,
    ]

    logger.info(f"FFmpeg 标准化: {input_path} → {output_path}")

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg 标准化失败: {stderr.decode()}")

    logger.info(f"FFmpeg 标准化完成: {output_path}")
    return output_path


async def concat_videos(input_paths: list[str], output_path: str) -> str:
    """多视频无损拼接"""
    # 创建 concat 文件列表
    list_path = tempfile.mktemp(suffix=".txt")
    try:
        with open(list_path, "w") as f:
            for path in input_paths:
                f.write(f"file '{path}'\n")

        cmd = [
            "ffmpeg", "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", settings.output_pix_fmt,
            "-y", output_path,
        ]

        logger.info(f"FFmpeg 拼接: {len(input_paths)} 文件 → {output_path}")

        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()

        if proc.returncode != 0:
            raise RuntimeError("FFmpeg 拼接失败")
    finally:
        if os.path.exists(list_path):
            os.unlink(list_path)

    logger.info(f"FFmpeg 拼接完成: {output_path}")
    return output_path


async def add_audio(video_path: str, audio_path: str, output_path: str) -> str:
    """添加/替换音频轨道"""
    cmd = [
        "ffmpeg", "-i", video_path, "-i", audio_path,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-y", output_path,
    ]

    proc = await asyncio.create_subprocess_exec(*cmd)
    await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError("FFmpeg 音频混合失败")

    return output_path


async def upload_to_oss(local_path: str, oss_key: str) -> str:
    """上传文件到 OSS，返回公开 URL"""
    import oss2

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, f"https://{settings.oss_endpoint}", settings.oss_bucket)

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bucket.put_object_from_file(oss_key, local_path))

    url = f"https://{settings.oss_endpoint}/{oss_key}"
    logger.info(f"OSS 上传完成: {oss_key} → {url}")
    return url
