@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 2026-11-09: DSH 桌面环境里 PATH 没有 node，先找绝对路径，再退 where
set NODEEXE=F:\nodejs\node.exe
if not exist "%NODEEXE%" set NODEEXE=node

"%NODEEXE%" --version >nul 2>nul
if errorlevel 1 (
  echo [小蓝面试] 没找到 Node.js，先装一下。
  pause
  exit /b 1
)

if "%INTERVIEW_KEY%"=="" set INTERVIEW_KEY=xiaolan

"%NODEEXE%" "%~dp0start-interview.mjs" %*
if errorlevel 1 pause
endlocal
