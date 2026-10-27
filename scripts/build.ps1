param(
    [string]$RuntimePath,
    [string]$RuntimeLicensePath,
    [switch]$Package,
    [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) {
    $compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'The Windows .NET Framework C# compiler could not be found.' }

# Draw a local application icon using Windows APIs.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64, 64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(74, 73, 224))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 4
$graphics.DrawEllipse($pen, 13, 13, 38, 38)
$graphics.DrawEllipse($pen, 24, 24, 16, 16)
$graphics.DrawLine($pen, 32, 7, 32, 20)
$graphics.DrawLine($pen, 44, 32, 57, 32)
$iconPath = Join-Path $projectRoot 'launcher\NodeScope.ico'
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconStream = [IO.File]::Create($iconPath)
try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $icon.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }

$launcherPath = Join-Path $projectRoot 'NodeScope.exe'
$sourcePath = Join-Path $projectRoot 'launcher\Program.cs'
& $compilerPath /nologo /codepage:65001 /target:winexe /optimize+ /platform:anycpu "/out:$launcherPath" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Write-Host "Built $launcherPath"
if (-not $Package -and -not $Zip) { exit 0 }

if (-not $RuntimePath) {
    $bundledRuntime = Join-Path $projectRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundledRuntime) { $RuntimePath = $bundledRuntime }
    else { $RuntimePath = (Get-Command node.exe -ErrorAction Stop).Source }
}
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath -ErrorAction Stop).Path
$packageRoot = Join-Path $projectRoot 'dist\NodeScope'
$packageData = Join-Path $packageRoot 'data'
if ((Test-Path -LiteralPath $packageData) -and @(Get-ChildItem -LiteralPath $packageData -Force).Count -gt 0) {
    throw 'dist/NodeScope/data contains runtime data. Move the existing portable folder to another location before packaging. No history or logs have been deleted.'
}
New-Item -ItemType Directory -Force -Path $packageRoot, (Join-Path $packageRoot 'runtime'), (Join-Path $packageRoot 'data') | Out-Null
foreach ($file in @('NodeScope.exe', 'server.cjs', 'start.cmd', 'package.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $packageRoot $file) -Force
}
foreach ($directory in @('lib', 'public')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $packageRoot -Recurse -Force
}
Copy-Item -LiteralPath $RuntimePath -Destination (Join-Path $packageRoot 'runtime\node.exe') -Force
if (-not $RuntimeLicensePath) {
    $RuntimeLicensePath = Join-Path ([IO.Path]::GetDirectoryName($RuntimePath)) 'LICENSE.txt'
    if (-not (Test-Path -LiteralPath $RuntimeLicensePath)) {
        $RuntimeLicensePath = Join-Path $projectRoot 'runtime\LICENSE.txt'
    }
}
if (-not (Test-Path -LiteralPath $RuntimeLicensePath)) {
    throw 'Node.js license text is required. Supply -RuntimeLicensePath with the LICENSE file for the bundled runtime version.'
}
Copy-Item -LiteralPath $RuntimeLicensePath -Destination (Join-Path $packageRoot 'runtime\LICENSE.txt') -Force
Write-Host "Portable folder: $packageRoot"
if ($Zip) {
    $zipPath = Join-Path $projectRoot 'dist\NodeScope-Windows-portable.zip'
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal -Force
    Write-Host "Portable archive: $zipPath"
    $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashPath = $zipPath + '.sha256'
    [IO.File]::WriteAllText($hashPath, "$archiveHash  NodeScope-Windows-portable.zip`n", (New-Object Text.UTF8Encoding($false)))
    Write-Host "SHA256: $archiveHash"
}



