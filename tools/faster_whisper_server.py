#!/usr/bin/env python3
import argparse
import os
import tempfile
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn
from faster_whisper import WhisperModel

app = FastAPI()
model: Optional[WhisperModel] = None
model_name = ""


@app.get("/health")
def health():
    return {"status": "ok", "model": model_name}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": model_name, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), language: Optional[str] = Form(None), req_model: Optional[str] = Form(None, alias="model")):
    loaded = model
    if loaded is None:
        return JSONResponse({"error": {"message": "model not loaded"}}, status_code=503)
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        lang = None if not language or language == "auto" else language
        segments, info = loaded.transcribe(tmp_path, language=lang, beam_size=1, vad_filter=True)
        text = "".join(seg.text for seg in segments).strip()
        return {"text": text, "language": getattr(info, "language", lang), "model": model_name}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    global model, model_name
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8179)
    parser.add_argument("--model", default=os.environ.get("FASTER_WHISPER_MODEL", "small"))
    parser.add_argument("--device", default=os.environ.get("FASTER_WHISPER_DEVICE", "auto"))
    parser.add_argument("--compute-type", default=os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "int8"))
    args = parser.parse_args()
    model_name = args.model
    device = args.device
    if device == "auto":
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    model = WhisperModel(args.model, device=device, compute_type=args.compute_type)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()