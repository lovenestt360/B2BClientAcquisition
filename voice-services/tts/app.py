"""Text-to-speech service: Chatterbox TTS behind a tiny HTTP API.

POST /synthesize {"text": str, "voice_ref": str | null, "exaggeration": float}  ->  audio/wav

Voice cloning uses a reference clip from VOICES_DIR only. The app enforces that a cloned voice is
used only after the user attests it is their own voice (or licensed); this service additionally
refuses any path outside VOICES_DIR.
"""
import io
import os
from pathlib import Path

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

VOICES_DIR = Path(os.getenv("VOICES_DIR", "/voices")).resolve()
DEVICE = os.getenv("TTS_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")

app = FastAPI(title="tts")
model = ChatterboxTTS.from_pretrained(device=DEVICE)


class SynthesizeIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice_ref: str | None = None
    exaggeration: float = Field(default=0.5, ge=0.0, le=1.0)


def resolve_voice(name: str | None) -> str | None:
    if not name:
        return None
    path = (VOICES_DIR / name).resolve()
    if path.parent != VOICES_DIR or not path.is_file():
        raise HTTPException(400, "unknown voice reference")
    return str(path)


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "voices": sorted(p.name for p in VOICES_DIR.glob("*") if p.is_file())}


@app.post("/synthesize")
def synthesize(body: SynthesizeIn):
    wav = model.generate(body.text, audio_prompt_path=resolve_voice(body.voice_ref), exaggeration=body.exaggeration)
    buf = io.BytesIO()
    ta.save(buf, wav, model.sr, format="wav")
    return Response(content=buf.getvalue(), media_type="audio/wav")
