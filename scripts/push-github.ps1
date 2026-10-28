param([string]$Branch = 'main')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tokenPath = Join-Path $root 'secrets\github.txt'

if (-not (Test-Path -LiteralPath $tokenPath)) { throw "missing $tokenPath" }
$token = ''
foreach ($line in Get-Content -LiteralPath $tokenPath -Encoding UTF8) {
  $t = $line.Trim()
  if ($t -and -not $t.StartsWith('#')) { $token = $t; break }
}
if (-not $token) { throw 'secrets\github.txt is empty; put one token line in it first' }

# 用 GIT_ASKPASS 提供凭据：
# - token 只存在环境变量里，不拼进 URL、不写 git config/remote
# - git 出错时不会把 URL/口令打印出来
$askpass = Join-Path $PSScriptRoot 'git-askpass.cmd'
$oldToken = $env:QQBOT_GIT_TOKEN
$oldPrompt = $env:GIT_TERMINAL_PROMPT
$env:QQBOT_GIT_TOKEN = $token
$env:GIT_ASKPASS = $askpass
$env:GIT_TERMINAL_PROMPT = '0'
try {
  git -C $root -c credential.helper= push origin $Branch
  if ($LASTEXITCODE -ne 0) { throw "push failed (exit $LASTEXITCODE)" }
} finally {
  $env:QQBOT_GIT_TOKEN = $oldToken
  $env:GIT_ASKPASS = $null
  $env:GIT_TERMINAL_PROMPT = $oldPrompt
}
"pushed $Branch to origin (token not stored in remote/config)"
