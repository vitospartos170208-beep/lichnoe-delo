# Сборка архива для загрузки на хостинг рег.ру.
#
#   powershell -ExecutionPolicy Bypass -File tools\build.ps1 -Domain lichnoe-delo-show.ru
#
# Результат: dist\lichnoe-delo-<домен>.zip — распаковать в папку сайта на хостинге (www/<домен>/).
# Внутри только то, что нужно сайту: без .git, инструкций, служебных скриптов и неиспользуемых картинок.
# api/config.php в архив НЕ кладётся — его создают на хостинге из api/config.sample.php (там код ведущих).
param(
  [Parameter(Mandatory = $true)][string]$Domain
)
$ErrorActionPreference = 'Stop'
$Domain = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '/.*$', ''
if ($Domain -notmatch '^[a-z0-9а-яё.-]+\.[a-zа-я]{2,}$') { throw "Не похоже на домен: $Domain" }

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'site'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

$files = @(
  'index.html', '.htaccess',
  'api\index.php', 'api\.htaccess', 'api\config.sample.php',
  'assets\style.css', 'assets\app.js', 'assets\vendor\qrcode.js',
  'img\blonde-vote.webp', 'img\brunette-vote.webp', 'img\detective-indicator-clean.webp',
  'img\gift-ticket-show.webp', 'img\hosts-two-men-flanking-wheel.webp', 'img\neon-wheel-buttons.webp',
  'img\reel-strip.webp', 'img\reel-shade-0.png', 'img\reel-shade-1.png', 'img\reel-shade-2.png',
  'img\show-poster.webp'
)
$files += Get-ChildItem (Join-Path $root 'assets\fonts') -Filter *.woff2 | ForEach-Object { "assets\fonts\$($_.Name)" }

foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { throw "Нет файла: $f" }
  $dst = Join-Path $stage $f
  New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
  Copy-Item $src $dst
}

# Превью ссылки в мессенджерах требует полный адрес картинки.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$indexPath = Join-Path $stage 'index.html'
$html = [IO.File]::ReadAllText($indexPath, $utf8)
$html = $html.Replace('content="img/show-poster.webp"', "content=""https://$Domain/img/show-poster.webp""")
$html = $html.Replace('<meta property="og:type" content="website">', "<meta property=""og:type"" content=""website"">`n  <meta property=""og:url"" content=""https://$Domain/"">")
[IO.File]::WriteAllText($indexPath, $html, $utf8)

# Заглушка для старого адреса на GitHub Pages: переадресация на новый домен.
$redirect = @"
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Шоу «Личное дело» переехало</title>
  <meta http-equiv="refresh" content="0; url=https://$Domain/">
  <link rel="canonical" href="https://$Domain/">
  <script>location.replace('https://$Domain/' + location.search + location.hash);</script>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#140b08;color:#f7e8cb;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:16px}a{color:#ffe2a0}</style>
</head>
<body>
  <p>Сайт шоу «Личное дело» переехал.<br><a href="https://$Domain/">Перейти на $Domain</a></p>
</body>
</html>
"@
$redirectDir = Join-Path $dist 'github-pages-redirect'
New-Item -ItemType Directory -Force $redirectDir | Out-Null
[IO.File]::WriteAllText((Join-Path $redirectDir 'index.html'), $redirect, $utf8)

$zip = Join-Path $dist "lichnoe-delo-$Domain.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# Собираем zip через .NET с путями через «/»: Compress-Archive в Windows PowerShell 5.1 пишет обратную
# косую черту, и на Linux-хостинге вместо папки api появился бы файл с именем «api\index.php».
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $stage $f), $f.Replace([char]92, [char]47), [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $archive.Dispose() }

$size = [math]::Round((Get-Item $zip).Length / 1KB)
Write-Host "Готово: $zip ($size КБ, файлов: $($files.Count))"
Write-Host "Переадресация для GitHub Pages: $redirectDir\index.html"
