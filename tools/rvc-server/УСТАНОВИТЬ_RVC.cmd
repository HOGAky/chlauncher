@echo off
chcp 65001 >nul
cd /d "%~dp0"
title RVC — установка (один раз)

echo ==============================================================
echo   RVC-сервер для озвучки — установка зависимостей
echo   Нужно ~3-4 ГБ и время (PyTorch качается ~200-800 МБ)
echo ==============================================================
echo.

py -3.11 --version >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Python 3.11 не найден!
    echo.
    echo Установи Python 3.11 с python.org — при установке ОБЯЗАТЕЛЬНО
    echo поставь галочку "Add python.exe to PATH", потом запусти этот файл снова.
    start https://www.python.org/downloads/release/python-3119/
    pause
    exit /b 1
)

if not exist venv\Scripts\python.exe (
    echo [1/5] Создаю виртуальное окружение...
    py -3.11 -m venv venv
    if errorlevel 1 ( echo [ОШИБКА] venv не создался & pause & exit /b 1 )
)
call venv\Scripts\activate.bat

echo [2/5] Обновляю pip...
python -m pip install --upgrade pip --quiet

echo [3/5] Ставлю PyTorch 2.3.1 (CPU-версия, ~200 МБ)...
rem ВАЖНО: именно 2.3.1 — torch >= 2.6 ломает загрузку чекпоинтов
rem fairseq/hubert (weights_only по умолчанию = True).
pip install torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 ( echo [ОШИБКА] torch не поставился & pause & exit /b 1 )

echo [4/5] Ставлю fairseq (готовый wheel для Python 3.11)...
curl -L -o fairseq.whl "https://huggingface.co/Jmica/rvc/resolve/main/fairseq-0.12.4-cp311-cp311-win_amd64.whl?download=true"
pip install fairseq.whl
if errorlevel 1 ( echo [ОШИБКА] fairseq не поставился & pause & exit /b 1 )
del fairseq.whl >nul 2>&1

echo [5/5] Ставлю rvc-python и сервер (~500 МБ зависимостей)...
pip install "https://github.com/JarodMica/rvc-python/archive/refs/heads/main.zip"
pip install fastapi "uvicorn[standard]" soundfile
if errorlevel 1 ( echo [ОШИБКА] rvc-python не поставился & pause & exit /b 1 )

echo.
echo ==============================================================
echo   ГОТОВО! Теперь запускай ЗАПУСТИТЬ_RVC.cmd
echo   При первом запуске докачаются модели hubert/rmvpe (~100 МБ)
echo ==============================================================
pause
