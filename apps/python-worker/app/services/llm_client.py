"""
LiteLLM Client - 大模型网关客户端
"""

import httpx
from app.config import settings
from app.middleware.logging import logger


class LiteLLMClient:
    """LiteLLM Proxy 客户端（单例）"""

    _instance: "LiteLLMClient | None" = None
    _client: httpx.AsyncClient

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._client = httpx.AsyncClient(
                base_url=settings.litellm_url,
                headers={
                    "Authorization": f"Bearer {settings.litellm_api_key}",
                    "Content-Type": "application/json",
                },
                timeout=120.0,
            )
        return cls._instance

    async def chat_completion(
        self,
        model: str,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> dict:
        """调用 LiteLLM Chat Completions"""
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        logger.info(f"LLM 请求: model={model}, msgs={len(messages)}")
        response = await self._client.post("/chat/completions", json=payload)
        response.raise_for_status()
        result = response.json()
        logger.info(f"LLM 响应: tokens={result.get('usage', {}).get('total_tokens', '?')}")
        return result

    async def get_content(self, model: str, messages: list[dict]) -> str:
        """获取 LLM 文本回复"""
        result = await self.chat_completion(model, messages)
        return result["choices"][0]["message"]["content"]

    async def material_analyze(self, description: str) -> dict:
        """素材内容分析"""
        prompt = f"""分析以下视频素材的内容特征，返回 JSON:
{{
  "category": "内容分类 (教程/娱乐/Vlog/评测/开箱/美食/旅行/音乐/时尚/运动/其他)",
  "style": "视觉风格 (现代/复古/极简/华丽/自然/科技/手绘)",
  "mood": "情感基调 (温馨/激昂/幽默/严肃/治愈/炫酷)",
  "score": {{
    "quality": "画质评分 1-10",
    "creativity": "创意评分 1-10",
    "engagement": "吸引力评分 1-10"
  }},
  "suggested_bgm": "建议配乐风格",
  "highlights": ["亮点1", "亮点2"]
}}

素材描述: {description}"""
        text = await self.get_content("gemini-2.0-flash", [
            {"role": "user", "content": prompt}
        ])
        import json
        return json.loads(text)

    async def close(self):
        await self._client.aclose()


llm_client = LiteLLMClient()
