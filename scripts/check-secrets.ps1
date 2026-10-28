$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Get-KeyLine([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -and -not $t.StartsWith('#')) { return $t }
  }
  return ''
}

foreach ($name in @('deepseek.txt', 'github.txt')) {
  $p = Join-Path $root (Join-Path 'secrets' $name)
  $v = Get-KeyLine $p
  if ($v) { "{0} = SET (len={1})" -f $name, $v.Length }
  else { "{0} = EMPTY" -f $name }
}

if ($env:DEEPSEEK_API_KEY) { "DEEPSEEK_API_KEY env = SET (len=$($env:DEEPSEEK_API_KEY.Length))" }
else { "DEEPSEEK_API_KEY env = absent" }

$remote = git -C $root remote -v 2>$null | Select-Object -First 1
if ($remote) { "remote: " + ($remote -replace 'x-access-token:[^@]+@', 'x-access-token:***@') }
else { 'remote: none' }

'--- stored GitHub credentials (names only) ---'
cmdkey /list 2>$null | Select-String -Pattern 'github' -SimpleMatch

exit 0
