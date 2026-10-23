"""Speech-to-text service: faster-whisper behind a tiny HTTP API.

POST /transcribe  (multipart field "file")  ->  {"text": str, "language": str, "duration": float}
Audio is processed in memory/temp storage and deleted immediately; nothing is retained.
"""
import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None  # e.g. "en"; None = auto-detect
MAX_BYTES = 10 * 1024 * 1024

app = FastAPI(title="stt")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    data = await file.read()
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(400, "audio must be 1 byte to 10 MB")
    # delete=False + manual unlink: Windows can't reopen a NamedTemporaryFile while it is open.
    tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
    try:
        tmp.write(data)
        tmp.close()
        segments, info = model.transcribe(
            tmp.name,
            language=LANGUAGE,
            beam_size=1,
            vad_filter=True,  # drop leading/trailing silence
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    finally:
        os.unlink(tmp.name)
    return {"text": text, "language": info.language, "duration": info.duration}
