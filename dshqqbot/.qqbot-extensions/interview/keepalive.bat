@echo off
rem interview standalone keepalive (ASCII only: cmd parses bat as ANSI, UTF-8 Chinese breaks it)
rem 2026-11-09: keep 4321 alive so shared interview links never die.
rem   same idea as wechat-bridge/start-bridge.bat: skip when already listening.
rem 0.1.14: node 位置不再写死（原来写死某台机器的 F:\nodejs\node.exe，别人机器上必坏）。
cd /d "%~dp0"

netstat -ano | findstr /C:":4321" | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

set LOGDIR=%TEMP%\interview-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist %TEMP%\interview-key.txt echo xiaolan> %TEMP%\interview-key.txt
set /p IKEY=<%TEMP%\interview-key.txt

set "NODE_BIN="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%i"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN (
  echo [keepalive] node not found, skip > "%LOGDIR%\standalone.log"
  exit /b 1
)

"%NODE_BIN%" standalone.mjs --port 4321 --key %IKEY% >> "%LOGDIR%\standalone.log" 2>&1
