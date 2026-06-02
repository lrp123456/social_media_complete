FROM python:3.11-slim

# apt 阿里云源
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y ffmpeg --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/python-worker/requirements.txt .
# pip 华为云源
RUN pip install --no-cache-dir -i https://mirrors.huaweicloud.com/repository/pypi/simple --trusted-host mirrors.huaweicloud.com -r requirements.txt

COPY apps/python-worker/app/ ./app/

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
