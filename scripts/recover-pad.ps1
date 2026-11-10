<#
.SYNOPSIS
  平板微信事故恢复：按 docs/架构总览-2026-11-05.md §19 的顺序串起来，人工只跑一次。

.DESCRIPTION
  顺序：微信存活 -> 重启 WCX -> (USB) adb tcpip 5555 -> Tailscale -> adb 隧道 -> 健康校验。
  每步只做幂等操作，失败不中断（继续收集信息，最后统一汇总），不打印任何 PIN/密钥/账号。

.PARAMETER DryRun
  只打印将执行的命令，不改动平板。

.PARAMETER UsbTcpip
  执行 `adb tcpip 5555`（需要 USB 设备在场；无线 adb 重启后不会持久）。

.PARAMETER SetProxy
  把平板全局 http_proxy 指向本机 gh-proxy（WCX 拉 GitHub 适配数据用）。

.PARAMETER PcHost
  本机在 Tailscale 里的 IP（默认取 config.json 的 ghProxy.tabletProxyHost，取不到就跳过 SetProxy）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\recover-pad.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\recover-pad.ps1 -UsbTcpip
#>
param(
  [switch]$DryRun,
  [switch]$UsbTcpip,
  [switch]$SetProxy,
  [string]$PcHost = '',
  [string]$Serial = ''
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'wechat-bridge\config.json'
$Cfg = if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }

$Adb = if ($Cfg -and $Cfg.adb.exe) { [string]$Cfg.adb.exe } else { 'adb.exe' }
$PortBridge = if ($Cfg -and $Cfg.bridge.listenPort) { [int]$Cfg.bridge.listenPort } else { 4311 }
$PortWcx = if ($Cfg -and $Cfg.adb.remotePort) { [int]$Cfg.adb.remotePort } else { 3001 }
$Serial = if ($Serial) { $Serial } elseif ($Cfg -and $Cfg.adb.serial) { [string]$Cfg.adb.serial } else { '' }
$WeChatPkg = if ($Cfg -and $Cfg.android.wechatPackage) { [string]$Cfg.android.wechatPackage } else { 'com.tencent.mm' }
$WcxPkg = if ($Cfg -and $Cfg.wcx.package) { [string]$Cfg.wcx.package } else { '' }
$TailscalePkg = if ($Cfg -and $Cfg.adb.tailscalePackage) { [string]$Cfg.adb.tailscalePackage } else { 'com.tailscale.ipn' }
$TailscaleAct = if ($Cfg -and $Cfg.adb.tailscaleActivity) { [string]$Cfg.adb.tailscaleActivity } else { '' }
if (-not $PcHost -and $Cfg -and $Cfg.ghProxy.tabletProxyHost) { $PcHost = [string]$Cfg.ghProxy.tabletProxyHost }

$steps = New-Object System.Collections.ArrayList

function Step([string]$Name, [scriptblock]$Body) {
  Write-Host ""
  Write-Host ("== " + $Name) -ForegroundColor Cyan
  if ($DryRun) { Write-Host "   [dry-run] 跳过执行" -ForegroundColor DarkGray; [void]$steps.Add([pscustomobject]@{ Step = $Name; Ok = $null; Note = 'dry-run' }); return }
  try {
    $note = & $Body
    [void]$steps.Add([pscustomobject]@{ Step = $Name; Ok = $true; Note = [string]$note })
    Write-Host ("   OK  " + $note) -ForegroundColor Green
  } catch {
    [void]$steps.Add([pscustomobject]@{ Step = $Name; Ok = $false; Note = $_.Exception.Message })
    Write-Host ("   FAIL " + $_.Exception.Message) -ForegroundColor Red
  }
}

function Invoke-Adb([string[]]$Args, [int]$TimeoutSec = 25) {
  $pre = @()
  if ($Serial) { $pre = @('-s', $Serial) }
  $all = $pre + $Args
  if ($DryRun) { Write-Host ("   adb " + ($all -join ' ')) -ForegroundColor DarkGray; return '' }
  $out = & $Adb @all 2>&1
  if ($LASTEXITCODE -ne 0) { throw ("adb " + ($Args -join ' ') + " 失败：" + ($out -join ' ').Trim()) }
  return ($out -join "`n").Trim()
}

function Test-Port([string]$HostName, [int]$Port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}

Write-Host "平板微信事故恢复（$(if ($DryRun) { 'dry-run' } else { '执行' })）" -ForegroundColor Yellow
Write-Host ("adb=" + $Adb + "  serial=" + $(if ($Serial) { ($Serial -replace '(\d+\.\d+\.)\d+\.\d+', '$1***.***') } else { '(默认设备)' }) + "  bridge=:" + $PortBridge + "  wcx=:" + $PortWcx)

# 0. adb 守护进程 + 设备在线
Step '0. adb 设备在线' {
  if (-not (Test-Path $Adb) -and $Adb -ne 'adb.exe') { throw "找不到 adb：$Adb" }
  $devices = Invoke-Adb @('devices')
  $lines = ($devices -split "`n") | Where-Object { $_ -match "`t(device|offline|unauthorized)" }
  if (-not $lines) {
    if ($Serial) { [void](Invoke-Adb @('connect', $Serial)); Start-Sleep -Seconds 2; $devices = Invoke-Adb @('devices') }
    $lines = ($devices -split "`n") | Where-Object { $_ -match "`t(device|offline|unauthorized)" }
  }
  if (-not $lines) { throw 'adb 设备不在线（先插 USB 或确认平板 Tailscale 已连）' }
  return (($lines | ForEach-Object { ($_ -split "`t")[1] }) -join ', ')
}

# 1. 微信活着（WCX 的 REST :3001 寄宿在微信进程）
Step '1. 微信进程存活' {
  $pidOut = Invoke-Adb @('shell', 'pidof', $WeChatPkg)
  if ($pidOut) { return "pid=$pidOut" }
  # 不在就拉起（不点任何界面，只启动 LauncherUI）
  [void](Invoke-Adb @('shell', 'am', 'start', '-n', "$WeChatPkg/.ui.LauncherUI"))
  Start-Sleep -Seconds 4
  $again = Invoke-Adb @('shell', 'pidof', $WeChatPkg)
  if (-not $again) { throw '微信未能拉起（可能被系统限制后台）' }
  return "已拉起 pid=$again"
}

# 2. 重启 WCX（只重启 WCX 应用，不动微信；顺序错了 :3001 不回弹）
Step '2. 重启 WCX 应用' {
  if (-not $WcxPkg) {
    $pkgs = Invoke-Adb @('shell', 'pm', 'list', 'packages')
    $cand = ($pkgs -split "`n") | Where-Object { $_ -match 'package:(.*(wcx|wechatx|xposed|hook).*)' } | ForEach-Object { ($_ -replace 'package:', '').Trim() }
    if (-not $cand) { throw '未配置 wcx.package，且未探测到候选包名；请在 config.json 增加 wcx.package' }
    $WcxPkg = $cand[0]
  }
  $exists = (Invoke-Adb @('shell', 'pm', 'list', 'packages', $WcxPkg))
  if (-not $exists) { throw "平板未安装 $WcxPkg" }
  [void](Invoke-Adb @('shell', 'am', 'force-stop', $WcxPkg))
  Start-Sleep -Seconds 1
  [void](Invoke-Adb @('shell', 'monkey', '-p', $WcxPkg, '-c', 'android.intent.category.LAUNCHER', '1'))
  Start-Sleep -Seconds 6
  return "$WcxPkg 已重启"
}

# 3. USB tcpip 5555（重启后无线 adb 不持久）
Step '3. USB adb tcpip 5555' {
  if (-not $UsbTcpip) { return '跳过（未传 -UsbTcpip）' }
  $usb = (Invoke-Adb @('devices')) -split "`n" | Where-Object { $_ -match "`tdevice" }
  if (-not $usb) { throw '没有 USB 设备，无法执行 tcpip' }
  [void](Invoke-Adb @('tcpip', '5555'))
  Start-Sleep -Seconds 2
  if ($Serial) { [void](Invoke-Adb @('connect', $Serial)); Start-Sleep -Seconds 2 }
  return 'tcpip 5555 已开'
}

# 4. Tailscale（平板重启后不自连）
Step '4. Tailscale' {
  $pkgs = Invoke-Adb @('shell', 'pm', 'list', 'packages')
  if (-not ($pkgs -match [regex]::Escape("package:$TailscalePkg"))) { throw "未安装 $TailscalePkg" }
  [void](Invoke-Adb @('shell', 'monkey', '-p', $TailscalePkg, '-c', 'android.intent.category.LAUNCHER', '1'))
  Start-Sleep -Seconds 3
  return "$TailscalePkg 已拉起"
}

# 5. adb 隧道（forward 3001 / reverse 4311，顺序固定）
Step '5. adb 隧道 forward/reverse' {
  [void](Invoke-Adb @('forward', "tcp:$PortWcx", "tcp:$PortWcx"))
  [void](Invoke-Adb @('reverse', "tcp:$PortBridge", "tcp:$PortBridge"))
  return "forward tcp:$PortWcx->tcp:$PortWcx, reverse tcp:$PortBridge->tcp:$PortBridge"
}

# 6. 可选：平板全局代理指向本机 gh-proxy
Step '6. gh-proxy 全局代理（可选）' {
  if (-not $SetProxy) { return '跳过（未传 -SetProxy）' }
  if (-not $PcHost) { throw 'PcHost 为空：传 -PcHost 或在 config.ghProxy.tabletProxyHost 配置' }
  [void](Invoke-Adb @('shell', 'settings', 'put', 'global', 'http_proxy', "$($PcHost):8899"))
  return "http_proxy=$PcHost:8899"
}

# 7. 健康校验
Step '7. 桥接 / 平板健康' {
  if (-not (Test-Port '127.0.0.1' $PortBridge)) {
    Write-Host '   桥接未监听：运行 node scripts/ops.mjs start' -ForegroundColor Yellow
    return 'bridge down'
  }
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$PortBridge/wx/health" -TimeoutSec 6
    $reach = [bool]$h.tablet.reachable
    $tun = [string]$h.tunnel
    if (-not $reach) { throw "tablet 不可达（tunnel=$tun）" }
    return "tablet reachable, tunnel=$tun, wcx=$(if ($h.wcx.version) { 'v' + $h.wcx.version } else { '?' })"
  } catch { throw $_.Exception.Message }
}

Write-Host ""
Write-Host "汇总：" -ForegroundColor Yellow
$steps | Format-Table -AutoSize
if ($DryRun) { Write-Host "dry-run 完成：去掉 -DryRun 真正执行。" -ForegroundColor DarkGray }
