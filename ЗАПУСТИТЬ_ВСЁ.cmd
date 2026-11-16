@echo off
chcp 65001 >nul
rem ============================================================
rem  ЗАПУСК chlauncher — двойной клик, ничего вводить не надо.
rem  Открывает два окна: бэкенд (:8787) и лаунчер (Tauri).
rem ============================================================
cd /d "%~dp0"

rem windres нужен сборке Tauri; CARGO_TARGET_DIR без пробелов —
rem иначе windres падает на путях с пробелами.
set "PATH=D:\DEVIN PROJECT\w64devkit\w64devkit\bin;%PATH%"
set "CARGO_TARGET_DIR=D:\cargo-target\chlauncher"

rem На этом ПК нет MSVC Build Tools — принудительно gnu-тулчейн
rem для ЭТОЙ папки (override привязан к папке, идемпотентно).
rustup override set stable-x86_64-pc-windows-gnu >nul 2>&1

echo [1/2] Стартую бэкенд-сервер на 127.0.0.1:8787 ...
start "chlauncher SERVER  :8787" cmd /k "cd /d %~dp0 && npm run dev:server"

rem даём серверу пару секунд подняться
timeout /t 3 /nobreak >nul

rem RVC-сервер голосов персонажей — стартуем, только если окружение
rem уже установлено (tools\rvc-server\venv). Не установлен — пропуск.
if exist "tools\rvc-server\venv\Scripts\python.exe" (
    echo [+] Стартую RVC-сервер голосов на 127.0.0.1:7865 ...
    start "chlauncher RVC :7865" cmd /k "cd /d %~dp0tools\rvc-server && ЗАПУСТИТЬ_RVC.cmd"
) else (
    echo [-] RVC не установлен — голоса персонажей выключены.
    echo     Чтобы включить: tools\rvc-server\УСТАНОВИТЬ_RVC.cmd
)

echo [2/2] Стартую лаунчер (vite :1420 + tauri cargo run) ...
start "chlauncher LAUNCHER" cmd /k "cd /d %~dp0 && npm run dev:launcher"

echo.
echo Готово: открыто два окна — SERVER и LAUNCHER.
echo Первая сборка Rust может занять несколько минут — это нормально.
echo Это окно можно закрыть.
pause
