# detach-adapter.ps1 - start the TTS supervisor adapter detached from the calling session.
#
# Why WMI instead of Start-Process: WorkBuddy/沙箱类宿主会把子进程挂在 job 对象上，
# 命令一结束整棵树被杀。WMI(Win32_Process.Create) 以 WMI 服务为父进程，子进程独立存活。
# 后端(GSV/Breeze)所需的环境变量由适配层自己构造(server.py 的 _backend_env)，
# 所以这里不需要传环境块。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\detach-adapter.ps1          # 空闲10分钟自动回收
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\detach-adapter.ps1 30      # 空闲30分钟
# 停止：
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\start-services.ps1 -Stop
param([double]$IdleMinutes = 10)
$py = 'F:\qqbot\.models\gpt-sovits\.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'E:\Anaconda\python.exe' }
$cmd = '"' + $py + '" F:/qqbot/skills/local-tts/adapter/server.py --port 9881 --manage --idle-minutes ' + $IdleMinutes
$proc = ([wmiclass]'Win32_Process')
$r = $proc.Create($cmd, 'F:\qqbot', $null)
Write-Output ("return=" + $r.ReturnValue + " pid=" + $r.ProcessId)
