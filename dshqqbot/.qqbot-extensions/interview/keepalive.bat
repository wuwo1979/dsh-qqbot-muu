@echo off
rem interview standalone keepalive (ASCII only: cmd parses bat as ANSI, UTF-8 Chinese breaks it)
rem 2026-11-09: keep 4321 alive so shared interview links never die.
rem   same idea as wechat-bridge/start-bridge.bat: skip when already listening,
rem   absolute node path because DSH desktop env has no node in PATH.
cd /d F:\qqbot\dshqqbot\.qqbot-extensions\interview

netstat -ano | findstr /C:":4321" | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

set LOGDIR=F:\qqbot\tmp\interview-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist F:\qqbot\tmp\interview-key.txt echo xiaolan> F:\qqbot\tmp\interview-key.txt
set /p IKEY=<F:\qqbot\tmp\interview-key.txt

F:\nodejs\node.exe standalone.mjs --port 4321 --key %IKEY% >> "%LOGDIR%\standalone.log" 2>&1
