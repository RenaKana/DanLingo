import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Windows counters for only the GPU process(es) reported by this owned browser's CDP.
// DedicatedUsage is process-scoped driver accounting, not model-only physical residency.
export async function sampleBrowserGpuMemory(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const pids = processInfo.filter(row => row.type.toLowerCase() === 'gpu').map(row => row.id);
  if (!pids.length || pids.length > 16 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Owned browser GPU process IDs unavailable');
  }
  const script = `$selectedIds = @(${pids.join(',')})
Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |
  Where-Object { $_.Name -match '^pid_(\\d+)_' -and $selectedIds -contains [int]$Matches[1] } |
  Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024,
  });
  if (!stdout.trim()) throw new Error('GPU process memory counters unavailable');
  const parsed = JSON.parse(stdout), entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some(row => ![row.DedicatedUsage, row.SharedUsage, row.TotalCommitted].every(value => Number.isFinite(value) && value >= 0))) {
    throw new Error('Invalid GPU process memory counters');
  }
  return { at: Date.now(), pids, entries,
    dedicatedBytes: entries.reduce((sum, row) => sum + row.DedicatedUsage, 0),
    sharedBytes: entries.reduce((sum, row) => sum + row.SharedUsage, 0),
    totalCommittedBytes: entries.reduce((sum, row) => sum + row.TotalCommitted, 0) };
}
