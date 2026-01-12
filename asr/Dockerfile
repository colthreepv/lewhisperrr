FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["/bin/sh", "-c", "uvicorn app:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2} --timeout-keep-alive 30"]
