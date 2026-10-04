# 墨阅 · 一键构建脚本
# 1. 检查/下载内嵌浏览器开发包；2. 生成界面资源清单；3. 导入 VS 编译环境；4. 编译资源与宿主程序。
# 用法：双击或在命令行运行 build.cmd（它会以 UTF-8 读取本脚本，避免中文被按系统默认编码误读）
param(
  [string]$Root = $PSScriptRoot,   # 项目根目录
  [switch]$DebugBuild              # 生成带调试信息的版本
)

$ErrorActionPreference = 'Stop'
$root = $Root.TrimEnd('\')
$webDir = Join-Path $root 'web'
$hostDir = Join-Path $root 'host'
$sdkDir = Join-Path $root 'third_party\webview2'
$genDir = Join-Path $root 'build\gen'
$objDir = Join-Path $root 'build\obj'
$distDir = Join-Path $root 'dist'
$exe = Join-Path $distDir 'MdReader.exe'
$utf8 = New-Object System.Text.UTF8Encoding($false)   # 统一使用无 BOM 的 UTF-8

foreach ($d in $genDir, $objDir, $distDir) { New-Item -ItemType Directory -Force $d | Out-Null }

# ───── 1. 开发包 ─────
$sdkHeader = Join-Path $sdkDir 'include\WebView2.h'
$sdkLib = Join-Path $sdkDir 'x64\WebView2LoaderStatic.lib'
if (-not (Test-Path $sdkHeader) -or -not (Test-Path $sdkLib)) {
  $ver = '1.0.4258.31'
  Write-Host "下载内嵌浏览器开发包 $ver ..."
  $zip = Join-Path $objDir 'webview2-sdk.zip'
  $ex = Join-Path $objDir 'webview2-sdk'
  Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$ver/microsoft.web.webview2.$ver.nupkg" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  New-Item -ItemType Directory -Force (Join-Path $sdkDir 'include'), (Join-Path $sdkDir 'x64') | Out-Null
  Copy-Item (Join-Path $ex 'build\native\include\WebView2.h') (Join-Path $sdkDir 'include') -Force
  Copy-Item (Join-Path $ex 'build\native\include\WebView2EnvironmentOptions.h') (Join-Path $sdkDir 'include') -Force
  Copy-Item (Join-Path $ex 'build\native\x64\WebView2LoaderStatic.lib') (Join-Path $sdkDir 'x64') -Force
  Copy-Item (Join-Path $ex 'LICENSE.txt') (Join-Path $sdkDir 'LICENSE.txt') -Force
}

# ───── 2. 资源清单 ─────
Write-Host '生成界面资源清单 ...'
$files = Get-ChildItem $webDir -Recurse -File | Where-Object { $_.Extension -notin @('.map') } | Sort-Object FullName
$rc = New-Object System.Text.StringBuilder
$hdr = New-Object System.Text.StringBuilder
[void]$rc.AppendLine('// 由构建脚本自动生成，请勿手动修改')
[void]$rc.AppendLine('#pragma code_page(65001)')
[void]$hdr.AppendLine('// 由构建脚本自动生成，请勿手动修改')
[void]$hdr.AppendLine('#pragma once')
[void]$hdr.AppendLine('struct EmbeddedWebFile { const wchar_t* path; int id; };')
[void]$hdr.AppendLine('static const EmbeddedWebFile kEmbeddedWebFiles[] = {')
$id = 3001
$total = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($webDir.Length + 1).Replace('\', '/')
  $abs = $f.FullName.Replace('\', '\\')
  [void]$rc.AppendLine("$id RCDATA `"$abs`"")
  [void]$hdr.AppendLine("  { L`"$rel`", $id },")
  $id++
  $total += $f.Length
}
[void]$hdr.AppendLine('};')
[IO.File]::WriteAllText((Join-Path $genDir 'web_resources.rc'), $rc.ToString(), $utf8)
[IO.File]::WriteAllText((Join-Path $genDir 'web_resources.h'), $hdr.ToString(), $utf8)
Write-Host ("  共 {0} 个文件，{1:N0} 字节" -f $files.Count, $total)

# ───── 3. 编译环境 ─────
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw '未找到 Visual Studio（需要“使用 C++ 的桌面开发”工作负载）' }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw '未找到 MSVC 编译工具' }
$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
$envDump = cmd /c "call `"$vcvars`" >nul 2>&1 && set"
foreach ($line in $envDump) {
  if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}

# ───── 4. 编译 ─────
Write-Host '编译资源 ...'
Push-Location $hostDir
try {
  & rc.exe /nologo /I $genDir /I $hostDir /fo (Join-Path $objDir 'app.res') (Join-Path $hostDir 'app.rc')
  if ($LASTEXITCODE -ne 0) { throw "资源编译失败（$LASTEXITCODE）" }
} finally { Pop-Location }

Write-Host '编译宿主程序 ...'
$cflags = @('/nologo', '/std:c++17', '/utf-8', '/EHsc', '/W4', '/permissive-', '/Zc:__cplusplus', '/DUNICODE', '/D_UNICODE',
            "/I$(Join-Path $sdkDir 'include')", "/I$genDir", "/I$hostDir", "/Fo$(Join-Path $objDir 'main.obj')")
if ($DebugBuild) { $cflags += @('/Od', '/Zi', '/MTd', "/Fd$(Join-Path $objDir 'main.pdb')") }
else { $cflags += @('/O2', '/MT', '/DNDEBUG', '/GS') }
$lflags = @('/link', '/SUBSYSTEM:WINDOWS', '/OPT:REF', '/OPT:ICF', '/INCREMENTAL:NO', "/OUT:$exe", "/LIBPATH:$(Join-Path $sdkDir 'x64')",
            'WebView2LoaderStatic.lib', 'user32.lib', 'gdi32.lib', 'shell32.lib', 'shlwapi.lib', 'ole32.lib', 'oleaut32.lib',
            'uuid.lib', 'dwmapi.lib', 'advapi32.lib', 'version.lib')
if ($DebugBuild) { $lflags += '/DEBUG' }
& cl.exe @cflags (Join-Path $hostDir 'main.cpp') (Join-Path $objDir 'app.res') @lflags
if ($LASTEXITCODE -ne 0) { throw "编译失败（$LASTEXITCODE）。若提示无法写入 exe，请先关闭正在运行的墨阅。" }

$size = (Get-Item $exe).Length
Write-Host ("构建完成：{0}（{1:N0} 字节）" -f $exe, $size)
