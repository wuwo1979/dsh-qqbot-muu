param(
  [Parameter(Mandatory=$true)][string]$WavPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
try {
  # 2026-11-08: force UTF-8 console output so Node does not mis-decode as GBK
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Add-Type -AssemblyName System.Speech
  if (-not (Test-Path $WavPath)) { throw 'wav file not found' }
  $infos = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $ri = $infos | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $ri) { $ri = $infos | Where-Object { $_.Culture.Name -eq 'zh-TW' } | Select-Object -First 1 }
  if (-not $ri) { $ri = $infos | Select-Object -First 1 }
  if (-not $ri) { throw 'no speech recognizer installed' }

  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ri)
  $engine.SetInputToWaveFile($WavPath)
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)

  $sb = New-Object System.Text.StringBuilder
  while ($true) {
    $result = $null
    try { $result = $engine.Recognize() } catch { break }
    if ($null -eq $result) { break }
    [void]$sb.Append($result.Text)
    [void]$sb.Append(' ')
  }
  $engine.Dispose()
  $text = $sb.ToString().Trim()
  # 2026-11-08: Set-Content -Encoding UTF8 writes a BOM on PS 5.1; use .NET UTF-8 no-BOM instead
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutPath, $text, $enc)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
