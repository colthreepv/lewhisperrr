import os
import tempfile
import time

from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

app = FastAPI()

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")

model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)


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
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        f.write(body)
        f.flush()

        segments, info = model.transcribe(
            f.name,
            language=request.query_params.get("language") or None,
            task=request.query_params.get("task") or "transcribe",
            vad_filter=True,
        )

        text = "".join([seg.text for seg in segments]).strip()

    return {
        "text": text,
        "language": info.language,
        "duration_sec": round(time.time() - t0, 3),
    }
