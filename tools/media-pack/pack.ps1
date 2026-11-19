# 回憶錄媒體壓縮工具（Windows，免安裝 ffmpeg）
# 用法：把照片或影片資料夾拖到「壓縮回憶錄媒體.bat」上；直接雙擊則跳出選資料夾視窗。
# 輸出在工具資料夾裡的「輸出」：media\（網頁用的檔案）、thumb\（縮圖）、meta\（每個檔案的資訊）、manifest.json（總表）。
# 原檔不會被修改；已經轉過的檔案會略過，可以中斷後再跑。
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$INV = [Globalization.CultureInfo]::InvariantCulture
$UTF8 = New-Object Text.UTF8Encoding $false

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root '輸出'
$Dirs = @{ media = (Join-Path $Out 'media'); thumb = (Join-Path $Out 'thumb'); meta = (Join-Path $Out 'meta') }
foreach ($d in $Dirs.Values) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------- 設定（和公開照片、影片相同） ----------
$PHOTO_LONG = 1600      # 照片長邊
$PANO_LONG = 3600       # 全景（寬高比 > 2.2）長邊
$PHOTO_Q = 78
$THUMB_LONG = 480
$THUMB_Q = 70
$VIDEO_LONG = 1280      # 720p
$VIDEO_CRF = 28
$PHOTO_EXT = @('.jpg', '.jpeg', '.png', '.webp')   # HEIC 請先匯出成 JPEG（iPhone 分享或「照片」App 匯出時選「最相容」）
$VIDEO_EXT = @('.mp4', '.mov', '.m4v')

# ---------- ffmpeg：工具資料夾裡沒有就下載免安裝版 ----------
function Find-FF {
  foreach ($p in @((Join-Path $Root 'ffmpeg\bin'), (Join-Path $Root 'ffmpeg'), $Root)) {
    $e = Join-Path $p 'ffmpeg.exe'; $q = Join-Path $p 'ffprobe.exe'
    if ((Test-Path $e) -and (Test-Path $q)) { return @($e, $q) }
  }
  return $null
}
$ff = Find-FF
if (-not $ff) {
  Write-Host '第一次執行：下載免安裝的 ffmpeg（約 100 MB，只需要一次）…'
  $zip = Join-Path $Root 'ffmpeg-download.zip'
  $urls = @(
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  )
  $ok = $false
  foreach ($u in $urls) {
    try {
      Write-Host "  下載 $u"
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --progress-bar -o $zip $u
        if ($LASTEXITCODE -ne 0) { throw "curl $LASTEXITCODE" }
      } else {
        Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing
      }
      $tmp = Join-Path $Root 'ffmpeg-unzip'
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
      if (-not $bin) { throw 'zip 裡找不到 ffmpeg.exe' }
      $dst = Join-Path $Root 'ffmpeg'
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Move-Item -Path $bin.Directory.Parent.FullName -Destination $dst
      Remove-Item -Recurse -Force $tmp; Remove-Item -Force $zip
      $ok = $true; break
    } catch {
      Write-Host "  失敗：$($_.Exception.Message)"
    }
  }
  $ff = Find-FF
  if (-not $ok -or -not $ff) {
    Write-Host ''
    Write-Host '下載不成功。請自己下載 ffmpeg（Windows 版 zip），解壓縮後把 ffmpeg.exe 和 ffprobe.exe 放進這個工具資料夾，再執行一次。'
    exit 1
  }
}
$FFMPEG = $ff[0]; $FFPROBE = $ff[1]

# ---------- 小工具 ----------
# Windows PowerShell 5.1 在 Stop 模式下會把外部程式的 stderr 當成錯誤，所以呼叫時暫時改成 Continue
function Run-FF([string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $o = & $FFMPEG -hide_banner -loglevel error @a 2>&1
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  if ($code -ne 0) { throw (($o | ForEach-Object { "$_" }) -join "`n").Trim() }
}
function Probe([string]$file, [string]$entries, [switch]$Frames) {
  $a = @('-v', 'error', '-print_format', 'json', '-show_entries', $entries)
  if ($Frames) { $a += @('-read_intervals', '%+#1') }
  $a += $file
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $j = & $FFPROBE @a 2>$null | Out-String
  $ErrorActionPreference = $old
  if (-not $j.Trim()) { return $null }
  return $j | ConvertFrom-Json
}
# EXIF 的度分秒「34:1, 38:1, 5525:100」→ 34.6487
function Dms([string]$s, [string]$ref) {
  if (-not $s) { return $null }
  $parts = $s -split ','
  if ($parts.Count -lt 3) { return $null }
  $v = 0.0; $div = 1.0
  foreach ($p in $parts[0..2]) {
    $nd = $p.Trim() -split ':'
    $n = [double]::Parse($nd[0].Trim(), $INV); $d = [double]::Parse($nd[1].Trim(), $INV)
    if ($d -eq 0) { return $null }
    $v += ($n / $d) / $div; $div *= 60
  }
  $ref = "$ref".Trim()
  if ($ref -eq 'S' -or $ref -eq 'W') { $v = -$v }
  return [math]::Round($v, 6)
}
# 影片的 location「+35.1816+135.9164/」
function Iso6709([string]$s) {
  if ($s -match '^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)') {
    return @([double]::Parse($Matches[1], $INV), [double]::Parse($Matches[2], $INV))
  }
  return $null
}
function NumOf([string]$name) { if ($name -match '(\d{3,})') { return [int]$Matches[1] }; return $null }
function Prop($obj, [string]$name) { if ($obj -and ($obj.PSObject.Properties.Name -contains $name)) { return $obj.$name }; return $null }
function Even([double]$x) { $i = [int][math]::Round($x); if ($i % 2) { $i -= 1 }; return [math]::Max($i, 2) }

# ---------- 照片 ----------
function Do-Photo([IO.FileInfo]$f) {
  $id = $f.BaseName
  $outM = Join-Path $Dirs.media "$id.webp"; $outT = Join-Path $Dirs.thumb "$id.webp"; $outJ = Join-Path $Dirs.meta "$id.json"
  if ((Test-Path $outM) -and (Test-Path $outT) -and (Test-Path $outJ)) { return 'skip' }

  $p = Probe $f.FullName 'frame=width,height:frame_tags=DateTimeOriginal,DateTime,Orientation,GPSLatitude,GPSLatitudeRef,GPSLongitude,GPSLongitudeRef' -Frames
  $fr = $null; if ($p -and $p.frames) { $fr = $p.frames[0] }
  $tags = Prop $fr 'tags'
  $w = [int](Prop $fr 'width'); $h = [int](Prop $fr 'height')
  $ori = "$(Prop $tags 'Orientation')".Trim()
  if (@('5', '6', '7', '8') -contains $ori) { $t = $w; $w = $h; $h = $t }   # ffmpeg 會依 EXIF 自動轉正
  if ($w -le 0 -or $h -le 0) { throw '讀不到尺寸（可能是不支援的格式）' }

  $long = $PHOTO_LONG; if ($w / $h -gt 2.2) { $long = $PANO_LONG }
  $s = [math]::Min(1.0, $long / [math]::Max($w, $h)); $W = Even ($w * $s); $H = Even ($h * $s)
  $ts = [math]::Min(1.0, $THUMB_LONG / [math]::Max($w, $h)); $TW = Even ($w * $ts); $TH = Even ($h * $ts)

  Run-FF @('-nostdin', '-y', '-i', $f.FullName, '-frames:v', '1', '-vf', "scale=${W}:${H}:flags=lanczos", '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', "$PHOTO_Q", '-preset', 'photo', $outM)
  Run-FF @('-nostdin', '-y', '-i', $f.FullName, '-frames:v', '1', '-vf', "scale=${TW}:${TH}:flags=lanczos", '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', "$THUMB_Q", $outT)

  $taken = "$(Prop $tags 'DateTimeOriginal')".Trim(); if (-not $taken) { $taken = "$(Prop $tags 'DateTime')".Trim() }
  if ($taken -match '^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})') { $taken = "$($Matches[1])-$($Matches[2])-$($Matches[3])T$($Matches[4])" }
  $lat = Dms (Prop $tags 'GPSLatitude') (Prop $tags 'GPSLatitudeRef')
  $lon = Dms (Prop $tags 'GPSLongitude') (Prop $tags 'GPSLongitudeRef')

  $m = [ordered]@{
    id = $id; kind = 'photo'; src = $f.Name; num = (NumOf $id)
    file = "media/$id.webp"; thumb = "thumb/$id.webp"
    w = $W; h = $H; bytes = (Get-Item $outM).Length; thumbBytes = (Get-Item $outT).Length; srcBytes = $f.Length
    taken = $taken; takenReliable = [bool]$taken; lat = $lat; lon = $lon; note = ''
  }
  [IO.File]::WriteAllText($outJ, ($m | ConvertTo-Json -Depth 4), $UTF8)
  return 'ok'
}

# ---------- 影片 ----------
function Do-Video([IO.FileInfo]$f) {
  $id = $f.BaseName
  $outM = Join-Path $Dirs.media "$id.mp4"; $outP = Join-Path $Dirs.media "$id.jpg"; $outT = Join-Path $Dirs.thumb "$id.webp"; $outJ = Join-Path $Dirs.meta "$id.json"
  if ((Test-Path $outM) -and (Test-Path $outP) -and (Test-Path $outT) -and (Test-Path $outJ)) { return 'skip' }

  $src = Probe $f.FullName 'format=duration:format_tags'
  $tags = Prop (Prop $src 'format') 'tags'
  $tmp = "$outM.part.mp4"
  Run-FF @('-nostdin', '-y', '-i', $f.FullName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', "scale='if(gt(iw,ih),min($VIDEO_LONG,iw),-2)':'if(gt(iw,ih),-2,min($VIDEO_LONG,ih))'",
    '-c:v', 'libx264', '-preset', 'slow', '-crf', "$VIDEO_CRF", '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', $tmp)
  Move-Item -Force $tmp $outM

  $o = Probe $outM 'format=duration:stream=codec_type,width,height'
  $dur = [double]::Parse("$(Prop (Prop $o 'format') 'duration')", $INV)
  $vs = $o.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
  $W = [int]$vs.width; $H = [int]$vs.height
  $hasAudio = [bool]($o.streams | Where-Object { $_.codec_type -eq 'audio' })
  $at = ($dur / 3).ToString('0.###', $INV)
  $pl = 960; $ps = [math]::Min(1.0, $pl / [math]::Max($W, $H)); $PW = Even ($W * $ps); $PH = Even ($H * $ps)
  $ts = [math]::Min(1.0, $THUMB_LONG / [math]::Max($W, $H)); $TW = Even ($W * $ts); $TH = Even ($H * $ts)
  Run-FF @('-nostdin', '-y', '-ss', $at, '-i', $outM, '-frames:v', '1', '-vf', "scale=${PW}:${PH}", '-map_metadata', '-1', '-q:v', '4', $outP)
  Run-FF @('-nostdin', '-y', '-ss', $at, '-i', $outM, '-frames:v', '1', '-vf', "scale=${TW}:${TH}", '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', "$THUMB_Q", $outT)

  # 時間：iPhone 的 creationdate 最可靠；只有 creation_time 時常常是匯出的日期，標成不可靠
  $taken = "$(Prop $tags 'com.apple.quicktime.creationdate')".Trim(); $rel = [bool]$taken
  if (-not $taken) { $taken = "$(Prop $tags 'creation_time')".Trim() }
  $loc = Prop $tags 'com.apple.quicktime.location.ISO6709'; if (-not $loc) { $loc = Prop $tags 'location' }
  $ll = $null; if ($loc) { $ll = Iso6709 ([string]$loc) }

  $m = [ordered]@{
    id = $id; kind = 'video'; src = $f.Name; num = (NumOf $id)
    file = "media/$id.mp4"; poster = "media/$id.jpg"; thumb = "thumb/$id.webp"
    w = $W; h = $H; tall = ($H -gt $W); dur = [math]::Round($dur, 2); audio = $hasAudio
    bytes = (Get-Item $outM).Length; posterBytes = (Get-Item $outP).Length; thumbBytes = (Get-Item $outT).Length; srcBytes = $f.Length
    taken = $taken; takenReliable = $rel
    lat = $(if ($ll) { $ll[0] } else { $null }); lon = $(if ($ll) { $ll[1] } else { $null }); note = ''
  }
  [IO.File]::WriteAllText($outJ, ($m | ConvertTo-Json -Depth 4), $UTF8)
  return 'ok'
}

# ---------- 要處理哪些資料夾 ----------
if (-not $Paths -or $Paths.Count -eq 0) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '選擇要壓縮的照片或影片資料夾'
  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $Paths = @($dlg.SelectedPath)
}
$files = @()
foreach ($p in $Paths) {
  if (Test-Path -LiteralPath $p -PathType Container) { $files += Get-ChildItem -LiteralPath $p -File }
  elseif (Test-Path -LiteralPath $p -PathType Leaf) { $files += Get-Item -LiteralPath $p }
}
$files = $files | Sort-Object Name
$todo = @($files | Where-Object { ($PHOTO_EXT + $VIDEO_EXT) -contains $_.Extension.ToLower() })
$ignored = @($files | Where-Object { ($PHOTO_EXT + $VIDEO_EXT) -notcontains $_.Extension.ToLower() })
Write-Host "找到 $($todo.Count) 個照片／影片$(if ($ignored.Count) { "（略過 $($ignored.Count) 個其他檔案：$(($ignored | ForEach-Object Name) -join '、')）" })"

$fail = @(); $i = 0
foreach ($f in $todo) {
  $i++
  $isV = $VIDEO_EXT -contains $f.Extension.ToLower()
  Write-Host -NoNewline ("[{0}/{1}] {2} … " -f $i, $todo.Count, $f.Name)
  try {
    $r = if ($isV) { Do-Video $f } else { Do-Photo $f }
    Write-Host $(if ($r -eq 'skip') { '已經轉過，略過' } else { '完成' })
  } catch {
    Write-Host '失敗'
    $fail += "$($f.Name)：$(($_.Exception.Message -split "`n")[-1])"
  }
}

# ---------- 合成 manifest.json ----------
$items = @(Get-ChildItem -LiteralPath $Dirs.meta -Filter '*.json' | Sort-Object Name | ForEach-Object {
  [IO.File]::ReadAllText($_.FullName, $UTF8) | ConvertFrom-Json })
$ph = @($items | Where-Object { $_.kind -eq 'photo' }); $vd = @($items | Where-Object { $_.kind -eq 'video' })
function SumOf($arr, [string[]]$keys) { $s = 0; foreach ($x in $arr) { foreach ($k in $keys) { $v = Prop $x $k; if ($v) { $s += [long]$v } } }; return $s }
$tot = [ordered]@{
  photos = $ph.Count; videos = $vd.Count
  photoBytes = (SumOf $ph @('bytes', 'thumbBytes')); videoBytes = (SumOf $vd @('bytes', 'posterBytes', 'thumbBytes'))
  srcBytes = (SumOf $items @('srcBytes'))
}
$man = [ordered]@{ v = 1; tool = 'memoir-media-pack'; createdAt = (Get-Date).ToString('s'); totals = $tot; items = $items }
[IO.File]::WriteAllText((Join-Path $Out 'manifest.json'), ($man | ConvertTo-Json -Depth 6), $UTF8)

function MB([long]$b) { return ($b / 1MB).ToString('0.0', $INV) }
Write-Host ''
Write-Host '===== 完成 ====='
Write-Host "照片 $($tot.photos) 張：$(MB $tot.photoBytes) MB（含縮圖）"
Write-Host "影片 $($tot.videos) 支：$(MB $tot.videoBytes) MB（含封面、縮圖）"
Write-Host "合計 $(MB ($tot.photoBytes + $tot.videoBytes)) MB（原檔 $(MB $tot.srcBytes) MB）"
Write-Host "輸出在：$Out"
if ($fail.Count) { Write-Host ''; Write-Host "有 $($fail.Count) 個失敗："; $fail | ForEach-Object { Write-Host "  $_" } }
