@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 小蓝面试 · 独立服务

where node >nul 2>nul
if errorlevel 1 (
  echo [小蓝面试] 没找到 Node.js，先装一下再双击我。
  pause
  exit /b 1
)

echo.
echo ============================================
echo   小蓝面试：独立服务
echo   这个窗口别关，关了就停了。
echo ============================================
echo.

rem 没给口令就用默认口令，方便直接分享链接
if "%INTERVIEW_KEY%"=="" set INTERVIEW_KEY=xiaolan

node "%~dp0standalone.mjs" --port 4321 --key %INTERVIEW_KEY%

echo.
echo [小蓝面试] 服务已退出。
pause
endlocal
