param(
  [Parameter(Mandatory = $true)][ValidatePattern('^(sm|so|nm)\d+$')][string]$WatchId,
  [ValidateRange(1, 2000)][int]$Limit = 240
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$html = (Invoke-WebRequest -Uri ('https://www.nicovideo.jp/watch/' + $WatchId) -TimeoutSec 25).Content
$meta = [regex]::Match($html, '<meta name="server-response" content="([^"]+)"')
if (-not $meta.Success) { throw 'Niconico server-response metadata missing; page format changed.' }
$data = [Net.WebUtility]::HtmlDecode($meta.Groups[1].Value) | ConvertFrom-Json -Depth 100
$response = $data.data.response
$comment = $response.comment.nvComment
if (-not $comment) { throw 'Niconico comment metadata unavailable for this resource.' }
$serverUri = [Uri]$comment.server
if ($serverUri.Scheme -ne 'https' -or $serverUri.Host -notin @('nvcomment.nicovideo.jp', 'public.nvcomment.nicovideo.jp')) { throw 'Unexpected comment server origin.' }
$body = @{ params = $comment.params; threadKey = $comment.threadKey; additionals = @{} } | ConvertTo-Json -Depth 12 -Compress
$result = Invoke-RestMethod -Method Post -Uri ($comment.server.TrimEnd('/') + '/v1/threads') -Headers @{
  'X-Frontend-Id' = '6'; 'X-Frontend-Version' = '0'; 'Origin' = 'https://www.nicovideo.jp'; 'Referer' = 'https://www.nicovideo.jp/'
} -ContentType 'text/plain;charset=UTF-8' -Body $body -TimeoutSec 25
if ($result.meta.status -ne 200) { throw ('Comment request status ' + $result.meta.status) }
$summaries = @()
$messages = @()
foreach ($thread in $result.data.threads) {
  $comments = @($thread.comments)
  $summaries += [ordered]@{
    id = [string]$thread.id; fork = [string]$thread.fork; reportedCommentCount = $thread.commentCount; received = $comments.Count
    minVposMs = ($comments.vposMs | Measure-Object -Minimum).Minimum; maxVposMs = ($comments.vposMs | Measure-Object -Maximum).Maximum
  }
  foreach ($c in $comments) {
    $messages += [ordered]@{ threadId = [string]$thread.id; fork = [string]$thread.fork; id = $c.id; no = $c.no; body = $c.body; vposMs = $c.vposMs; postedAt = $c.postedAt; commands = @($c.commands); source = $c.source }
  }
}
$sample = [ordered]@{
  evidence = 'real-anonymous-query-not-browser-rendering'; capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
  watchId = $WatchId; sourceUrl = 'https://www.nicovideo.jp/watch/' + $WatchId; endpoint = $comment.server + '/v1/threads'
  durationSeconds = $response.video.duration; threads = $summaries
  sampling = 'First messages after stable media-time ordering, capped; not complete history. Author identifiers, cookies, keys and page metadata excluded.'
  totalReturned = $messages.Count; messages = @($messages | Sort-Object vposMs | Select-Object -First $Limit)
}
$artifactRoot = Join-Path $projectRoot '.artifacts/probes/niconico'
$runId = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$artifactDir = Join-Path $artifactRoot ($WatchId + '-' + $runId)
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$recordingPath = Join-Path $artifactDir 'recording.json'
$sample | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $recordingPath -Encoding utf8
$modules = @([regex]::Matches($html, 'https://resource\.video\.nimg\.jp/[^"\s<>]+?\.js') | ForEach-Object { $_.Value } | Sort-Object -Unique)
$modules | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactDir 'module-urls.json') -Encoding utf8
[ordered]@{ watchId=$WatchId; recordingPath=$recordingPath; durationSeconds=$sample.durationSeconds; threads=$summaries; savedSampleCount=$sample.messages.Count; moduleCount=$modules.Count; moduleNames=@($modules | ForEach-Object { [IO.Path]::GetFileName($_) }) } | ConvertTo-Json -Depth 8
