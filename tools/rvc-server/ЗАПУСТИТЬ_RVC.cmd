@echo off
chcp 65001 >nul
cd /d "%~dp0"
title RVC server :7865

if not exist venv\Scripts\python.exe (
    echo Сначала запусти УСТАНОВИТЬ_RVC.cmd — окружение ещё не создано.
    pause
    exit /b 1
)

echo RVC-сервер голосов — http://127.0.0.1:7865
echo Модели в папке models\:
dir /b /ad models
echo.

rem Если сервер уже запущен — не плодим второй экземпляр (порт 7865 занят).
curl.exe -s -o nul -m 3 http://127.0.0.1:7865/health 2>nul
if not errorlevel 1 (
    echo Сервер УЖЕ работает — это окно можно просто закрыть.
    echo.
    pause
    exit /b 0
)

echo Не закрывай это окно во время стрима.
echo.
venv\Scripts\python.exe server.py
pause
