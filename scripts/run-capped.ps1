<#
.SYNOPSIS
  Run node.exe inside a Windows job object with a hard memory cap and a time limit.

.DESCRIPTION
  A runaway test once grew a node.exe to 71 GB and forced a reboot: an infinite loop allocated outside V8's heap
  (so --max-old-space-size never tripped), and Git Bash's `timeout` stopped only its wrapper, not node.exe.
  A job object fixes both: Windows refuses allocations past -MemoryMB for the whole process tree (node and every
  child it starts, such as node --test's per-file processes), and the job is killed when it outlives -TimeoutSec
  or when this script exits for any reason (KILL_ON_JOB_CLOSE). It only ever starts node.exe.

  node's arguments come in as one value, -ArgsJson (a JSON array of strings), because PowerShell would read a
  node flag such as -e as one of its own parameters. scripts/test.mjs builds it.

  The default cap is 10 GB, as in scripts/test.mjs and zen_flow.py: a real ceiling for a runaway, and in line with
  what Zen itself uses with 20+ tabs open (the user's guidance), so browser testing is never cut short.

.EXAMPLE
  powershell -NoProfile -File scripts/run-capped.ps1 -MemoryMB 10240 -TimeoutSec 600 -ArgsJson '["--test","test/unit/**/*.test.js"]'
#>
param(
  [int]$MemoryMB = 10240,
  [int]$TimeoutSec = 600,
  [string]$ArgsJson = "[]"
)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1's ConvertFrom-Json emits a JSON array as one object; the foreach statement unrolls it.
$NodeArgs = @()
foreach ($item in (ConvertFrom-Json $ArgsJson)) { $NodeArgs += [string]$item }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CappedJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit,
    JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  const uint JOB_MEMORY = 0x200, KILL_ON_CLOSE = 0x2000;
  public static IntPtr Create(ulong bytes) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var info = new EXTENDED();
    info.Basic.LimitFlags = JOB_MEMORY | KILL_ON_CLOSE;
    info.JobMemoryLimit = new UIntPtr(bytes);
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXTENDED))))
      throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    return job;
  }
}
"@

$job = [CappedJob]::Create([uint64]$MemoryMB * 1MB)
# Quote each argument the way CommandLineToArgvW reads it (backslashes before a quote or the end are doubled).
$quoted = ($NodeArgs | ForEach-Object { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }) -join " "
$startArgs = @{ FilePath = "node.exe"; NoNewWindow = $true; PassThru = $true }
if ($quoted) { $startArgs.ArgumentList = $quoted }
$process = Start-Process @startArgs
$null = $process.Handle   # cache the handle now, so the exit code stays readable after the process ends
# node is in the job before it starts any child; children it spawns later inherit the job.
if (-not [CappedJob]::AssignProcessToJobObject($job, $process.Handle)) {
  $process.Kill()
  throw "AssignProcessToJobObject failed"
}
if (-not $process.WaitForExit($TimeoutSec * 1000)) {
  [void][CappedJob]::TerminateJobObject($job, 124)
  [Console]::Error.WriteLine("run-capped: stopped after $TimeoutSec s (time limit)")
  exit 124
}
$process.WaitForExit()
exit $process.ExitCode
