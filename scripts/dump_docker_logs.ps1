# Snapshot Docker logs/stats to ./logs so a host lockup still leaves evidence.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}" |
  Out-File -Encoding utf8 (Join-Path $out "ps-$stamp.txt")

docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" |
  Out-File -Encoding utf8 (Join-Path $out "stats-$stamp.txt")

foreach ($name in @("emproview-app-1", "emproview-llm-1", "emproview-mongo-1")) {
  docker logs --tail 500 $name 2>&1 |
    Out-File -Encoding utf8 (Join-Path $out "$name-$stamp.log")
}

Write-Host "Wrote snapshots under $out (*-$stamp.*)"
if (Test-Path (Join-Path $out "analyze-trace.log")) {
  Write-Host "Analyze trace also present: logs\analyze-trace.log"
}
