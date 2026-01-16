import os
import tempfile
import time

import anyio
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

app = FastAPI()

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")
MAX_TRANSCRIBE_WORKERS = int(os.getenv("MAX_TRANSCRIBE_WORKERS", "1"))
BEAM_SIZE_RAW = os.getenv("BEAM_SIZE")

try:
    BEAM_SIZE = int(BEAM_SIZE_RAW) if BEAM_SIZE_RAW else None
except ValueError:
    BEAM_SIZE = None

model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
transcribe_limiter = anyio.Semaphore(MAX_TRANSCRIBE_WORKERS)


def _run_transcribe(path: str, language: str | None, task: str):
    return model.transcribe(
        path,
        language=language or None,
        task=task or "transcribe",
        vad_filter=True,
        beam_size=BEAM_SIZE,
    )


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/transcribe")
async def transcribe(request: Request):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")

    t0 = time.time()
    language = request.query_params.get("language") or None
    task = request.query_params.get("task") or "transcribe"

    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        f.write(body)
        f.flush()

        async with transcribe_limiter:
            segments, info = await anyio.to_thread.run_sync(
                _run_transcribe,
                f.name,
                language,
                task,
            )

        text = "".join([seg.text for seg in segments]).strip()

    return {
        "text": text,
        "language": info.language,
        "duration_sec": round(time.time() - t0, 3),
    }
