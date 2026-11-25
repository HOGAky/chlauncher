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
import re
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


# ---------------------------------------------------------------------------
# Цифры → слова. Silero не произносит числительные — «15» молча выпадает
# из речи, поэтому перед синтезом текст нормализуется: «15» → «пятнадцать».
# ---------------------------------------------------------------------------

_RU_ONES = [
    "ноль", "один", "два", "три", "четыре",
    "пять", "шесть", "семь", "восемь", "девять",
]
_RU_TEENS = [
    "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
    "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
]
_RU_TENS = [
    "", "", "двадцать", "тридцать", "сорок",
    "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто",
]
_RU_HUNDREDS = [
    "", "сто", "двести", "триста", "четыреста",
    "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот",
]
_EN_ONES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven",
    "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
    "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
]
_EN_TENS = [
    "", "", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety",
]


def _ru_plural(n: int, forms: tuple) -> str:
    n = abs(n) % 100
    if 11 <= n <= 19:
        return forms[2]
    n %= 10
    if n == 1:
        return forms[0]
    if 2 <= n <= 4:
        return forms[1]
    return forms[2]


def _ru_tri(n: int, female: bool = False) -> str:
    parts = []
    h, rem = divmod(n, 100)
    t, o = divmod(rem, 10)
    if h:
        parts.append(_RU_HUNDREDS[h])
    if t == 1:
        parts.append(_RU_TEENS[o])
    else:
        if t:
            parts.append(_RU_TENS[t])
        if o:
            if female and o == 1:
                parts.append("одна")
            elif female and o == 2:
                parts.append("две")
            else:
                parts.append(_RU_ONES[o])
    return " ".join(parts)


def _num_ru(n: int) -> str:
    if n < 0:
        return "минус " + _num_ru(-n)
    if n == 0:
        return "ноль"
    parts = []
    for scale, female, forms in (
        (1_000_000, False, ("миллион", "миллиона", "миллионов")),
        (1_000, True, ("тысяча", "тысячи", "тысяч")),
    ):
        q, n = divmod(n, scale)
        if q:
            parts.append(_ru_tri(q, female))
            parts.append(_ru_plural(q, forms))
    if n:
        parts.append(_ru_tri(n))
    return " ".join(p for p in parts if p)


def _num_en(n: int) -> str:
    if n < 0:
        return "minus " + _num_en(-n)
    if n < 20:
        return _EN_ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return _EN_TENS[t] + (("-" + _EN_ONES[o]) if o else "")
    if n < 1000:
        h, rem = divmod(n, 100)
        return _EN_ONES[h] + " hundred" + ((" " + _num_en(rem)) if rem else "")
    for scale, name in ((1_000_000, "million"), (1_000, "thousand")):
        q, n = divmod(n, scale)
        if q:
            return _num_en(q) + f" {name}" + ((" " + _num_en(n)) if n else "")
    return str(n)


_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")

# Алфавит Silero: кириллица/латиница/цифры + базовая пунктуация.
# Всё прочее (CJK, эмодзи, экзотика) роняет apply_tts с ValueError.
_SILERO_BAD = re.compile(r"[^0-9A-Za-zА-Яа-яЁё\s.,!?;:—–\-()«»\"'/%+*=]")


def _sanitize_for_silero(t: str) -> str:
    t = _SILERO_BAD.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def _normalize_numbers(text: str, lang: str) -> str:
    conv = _num_en if lang == "en" else _num_ru

    def _rep(m: "re.Match") -> str:
        tok = m.group(0)
        for sep in (",", "."):
            if sep in tok:
                a, b = tok.split(sep, 1)
                if b.isdigit():
                    word = "point" if lang == "en" else "запятая"
                    return f"{conv(int(a))} {word} {conv(int(b))}"
        if len(tok) > 9:  # длинные ряды цифр — по одной
            return " ".join(conv(int(d)) for d in tok)
        return conv(int(tok))

    return _NUM_RE.sub(_rep, text)


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
async def tts(
    request: Request,
    speaker: str = Query(default="aidar"),
    speed: float = Query(default=1.0),
    vol: float = Query(default=1.0),
):
    """Silero TTS: текст (UTF-8 body) -> WAV. Спикеры — SILERO_SPEAKERS.
    Язык авто-детектится: кириллица → v3_1_ru, латиница → v3_en.
    speed>1 — быстрее и выше тоном (ресемпл), <1 — медленнее и ниже;
    vol — множитель громкости. Через них лаунчер передаёт rate и
    интонации (шёпот/крик и т.д.) — Silero сам их не умеет."""
    if speaker not in SILERO_SPEAKERS:
        raise HTTPException(404, f"нет спикера '{speaker}'")
    text = (await request.body()).decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(400, "пустой текст")

    lang = _detect_lang(text)
    # Silero проглатывает цифры — пишем их словами до синтеза.
    text = _normalize_numbers(text, lang)
    # И падает с ValueError на символах вне алфавита (CJK, эмодзи,
    # экзотика) — в никах ответов их много. Чистим до произносимого.
    text = _sanitize_for_silero(text)
    if not text:
        raise HTTPException(400, "нет произносимого текста")
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
            try:
                audio = model.apply_tts(
                    text=text,
                    speaker=speaker,
                    sample_rate=sample_rate,
                    put_accent=True,
                    put_yo=True,
                )
            except ValueError:
                # Последний рубеж: оставить только буквы/цифры/пробелы.
                fallback = re.sub(r"[^\w\s]", " ", text)
                fallback = re.sub(r"\s+", " ", fallback).strip()
                if not fallback:
                    raise
                audio = model.apply_tts(
                    text=fallback,
                    speaker=speaker,
                    sample_rate=sample_rate,
                    put_accent=True,
                    put_yo=True,
                )
        import soundfile as sf

        audio = audio.reshape(-1)
        # Темп+тон ресемплом: new_sr=sr/speed → speed>1 даёт меньше
        # сэмплов → при записи с исходной частотой звучит быстрее и выше.
        if abs(speed - 1.0) > 0.01 or abs(vol - 1.0) > 0.01:
            import torch
            import torchaudio

            if abs(speed - 1.0) > 0.01:
                k = max(0.4, min(2.5, speed))
                audio = torchaudio.functional.resample(
                    audio.unsqueeze(0), sample_rate, int(round(sample_rate / k))
                ).squeeze(0)
            if abs(vol - 1.0) > 0.01:
                audio = torch.clamp(audio * max(0.0, min(2.5, vol)), -1.0, 1.0)

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
