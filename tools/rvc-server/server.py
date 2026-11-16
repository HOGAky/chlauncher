"""RVC voice-conversion server for the chlauncher TTS pipeline.

Edge/Piper synthesizes speech -> this server converts the audio into the
character's voice (models/ dir, one subfolder per voice with *.pth +
*.index). The launcher calls GET /health for status and POST /convert
with the WAV body to get the converted WAV back.

Run:  venv\\Scripts\\python.exe server.py   (after УСТАНОВИТЬ_RVC.cmd)
"""

import asyncio
import glob
import io
import os
import tempfile
import threading
import time

from fastapi import FastAPI, HTTPException, Query, Request, Response

BASE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE, "models")
# RVC_DEVICE=cuda:0 uses the GPU when PyTorch is the CUDA build.
DEVICE = os.environ.get("RVC_DEVICE", "cpu")

app = FastAPI(title="chlauncher-rvc")
# Отдельные локи: конверсия и TTS — разные модели, могут идти
# параллельно; тяжёлые вызовы выполняются в потоках (to_thread),
# event-loop не блокируется и /health отвечает мгновенно.
_rvc_lock = threading.Lock()
_silero_lock = threading.Lock()
_rvc = None
_init_err = None
_loaded = None
# Silero TTS — локальные нейроголоса (те же голоса, что в Яндексе).
# Грузится лениво при первом /tts — модель ~100 МБ качается один раз.
_silero = None
_silero_err = None
SILERO_SPEAKERS = {
    "aidar": "m",
    "eugene": "m",
    "baya": "f",
    "kseniya": "f",
    "xenia": "f",
    "random": "?",
}


_rvc_retry = 0.0


def _init():
    """Lazily construct RVCInference — hubert/rmvpe download (~100 MB)
    happens on first use, keep server startup instant. Ошибка НЕ
    лочится навсегда — transient сбой (сеть/диск) не должен убивать
    сервер до перезапуска; повтор с бэкоффом 15 с."""
    global _rvc, _init_err, _rvc_retry
    if _rvc is not None:
        return
    now = time.time()
    if _init_err is not None and now - _rvc_retry < 15:
        return
    _rvc_retry = now
    try:
        from rvc_python.infer import RVCInference

        _rvc = RVCInference(models_dir=MODELS_DIR, device=DEVICE)
        _init_err = None
    except Exception as e:  # noqa: BLE001 — surface install errors in /health
        _init_err = str(e)


def list_models() -> list:
    out = []
    if os.path.isdir(MODELS_DIR):
        for d in sorted(os.listdir(MODELS_DIR)):
            if glob.glob(os.path.join(MODELS_DIR, d, "*.pth")):
                out.append(d)
    return out


_silero_retry = 0.0
_silero_en = None
_silero_en_err = None
_silero_en_retry = 0.0

# Русские спикеры → ближайшие спикеры английской модели v3_en
# (en_* — числовые id; подобраны по полу, чтобы тембр не ломался).
EN_SPEAKER_MAP = {
    "aidar": "en_6",
    "eugene": "en_27",
    "baya": "en_71",
    "kseniya": "en_99",
    "xenia": "en_47",
    "random": "en_0",
}


def _detect_lang(text: str) -> str:
    """Cyrillic → ru-модель, иначе en (латиница/цифры/эмодзи)."""
    cyr = sum(1 for c in text if "Ѐ" <= c <= "ӿ")
    lat = sum(1 for c in text if c.isascii() and c.isalpha())
    return "ru" if cyr >= lat else "en"


def _silero_init():
    """Ленивая загрузка Silero TTS через torch.hub (~100 МБ один раз,
    кэш в ~/.cache/torch). v3_1_ru — стабильная русская модель.
    Ошибка не лочится — повтор с бэкоффом 15 с."""
    global _silero, _silero_err, _silero_retry
    if _silero is not None:
        return
    now = time.time()
    if _silero_err is not None and now - _silero_retry < 15:
        return
    _silero_retry = now
    try:
        import torch

        # Новый API silero-models: (model, example_text); сам model
        # имеет apply_tts(text, speaker, sample_rate, ...).
        model, _example = torch.hub.load(
            repo_or_dir="snakers4/silero-models",
            model="silero_tts",
            language="ru",
            speaker="v3_1_ru",
        )
        _silero = (model, 24000)
        _silero_err = None
    except Exception as e:  # noqa: BLE001
        _silero_err = str(e)


def _silero_en_init():
    """Английская Silero (v3_en) — ленивая, качается при первом
    латинском тексте. Тот же backoff 15 с."""
    global _silero_en, _silero_en_err, _silero_en_retry
    if _silero_en is not None:
        return
    now = time.time()
    if _silero_en_err is not None and now - _silero_en_retry < 15:
        return
    _silero_en_retry = now
    try:
        import torch

        model, _example = torch.hub.load(
            repo_or_dir="snakers4/silero-models",
            model="silero_tts",
            language="en",
            speaker="v3_en",
        )
        _silero_en = (model, 24000)
        _silero_en_err = None
    except Exception as e:  # noqa: BLE001
        _silero_en_err = str(e)


@app.get("/health")
def health():
    _init()
    return {
        "ok": _rvc is not None,
        "error": _init_err,
        "device": DEVICE,
        "models": list_models(),
        "loaded": _loaded,
        "speakers": list(SILERO_SPEAKERS),
        "silero_error": _silero_err,
    }


@app.post("/tts")
async def tts(request: Request, speaker: str = Query(default="aidar")):
    """Silero TTS: текст (UTF-8 body) -> WAV. Спикеры — SILERO_SPEAKERS.
    Язык авто-детектится: кириллица → v3_1_ru, латиница → v3_en."""
    if speaker not in SILERO_SPEAKERS:
        raise HTTPException(404, f"нет спикера '{speaker}'")
    text = (await request.body()).decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(400, "пустой текст")

    lang = _detect_lang(text)
    if lang == "en":
        _silero_en_init()
        if _silero_en is None:
            raise HTTPException(503, f"Silero EN не готов: {_silero_en_err}")
        model, sample_rate = _silero_en
        speaker = EN_SPEAKER_MAP.get(speaker, "en_0")
    else:
        _silero_init()
        if _silero is None:
            raise HTTPException(503, f"Silero не готов: {_silero_err}")
        model, sample_rate = _silero

    def _run():
        with _silero_lock:  # модель stateful — сериализуем
            audio = model.apply_tts(
                text=text,
                speaker=speaker,
                sample_rate=sample_rate,
                put_accent=True,
                put_yo=True,
            )
        import soundfile as sf

        buf = io.BytesIO()
        sf.write(buf, audio.numpy(), sample_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()

    # Блокирующий синтез — в поток, event-loop свободен.
    wav = await asyncio.to_thread(_run)
    return Response(content=wav, media_type="audio/wav")


@app.post("/convert")
async def convert(
    request: Request,
    model: str = Query(default=""),
    pitch: int = Query(default=0),
    index_rate: float = Query(default=-1.0),
):
    global _loaded
    _init()
    if _rvc is None:
        raise HTTPException(503, f"RVC не готов: {_init_err}")
    if model not in list_models():
        raise HTTPException(404, f"нет модели '{model}' в models/")
    data = await request.body()
    if not data:
        raise HTTPException(400, "пустое аудио")

    def _run():
        global _loaded
        with _rvc_lock:  # RVCInference is stateful — serialize conversions
            if _loaded != model:
                try:
                    _rvc.unload_model()
                except Exception:
                    pass
                # load_model takes the dir name inside models_dir; the
                # paired *.index is auto-detected by the library.
                _rvc.load_model(model)
                _loaded = model

            # Per-voice tuning from the launcher: semitone shift makes
            # female models actually feminine / deep models deeper;
            # index_rate controls how strongly the trained timbre shows.
            # f0up_key is always reset — params persist on the instance.
            params = {"f0up_key": pitch}
            if index_rate >= 0:
                params["index_rate"] = index_rate
            _rvc.set_params(**params)

            with tempfile.TemporaryDirectory() as td:
                inp = os.path.join(td, "in.wav")
                out = os.path.join(td, "out.wav")
                with open(inp, "wb") as f:
                    f.write(data)
                res = _rvc.infer_file(inp, out)
                # Some forks return the output path instead of `out`.
                if not os.path.isfile(out) and isinstance(res, str) and os.path.isfile(res):
                    out = res
                with open(out, "rb") as f:
                    return f.read()

    # Блокирующий инференс — в поток, event-loop свободен.
    wav = await asyncio.to_thread(_run)
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7865, log_level="warning")
