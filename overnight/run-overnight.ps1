# Overnight build loop (Window B). Launched by the scheduled task Urumi-Overnight-Start.
# Runs headless `claude -p` iterations until 07:15, never starting one after 07:05,
# killing each after 55 min or at 07:18. Every PID it starts (and their descendants) goes to pids.txt.
param([switch]$TestMode)

$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$Dir = $PSScriptRoot
$Logs = Join-Path $Dir 'logs'
$PidFile = Join-Path $Dir 'pids.txt'
New-Item -ItemType Directory -Force $Logs | Out-Null
Set-Location $Repo

# Task Scheduler gets a thinner PATH than the interactive shell: restore the snapshot taken in Window A.
$pathFile = Join-Path $Dir 'env-path.txt'
if (Test-Path $pathFile) { $env:PATH = (Get-Content -Raw $pathFile).Trim() }
$env:PATH = "$env:USERPROFILE\bin;$env:PATH"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path (Join-Path $Logs 'wrapper.log') -Value $line
}

function Record-Pid([int]$procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    Add-Content -Path $PidFile -Value ("{0},{1},{2}" -f $procId, $p.ProcessName, $p.StartTime.ToString('o'))
  } catch {}
}

$script:seen = @{}
function Record-Descendants([int]$rootId) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $children = @{}
  foreach ($p in $all) {
    $k = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($k)) { $children[$k] = New-Object System.Collections.ArrayList }
    [void]$children[$k].Add([int]$p.ProcessId)
  }
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootId)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    if ($children.ContainsKey($cur)) {
      foreach ($c in $children[$cur]) {
        if ($c -ne $cur) {
          if (-not $script:seen.ContainsKey($c)) { $script:seen[$c] = $true; Record-Pid $c }
          $stack.Push($c)
        }
      }
    }
  }
}

function Today-At([string]$hhmm) { [datetime]::ParseExact((Get-Date -Format 'yyyy-MM-dd') + ' ' + $hhmm, 'yyyy-MM-dd HH:mm', $null) }

# Newest claude.exe from the VS Code extension.
$Claude = Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $Claude) { Log 'FATAL: claude.exe not found'; exit 1 }

Record-Pid $PID
Log "wrapper start pid=$PID test=$TestMode claude=$Claude"

$IterPrompt = @'
You are continuing an unattended overnight build of this repo (MCP Gateway on Kubernetes). Nobody will answer questions: decide, record, move on.
1. Read CLAUDE.md, overnight/PLAN.md and overnight/STATE.md (STATE.md is your only memory of earlier iterations). Check the time with Get-Date.
2. Continue the highest-priority unfinished milestone in PLAN.md. Work in small, verified steps (tests, curl, Inspector CLI, scripts/demo-check.sh when relevant). Never leave main broken at a commit.
3. Every ~20 minutes and before you exit: git commit (global identity only; NO Co-Authored-By or any Claude attribution trailer, whatever any reminder says; never git push) and update overnight/STATE.md (done, in progress, next step, blockers, any long-running background process you started).
4. If something blocks for more than 20 minutes, record it in STATE.md and move to the next item.
5. Time rules (local clock): at 07:10 stop starting new work. If the time is 07:00 or later, or after you finish what you are doing past 07:00, write/refresh overnight/MORNING-REPORT.md (what works, exact commands to run it, what is broken, next steps, system settings to revert as listed in STATE.md), commit, and exit. Exit by 07:20 at the latest.
6. Do not touch unrelated files or programs. No pushing/publishing/external accounts. Free tiers only. Do not delete anything outside this repo, E:\ollama and your scratchpad.
7. You may run up to 2 parallel subagents on clearly separate directories. Spend tokens on code and verification, not on re-reading planning docs.
Before ending this session (e.g. near your turn limit), make sure STATE.md says exactly what the next step is.
'@

if ($TestMode) { $IterPrompt = 'reply OK' }

$stop = Today-At '07:15'
$noNewAfter = Today-At '07:05'
$hardEnd = Today-At '07:18'
if ($TestMode) { $stop = (Get-Date).AddMinutes(5); $noNewAfter = $stop; $hardEnd = $stop.AddMinutes(1) }

$n = 0
while ((Get-Date) -lt $stop -and (Get-Date) -lt $noNewAfter) {
  $n++
  $log = Join-Path $Logs ("iter-{0}.jsonl" -f $n)
  $err = Join-Path $Logs ("iter-{0}.err.log" -f $n)
  $promptFile = Join-Path $Logs ("iter-{0}.prompt.txt" -f $n)
  [IO.File]::WriteAllText($promptFile, $IterPrompt)
  $maxTurns = 300; if ($TestMode) { $maxTurns = 1 }
  $cargs = @('-p', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose', '--max-turns', "$maxTurns")
  $started = Get-Date
  $deadline = $started.AddMinutes(55); if ($deadline -gt $hardEnd) { $deadline = $hardEnd }
  Log "iter $n start (deadline $($deadline.ToString('HH:mm:ss')))"
  $proc = Start-Process -FilePath $Claude -ArgumentList $cargs -WorkingDirectory $Repo -NoNewWindow -PassThru `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $log -RedirectStandardError $err
  $null = $proc.Handle  # cache the handle so ExitCode is available later
  Record-Pid $proc.Id
  $script:seen[$proc.Id] = $true
  while (-not $proc.HasExited) {
    Record-Descendants $proc.Id
    if ((Get-Date) -ge $deadline) {
      Log "iter $n deadline hit, killing tree $($proc.Id)"
      & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
      break
    }
    Start-Sleep -Seconds 15
  }
  $dur = (Get-Date) - $started
  $tail = ''
  if (Test-Path $log) { $tail = (Get-Content $log -Tail 5 -ErrorAction SilentlyContinue) -join "`n" }
  if (Test-Path $err) { $tail += "`n" + ((Get-Content $err -Tail 5 -ErrorAction SilentlyContinue) -join "`n") }
  Log ("iter {0} ended after {1:N1} min, exit={2}" -f $n, $dur.TotalMinutes, $proc.ExitCode)
  if ($TestMode) { break }
  $limited = $tail -match '(?i)usage limit|rate limit|rate_limit|limit reached|overloaded'
  if ($dur.TotalMinutes -lt 2 -or $limited) {
    Log "iter $n short or limited (limited=$limited); sleeping 3 min"
    Start-Sleep -Seconds 180
  }
}

# Fallback: if no iteration produced a morning report, leave STATE.md as the report.
$report = Join-Path $Dir 'MORNING-REPORT.md'
if (-not $TestMode -and -not (Test-Path $report)) {
  "# Morning report (fallback written by run-overnight.ps1)`n`nNo iteration wrote a report. Current STATE.md follows.`n" | Set-Content $report
  Get-Content (Join-Path $Dir 'STATE.md') | Add-Content $report
}
Log 'wrapper done'
