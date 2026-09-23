param(
  [string]$Build = '.output/chrome-mv3',
  [string]$Archive = '.output/danlingo-0.2.0-chrome.zip',
  [string[]]$TestCopies = @(),
  [string[]]$AllowedTestProviderOrigins = @(),
  [string]$Report = '.artifacts/live/package-verification.json'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$buildPath = (Resolve-Path -LiteralPath $Build).Path
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$files = @(Get-ChildItem -LiteralPath $buildPath -File -Recurse | Sort-Object FullName)
$hashes = [ordered]@{}
foreach ($file in $files) {
  $name = $file.FullName.Substring($buildPath.Length + 1).Replace('\', '/')
  $hashes[$name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest = Get-Content -LiteralPath (Join-Path $buildPath 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne '0.2.0') { throw 'Expected version 0.2.0' }
if (@($manifest.content_scripts | Where-Object all_frames).Count) { throw 'Unexpected all_frames grant' }
$expectedHosts = @('https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*', 'https://www.youtube.com/*')
if (Compare-Object @($manifest.host_permissions | Sort-Object) @($expectedHosts | Sort-Object)) { throw 'Unexpected release host permissions' }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
$zipHashes = [ordered]@{}
try {
  foreach ($entry in $zip.Entries) {
    if (-not $entry.Name) { continue }
    if ($zipHashes.Contains($entry.FullName)) { throw 'Duplicate archive entry' }
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $zipHashes[$entry.FullName] = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
  }
} finally { $zip.Dispose() }
if (Compare-Object @($hashes.Keys | Sort-Object) @($zipHashes.Keys | Sort-Object)) { throw 'Archive file set differs from build' }
foreach ($name in $hashes.Keys) { if ($hashes[$name] -ne $zipHashes[$name]) { throw "Archive byte mismatch: $name" } }
$copies = @()
$allowedTestHosts = @('http://127.0.0.1/*')
foreach ($providerOrigin in $AllowedTestProviderOrigins) {
  $providerUri = [Uri]$providerOrigin
  if ($providerUri.Scheme -notin @('http', 'https') -or $providerUri.UserInfo -or $providerUri.Query -or $providerUri.Fragment -or $providerUri.AbsolutePath -ne '/') { throw 'Expected an explicit test Provider origin' }
  $allowedTestHosts += $providerUri.Scheme + '://' + $providerUri.DnsSafeHost + '/*'
}
foreach ($copy in $TestCopies) {
  $copyPath = (Resolve-Path -LiteralPath $copy).Path
  $copyFiles = @(Get-ChildItem -LiteralPath $copyPath -File -Recurse | ForEach-Object { $_.FullName.Substring($copyPath.Length + 1).Replace('\', '/') })
  if (Compare-Object @($hashes.Keys | Sort-Object) @($copyFiles | Sort-Object)) { throw "Test copy file set differs: $copyPath" }
  foreach ($name in $hashes.Keys) {
    if ($name -eq 'manifest.json') { continue }
    $actual = (Get-FileHash -LiteralPath (Join-Path $copyPath $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $hashes[$name]) { throw "Test payload mismatch: $copyPath / $name" }
  }
  $testManifest = Get-Content -LiteralPath (Join-Path $copyPath 'manifest.json') -Raw | ConvertFrom-Json
  $extraHosts = @($testManifest.host_permissions | Where-Object { $_ -notin $expectedHosts })
  if (@($extraHosts | Where-Object { $_ -notin $allowedTestHosts }).Count) { throw 'Test copy grants an unexpected extra host' }
  $testManifest.host_permissions = $manifest.host_permissions
  if (($testManifest | ConvertTo-Json -Depth 30 -Compress) -ne ($manifest | ConvertTo-Json -Depth 30 -Compress)) { throw "Unexpected test manifest modification: $copyPath" }
  $copies += [ordered]@{ path = $copyPath; payloadMatches = $true; extraTestHosts = $extraHosts }
}
$result = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o'); status = 'PASS_ARTIFACT_CONSISTENCY'
  build = $buildPath; archive = $archivePath; version = $manifest.version; fileCount = $files.Count
  archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  hostPermissions = $manifest.host_permissions; files = $hashes; testedCopies = $copies
  limitation = 'Byte equality proves artifact provenance, not real platform, Provider, or installation acceptance.'
}
$reportPath = [IO.Path]::GetFullPath($Report)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($reportPath)) -Force | Out-Null
$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $reportPath -Encoding utf8
[pscustomobject]$result | Select-Object status, version, fileCount, archiveSha256 | ConvertTo-Json
