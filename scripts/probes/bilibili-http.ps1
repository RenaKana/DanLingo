param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [int]$MaxBytes = 16777216
)
$ErrorActionPreference = 'Stop'
# Transport for Node's probe on Windows: system TLS/proxy, no browser cookies,
# credentials, settings changes, dependency installation, or automatic retries.
$biliUri = [Uri]$Uri
if ($biliUri.Scheme -ne 'https' -or $biliUri.Port -ne 443 -or $biliUri.UserInfo -or
    $biliUri.Host -notin @('api.bilibili.com', 'www.bilibili.com', 's1.hdslb.com')) {
    throw 'Only the three explicit public Bilibili HTTPS hosts are allowed.'
}
if ($MaxBytes -lt 1 -or $MaxBytes -gt 16777216) { throw 'Invalid byte limit.' }
$biliWatch = [Diagnostics.Stopwatch]::StartNew()
$biliResponse = Invoke-WebRequest -Uri $biliUri.AbsoluteUri -Method Get -TimeoutSec 30 `
    -MaximumRedirection 0 -SkipHttpErrorCheck -Headers @{
        Referer = 'https://www.bilibili.com/'
        'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DanLingo-P0-readonly-probe'
    }
$biliBytes = $biliResponse.RawContentStream.ToArray()
if ($biliBytes.Length -gt $MaxBytes) { throw 'Response exceeds probe byte limit.' }
[ordered]@{
    status = [int]$biliResponse.StatusCode
    contentType = [string]($biliResponse.Headers['Content-Type'] -join '; ')
    elapsedMs = $biliWatch.ElapsedMilliseconds
    fetchedAt = [DateTimeOffset]::UtcNow.ToString('o')
    bodyBase64 = [Convert]::ToBase64String($biliBytes)
} | ConvertTo-Json -Compress
