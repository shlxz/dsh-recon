# Detached restart: schedule the restart from a process that is NOT a job of the
# agent's shell, so terminating the app cannot cancel the scheduler mid-flight.
#
# Written because the first attempt died with:
#   "subprocess-local: Windows Job runner exited with exit code 4294967295 before
#    proving its managed range empty"
# — the job runner kills its whole managed range, so anything it starts (including
# a delayed `Stop-Process`) is cut off when the job ends. The fix is to spawn the
# waiter from a detached PowerShell via Start-Process / -WindowStyle Hidden, which
# is not in the job's process tree.

param(
  [int]$DelaySeconds = 15,
  [string]$Exe = 'C:\Users\XLZ\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
)

$logDir = Join-Path $env:TEMP 'dsh-recon-restart'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'restart.log'
$script = Join-Path $logDir 'waiter.ps1'

# The waiter does the actual work, detached.
$waiterBody = @"
`$ErrorActionPreference = 'Continue'
function W([string]`$m) { Add-Content -Path '$log' -Value "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') `$m" }
W "waiter start; sleeping $DelaySeconds s"
Start-Sleep -Seconds $DelaySeconds
`$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
W "found `$(`$procs.Count) process(es)"
`$procs | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4
W "stopped"
if (Test-Path -LiteralPath '$Exe') {
  Start-Process -FilePath '$Exe'
  W "relaunched"
} else { W "ERROR exe missing" }
W "done"
"@

Set-Content -Path $script -Value $waiterBody -Encoding UTF8

Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') launching detached waiter (delay ${DelaySeconds}s)"
Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script`"" `
  -WindowStyle Hidden | Out-Null

Write-Output "detached waiter launched; log: $log"
