# Hard stop (07:28). Ends the overnight run and every process it started, stops k3d clusters,
# then deletes the scheduled tasks so nothing recurs. Never touches VS Code, browsers or unrelated processes.
param([switch]$DryRun)
$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Logs = Join-Path $Dir 'logs'
$PidFile = Join-Path $Dir 'pids.txt'
$KillLog = Join-Path $Logs 'kill.log'
New-Item -ItemType Directory -Force $Logs | Out-Null
$pathFile = Join-Path $Dir 'env-path.txt'
if (Test-Path $pathFile) { $env:PATH = (Get-Content -Raw $pathFile).Trim() }
$env:PATH = "$env:USERPROFILE\bin;$env:PATH"

function Log($msg) { Add-Content -Path $KillLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" }
function Kill-Tree([int]$id) { if ($DryRun) { Log "  DRY-RUN would kill tree $id"; return }; & taskkill.exe /PID $id /T /F 2>&1 | ForEach-Object { Log "  $_" } }
Log "=== kill-all start (dry=$DryRun) ==="
if ($DryRun) { Log 'dry run: skipping schtasks /End, k3d stop and task deletion' }

if (-not $DryRun) { & schtasks.exe /End /TN 'Urumi-Overnight-Start' 2>&1 | ForEach-Object { Log "schtasks /End: $_" } }

$protected = @('code', 'Code', 'chrome', 'msedge', 'firefox', 'explorer', 'Docker Desktop', 'com.docker.backend', 'ollama', 'ollama app')

# 1. Recorded PIDs (pid,name,startTime): kill only if the same process (name + start time) is still alive.
$recorded = @{}
if (Test-Path $PidFile) {
  foreach ($line in Get-Content $PidFile) {
    $parts = $line.Split(',')
    if ($parts.Count -lt 3) { continue }
    $recorded[[int]$parts[0]] = $true
    try {
      $p = Get-Process -Id ([int]$parts[0]) -ErrorAction Stop
      if ($protected -contains $p.ProcessName) { continue }
      if ($p.ProcessName -eq $parts[1] -and $p.StartTime.ToString('o') -eq $parts[2]) {
        Log "kill recorded tree pid=$($p.Id) name=$($p.ProcessName)"
        Kill-Tree $p.Id
      }
    } catch {}
  }
}

# 2. Any claude/node/kubectl/bash process whose parent chain reaches a recorded PID.
$all = Get-CimInstance Win32_Process
$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
foreach ($p in $all) {
  if (@('claude.exe', 'node.exe', 'kubectl.exe', 'bash.exe', 'helm.exe', 'k3d.exe', 'docker.exe') -notcontains $p.Name) { continue }
  $cur = $p; $hops = 0; $hit = $false
  while ($cur -and $hops -lt 30) {
    if ($recorded.ContainsKey([int]$cur.ParentProcessId)) { $hit = $true; break }
    $cur = $byId[[int]$cur.ParentProcessId]; $hops++
  }
  if ($hit) {
    Log "kill descendant pid=$($p.ProcessId) name=$($p.Name)"
    Kill-Tree $p.ProcessId
  }
}

# 3. Port-forwards and image builds, wherever they came from.
foreach ($p in Get-CimInstance Win32_Process) {
  $cl = [string]$p.CommandLine
  if (($p.Name -eq 'kubectl.exe' -and $cl -match 'port-forward') -or
      ($p.Name -match '^docker(-buildx)?\.exe$' -and $cl -match '\b(build|buildx)\b')) {
    Log "kill $($p.Name) pid=$($p.ProcessId): $cl"
    Kill-Tree $p.ProcessId
  }
}

# 4. Stop every k3d cluster (data kept).
if (-not $DryRun) { & k3d.exe cluster stop --all 2>&1 | ForEach-Object { Log "k3d: $_" } }

# 5. Remove the scheduled tasks so they never recur.
if (-not $DryRun) { foreach ($t in @('Urumi-Overnight-Start', 'Urumi-Overnight-Test', 'Urumi-Overnight-Kill')) {
  & schtasks.exe /Delete /TN $t /F 2>&1 | ForEach-Object { Log "schtasks /Delete ${t}: $_" }
}
}
Log '=== kill-all done ==='
