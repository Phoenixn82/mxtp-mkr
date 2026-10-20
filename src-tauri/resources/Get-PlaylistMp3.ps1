<#
.SYNOPSIS
  Download a YouTube playlist as MP3s into a folder named after the playlist.

.DESCRIPTION
  Thin wrapper around yt-dlp + ffmpeg (both already installed on this machine).
  Downloads the audio plus the playlist/first-track artwork used as its cover.
  No third-party binaries are fetched.

.EXAMPLE
  .\Get-PlaylistMp3.ps1 "https://www.youtube.com/playlist?list=PLxxxx"

.EXAMPLE
  .\Get-PlaylistMp3.ps1 -Url "https://..." -OutRoot "D:\Music" -Quality 320
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Url,

  [string]$Artist,

  [string]$Album,

  [switch]$ResolveOnly,

  [string]$OutRoot = (Join-Path $env:USERPROFILE "Music\YouTube"),

  # best = keep YouTube's original stream, no re-encode (highest fidelity)
  # m4a  = AAC, copied straight from YouTube when available, very compatible
  # mp3  = re-encoded, universal compatibility, slight quality loss
  # flac/wav = lossless container around a lossy source: bigger, NOT better
  [ValidateSet('best','m4a','mp3','flac','wav','opus')]
  [string]$Format = 'best',

  # MP3 only. 0 = best VBR (default). Or a fixed kbps.
  [ValidateSet('0','128','192','256','320')]
  [string]$Quality = '0',

  # Optional yt-dlp playlist positions, e.g. 1,3,7-9. Omit for the full album.
  [ValidatePattern('^[0-9,\-]+$')]
  [string]$PlaylistItems,

  # Update yt-dlp before running. Do this when downloads suddenly start failing.
  [switch]$Update,

  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Write-Bad ($msg) { Write-Host "XX  $msg" -ForegroundColor Red }

function Get-SafeName([string]$name) {
  $bad = [System.IO.Path]::GetInvalidFileNameChars()
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $name.ToCharArray()) {
    if ($bad -contains $c) { [void]$sb.Append('_') } else { [void]$sb.Append($c) }
  }
  $out = $sb.ToString().Trim().TrimEnd('.')
  if ([string]::IsNullOrWhiteSpace($out)) { $out = 'YouTube Downloads' }
  if ($out.Length -gt 120) { $out = $out.Substring(0, 120).Trim() }
  return $out
}

# --- locate tools -----------------------------------------------------------
$ytdlp = if ($env:MXTP_YTDLP_PATH -and (Test-Path -LiteralPath $env:MXTP_YTDLP_PATH)) {
  $env:MXTP_YTDLP_PATH
} else {
  (Get-Command yt-dlp -ErrorAction SilentlyContinue).Source
}
if (-not $ytdlp) {
  Write-Bad "yt-dlp not found on PATH. Install with:  python -m pip install -U yt-dlp"
  if (-not $NoPause) { Read-Host "Press Enter to close" }
  exit 1
}
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source

# yt-dlp needs a JS runtime and matching EJS challenge scripts for some
# YouTube formats. Permit its official GitHub-hosted component as a fallback.
$jsArgs = @()
if ($env:MXTP_NODE_PATH -and (Test-Path -LiteralPath $env:MXTP_NODE_PATH)) {
  $jsArgs += @('--js-runtimes'; "node:$($env:MXTP_NODE_PATH)")
} elseif (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
  if     (Get-Command node -ErrorAction SilentlyContinue) { $jsArgs += @('--js-runtimes'; 'node') }
  elseif (Get-Command bun  -ErrorAction SilentlyContinue) { $jsArgs += @('--js-runtimes'; 'bun')  }
}

function Get-LookupKey([string]$value) {
  return (($value.ToLowerInvariant()) -replace '[^a-z0-9]', '')
}

if ($Update) {
  Write-Step "Updating yt-dlp"
  & python -m pip install -U yt-dlp
}

if ([string]::IsNullOrWhiteSpace($Url) -and -not [string]::IsNullOrWhiteSpace($Artist) -and -not [string]::IsNullOrWhiteSpace($Album)) {
  Write-Step "Finding the official album playlist"
  $query = [Uri]::EscapeDataString("$Artist $Album")
  $searchUrl = "https://www.youtube.com/results?search_query=$query&sp=EgIQAw%3D%3D"
  $searchArgs = $jsArgs + @(
    '--flat-playlist'; '--no-warnings'; '--ignore-errors'
    '--playlist-end'; '12'
    '--dump-json'
    '--'; $searchUrl
  )
  $albumKey = Get-LookupKey $Album
  $artistKey = Get-LookupKey $Artist
  $candidates = @(& $ytdlp @searchArgs 2>$null | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object {
    $_ -and $_.url -and ((Get-LookupKey ([string]$_.title)).Contains($albumKey))
  } | Select-Object -First 6)

  $best = $null
  $bestScore = -1
  foreach ($candidate in $candidates) {
    $probeArgs = $jsArgs + @(
      '--flat-playlist'; '--no-warnings'; '--ignore-errors'
      '--playlist-items'; '1'
      '--print'; '%(playlist_title)s|%(playlist_count)s|%(channel)s'
      '--'; ([string]$candidate.url)
    )
    $probe = @(& $ytdlp @probeArgs 2>$null | Select-Object -First 1)
    if (-not $probe) { continue }
    $parts = ([string]$probe[0]) -split '\|', 3
    if ($parts.Count -lt 3) { continue }
    $titleKey = Get-LookupKey $parts[0]
    $channelKey = Get-LookupKey $parts[2]
    $score = 0
    if ($titleKey -eq $albumKey) { $score += 80 }
    elseif ($titleKey.Contains($albumKey)) { $score += 40 }
    if ($channelKey -eq $artistKey) { $score += 120 }
    elseif ($channelKey.Contains($artistKey) -or $artistKey.Contains($channelKey)) { $score += 90 }
    $trackCount = 0
    [void][int]::TryParse($parts[1], [ref]$trackCount)
    if ($trackCount -gt 1) { $score += [Math]::Min($trackCount, 30) }
    if ($score -gt $bestScore) {
      $bestScore = $score
      $best = [pscustomobject]@{
        Url = [string]$candidate.url
        Title = $parts[0]
        Artist = $parts[2]
        Tracks = $trackCount
      }
    }
  }

  if (-not $best -or $bestScore -lt 80) {
    Write-Bad "Could not find a trustworthy YouTube album playlist for $Artist - $Album."
    exit 2
  }
  $Url = $best.Url
  Write-Host "    Resolved : $($best.Url)"
  Write-Host "    Album    : $($best.Title)"
  Write-Host "    Artist   : $($best.Artist)"
  Write-Host "    Tracks   : $($best.Tracks)"
  if ($ResolveOnly) { exit 0 }
}

Write-Host ""
Write-Host "  YouTube Playlist -> MP3" -ForegroundColor Green
Write-Host "  yt-dlp $(& $ytdlp --version)  |  ffmpeg $(if ($ffmpeg) { 'ok' } else { 'MISSING' })  |  format: $Format"
Write-Host ""

$askedForUrl = $false
if ([string]::IsNullOrWhiteSpace($Url)) {
  $Url = Read-Host "Paste the YouTube playlist URL"
  $askedForUrl = $true
}
if ($askedForUrl -and -not $PSBoundParameters.ContainsKey('Format')) {
  Write-Host ""
  Write-Host "  Format:  [1] best  YouTube's original stream, untouched - best quality (.opus)"
  Write-Host "           [2] m4a   original AAC, untouched, works on phones and car stereos"
  Write-Host "           [3] mp3   re-encoded, slight quality loss, plays on anything"
  $pick = Read-Host "  Choose 1-3 (Enter = 1)"
  switch ($pick.Trim()) { '2' { $Format = 'm4a' } '3' { $Format = 'mp3' } default { $Format = 'best' } }
  Write-Host ""
}
$Url = $Url.Trim().Trim('"')
if ([string]::IsNullOrWhiteSpace($Url)) { Write-Bad "No URL given."; if (-not $NoPause) { Read-Host "Press Enter to close" }; exit 1 }

# --- resolve the playlist name and size before downloading ------------------
Write-Step "Reading playlist"
$probeArgs = $jsArgs + @(
  '--flat-playlist'; '--no-warnings'; '--ignore-errors'
  '--playlist-items'; '1'
  '--print'; '%(playlist_title)s|%(playlist_count)s'
  '--'; $Url
)
$probe = & $ytdlp @probeArgs 2>$null
if ($LASTEXITCODE -ne 0 -or -not $probe) {
  Write-Bad "Could not read that URL. Check the link, or re-run with -Update."
  if (-not $NoPause) { Read-Host "Press Enter to close" }
  exit 1
}
$probe = ($probe | Select-Object -First 1)
$parts = $probe -split '\|'
$title = $parts[0]
$count = $parts[1]

$isPlaylist = $true
if (-not $title -or $title -eq 'NA') {
  $isPlaylist = $false
  $titleArgs = $jsArgs + @('--no-warnings'; '--print'; '%(title)s'; '--playlist-items'; '1'; '--'; $Url)
  $title = (& $ytdlp @titleArgs 2>$null | Select-Object -First 1)
}

$folder = Get-SafeName $title
$dest   = Join-Path $OutRoot $folder
New-Item -ItemType Directory -Force -Path $dest | Out-Null

if (-not $count -or $count -eq 'NA') { $count = '?' }
if ($isPlaylist) { Write-Host "    Playlist : $title ($count items)" }
else             { Write-Host "    Video    : $title" }
Write-Host "    Folder   : $dest"
Write-Host ""

# YouTube often does not expose a separate playlist thumbnail. In that case,
# yt-dlp's first playlist entry thumbnail is the authoritative upload artwork.
$coverArgs = $jsArgs + @(
  '--playlist-items'; '1'
  '--skip-download'
  '--write-thumbnail'
  '--force-overwrites'
  '--no-warnings'
  '--paths'; "home:$dest"
  '-o'; 'cover.%(ext)s'
)
$coverArgs += @('--'; $Url)

Write-Step "Downloading playlist cover"
& $ytdlp @coverArgs | Out-Null
$cover = Get-ChildItem -Path $dest -File -Filter 'cover.*' -ErrorAction SilentlyContinue |
         Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|webp)$' } |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1
if ($cover -and $ffmpeg) {
  $squareCover = Join-Path $dest 'cover.jpg'
  $squareTemp = Join-Path $dest 'cover-square.jpg'
  & $ffmpeg -hide_banner -loglevel error -y -i $cover.FullName -vf "crop='min(iw,ih)':'min(iw,ih)'" -q:v 2 $squareTemp
  if ($LASTEXITCODE -eq 0 -and (Test-Path $squareTemp)) {
    Move-Item -Force -LiteralPath $squareTemp -Destination $squareCover
    $cover = Get-Item -LiteralPath $squareCover
  }
}
if ($cover) { Write-Host "    Cover    : $($cover.FullName)" }
else        { Write-Warn "No playlist artwork was available; audio download will continue." }
Write-Host ""

# --- download ---------------------------------------------------------------
if ($isPlaylist) { $template = "%(playlist_index)03d - %(title)s.%(ext)s" }
else             { $template = "%(title)s.%(ext)s" }

# Pick the source stream and the output handling per format.
#   best  -> remux the original stream into its own container, no re-encode
#   m4a   -> prefer YouTube's AAC stream so it is copied, not transcoded
#   others-> re-encode from the best source
$fmtArgs = @('--extract-audio'; '--audio-format'; $Format)
switch ($Format) {
  'best' { $fmtArgs += @('-f'; 'bestaudio/best') }
  'm4a'  { $fmtArgs += @('-f'; 'bestaudio[ext=m4a]/bestaudio/best') }
  'opus' { $fmtArgs += @('-f'; 'bestaudio[acodec=opus]/bestaudio/best') }
  'mp3'  { $fmtArgs += @('--audio-quality'; $Quality) }
}
if ($Format -in @('flac','wav')) {
  Write-Warn "$Format wraps a lossy YouTube stream in a lossless container."
  Write-Warn "Files get much bigger. The audio does not get better. 'best' is the real answer."
}

$ytArgs = $jsArgs + $fmtArgs + @(
  '--embed-metadata'
  '--yes-playlist'
  '--ignore-errors'
  '--no-abort-on-error'
  '--retries'; '10'
  '--fragment-retries'; '10'
  '--concurrent-fragments'; '4'
  '--windows-filenames'
  '--trim-filenames'; '180'
  '--download-archive'; (Join-Path $dest ".downloaded-$Format.txt")  # re-runs skip what you already have
  '--paths'; "home:$dest"
  '-o'; $template
  '--progress'
  '--newline'
)
# wav has no tag container, and cover art only embeds in these
if ($Format -ne 'wav') { $ytArgs += @('--embed-thumbnail'; '--convert-thumbnails'; 'jpg') }
if ($isPlaylist) {
  # album = playlist name, track = position in the playlist
  $ytArgs += @('--parse-metadata'; '%(playlist_title)s:%(meta_album)s')
  $ytArgs += @('--parse-metadata'; '%(playlist_index)s:%(meta_track)s')
  if (-not [string]::IsNullOrWhiteSpace($PlaylistItems)) {
    $ytArgs += @('--playlist-items'; $PlaylistItems.Trim())
  }
}
if ($ffmpeg) { $ytArgs += @('--ffmpeg-location'; $ffmpeg) }
$ytArgs += @('--'; $Url)

Write-Step "Downloading"
& $ytdlp @ytArgs
$code = $LASTEXITCODE

$audio = @(Get-ChildItem -Path $dest -File -ErrorAction SilentlyContinue |
           Where-Object { $_.Extension -match '^\.(mp3|m4a|opus|webm|flac|wav|ogg|aac)$' })
Write-Host ""
if ($audio.Count -gt 0) {
  $kinds = ($audio | Group-Object Extension | ForEach-Object { "$($_.Count) x $($_.Name)" }) -join ', '
  Write-Host "  Done. $kinds in:" -ForegroundColor Green
  Write-Host "  $dest"
} else {
  Write-Bad "Nothing downloaded (yt-dlp exit $code). Try re-running with -Update."
}

if (-not $NoPause) {
  Write-Host ""
  $open = Read-Host "Open the folder? (y/N)"
  if ($open -match '^(y|yes)$') { Start-Process explorer.exe $dest }
}
exit $code
