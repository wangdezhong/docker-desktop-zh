<#
.SYNOPSIS
  Docker Desktop 界面汉化脚本 (dd-zh)

.DESCRIPTION
  通过重打包 frontend/resources/app.asar，向 Docker Desktop 的 UI 注入一个
  基于词典的中文翻译运行时。不修改任何可执行文件，不触碰 Electron fuses，
  原始 app.asar 自动备份，可随时无损还原。

  用法（需要管理员权限，首次运行会自动弹出 UAC）:
    powershell -ExecutionPolicy Bypass -File dd-zh.ps1 install     # 安装/更新汉化
    powershell -ExecutionPolicy Bypass -File dd-zh.ps1 uninstall   # 还原英文原版
    powershell -ExecutionPolicy Bypass -File dd-zh.ps1 status      # 查看状态

  注意:
   - Docker Desktop 升级后需重新运行 install。
   - 扩展词典: 编辑 src\zh-cn.dict.json 后重新 install 即可生效。

.PARAMETER Action
  install / uninstall / status

.PARAMETER DockerPath
  Docker Desktop 安装目录，默认 "C:\Program Files\Docker\Docker"

.PARAMETER NoStart
  install 完成后不自动启动 Docker Desktop
#>
param(
  [Parameter(Position = 0)][ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',
  [string]$DockerPath = "$env:ProgramFiles\Docker\Docker",
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = $PSScriptRoot
$Repack = Join-Path $ScriptRoot 'tools\repack.js'
$SrcDir = Join-Path $ScriptRoot 'src'
$AsarPath = Join-Path $DockerPath 'frontend\resources\app.asar'
$BakPath = "$AsarPath.bak"
$MetaPath = "$AsarPath.dd-zh.json"
$FrontendExe = Join-Path $DockerPath 'frontend\Docker Desktop.exe'
$ExeBak = "$FrontendExe.dd-zh.bak"
$Launcher = Join-Path $DockerPath 'Docker Desktop.exe'

function Info($msg) { Write-Host "[dd-zh] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "[dd-zh] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[dd-zh] $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "[dd-zh] $msg" -ForegroundColor Red; exit 1 }

# ---------- 提权（安装/卸载需要写 Program Files） ----------
function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = [Security.Principal.WindowsPrincipal]$id
  if ($admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
  Info '需要管理员权限，正在请求 UAC 提权...'
  $args2 = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, $Action, '-DockerPath', $DockerPath)
  if ($NoStart) { $args2 += '-NoStart' }
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -Verb RunAs -PassThru -Wait
  exit $proc.ExitCode
}

# ---------- 查找 Node.js ----------
function Get-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Invoke-Node {
  param([string]$NodeExe, [string[]]$NodeArgs)
  & $NodeExe $Repack @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "repack.js 执行失败 (exit $LASTEXITCODE)" }
}

# ---------- 停止 Docker Desktop 前端 ----------
function Stop-DockerDesktopUi {
  $procs = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
  if (-not $procs) { Info 'Docker Desktop 未在运行'; return }
  Info '正在关闭 Docker Desktop 窗口进程...'
  foreach ($p in $procs) {
    try { $p.CloseMainWindow() | Out-Null } catch { }
  }
  (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) | ForEach-Object {
    try { $_.Kill(); $_.WaitForExit(8000) } catch { }
  }
  Start-Sleep -Milliseconds 800
  Ok 'Docker Desktop 前端已关闭'
}

function Start-DockerDesktopUi {
  if (-not (Test-Path $Launcher)) { Warn "未找到启动器: $Launcher"; return }
  Info '正在启动 Docker Desktop...'
  Start-Process -FilePath $Launcher | Out-Null
}

# ---------- 元数据 ----------
function Read-Meta {
  if (Test-Path $MetaPath) { try { return Get-Content $MetaPath -Raw | ConvertFrom-Json } catch { return $null } }
  return $null
}
function Write-Meta($version, $hash) {
  @{ tool = 'dd-zh'; version = $version; headerHash = $hash; patchedAt = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content -Path $MetaPath -Encoding UTF8
}

# ---------- asar 状态 ----------
function Get-AsarStatus($NodeExe, [string]$Path) {
  $target = if ($Path) { $Path } else { $AsarPath }
  $out = Invoke-Node $NodeExe @('status', '--asar', $target)
  $json = ($out -join "`n")
  $start = $json.IndexOf('{')
  if ($start -lt 0) { throw "无法解析 status 输出: $json" }
  return ($json.Substring($start) | ConvertFrom-Json)
}

# ==================================================================
switch ($Action) {

  'status' {
    if (-not (Test-Path $AsarPath)) { Die "未找到 $AsarPath，请确认 Docker Desktop 已安装（可用 -DockerPath 指定）" }
    $node = Get-NodeExe
    if (-not $node) { Die '未找到 Node.js，请先安装 Node.js 或将其加入 PATH' }
    $st = Get-AsarStatus $node
    $meta = Read-Meta
    Write-Host ''
    Write-Host '========== Docker Desktop 汉化状态 =========='
    Write-Host ("  安装路径    : {0}" -f $DockerPath)
    Write-Host ("  程序版本    : {0}" -f $st.version)
    Write-Host ("  汉化状态    : {0}" -f $(if ($st.patched) { '已汉化' } else { '未汉化' }))
    Write-Host ("  备份文件    : {0}" -f $(if (Test-Path $BakPath) { "存在 ($BakPath)" } else { '无' }))
    if ($meta) { Write-Host ("  打补丁时间  : {0}" -f $meta.patchedAt) }
    Write-Host ("  Node.js     : {0}" -f $node)
    Write-Host '============================================='
    Write-Host ''
  }

  'install' {
    Assert-Admin
    if (-not (Test-Path $AsarPath)) { Die "未找到 $AsarPath，请确认 Docker Desktop 已安装" }
    if (-not (Test-Path (Join-Path $DockerPath 'frontend\Docker Desktop.exe'))) { Die '目录结构异常，不是预期的 Docker Desktop 安装' }
    $node = Get-NodeExe
    if (-not $node) { Die '未找到 Node.js，请先安装 Node.js（https://nodejs.org）后重试' }

    $st = Get-AsarStatus $node
    Info ("检测到 Docker Desktop {0}，当前汉化状态: {1}" -f $st.version, $(if ($st.patched) { '已汉化' } else { '未汉化' }))

    Stop-DockerDesktopUi

    # 统一从干净基线开始：有备份就恢复备份（备份是构造出来的原始文件），
    # 只有版本升级（meta.version 不一致）才用当前文件重建两份备份。
    $meta = Read-Meta
    if (Test-Path $BakPath) {
      if ($meta -and $meta.version -ne $st.version) {
        Warn ('备份版本 {0} 与当前版本 {1} 不一致，视为 Docker Desktop 已升级，重建备份' -f $meta.version, $st.version)
        Remove-Item $ExeBak -Force -ErrorAction SilentlyContinue
        Remove-Item $BakPath -Force
        Info '正在备份原始 app.asar 与前端 exe...'
        Copy-Item $AsarPath $BakPath -Force
        Copy-Item $FrontendExe $ExeBak -Force
        Write-Meta $st.version $st.headerHash
      } else {
        if ($st.patched) { Info '正在从备份还原原始 app.asar...' }
        Copy-Item $BakPath $AsarPath -Force
        $st = Get-AsarStatus $node
        if ($st.patched) { Die '还原失败，中止' }
      }
    } else {
      Info '正在备份原始 app.asar 与前端 exe...'
      Copy-Item $AsarPath $BakPath -Force
      Copy-Item $FrontendExe $ExeBak -Force
      Write-Meta $st.version $st.headerHash
    }

    Info '正在构建汉化包并校验...'
    $tmpOut = "$AsarPath.new"
    $buildOut = Invoke-Node $node @('build', '--asar', $AsarPath, '--out', $tmpOut, '--src', $SrcDir)
    $buildJson = ($buildOut -join "`n")
    $bstart = $buildJson.IndexOf('{')
    if ($bstart -lt 0) { Die "无法解析 build 输出: $buildJson" }
    $tmpHash = ($buildJson.Substring($bstart) | ConvertFrom-Json).headerHash
    if (-not $tmpHash) { Die 'build 输出缺少 headerHash' }
    $null = Invoke-Node $node @('verify', '--asar', $tmpOut, '--orig', $AsarPath, '--src', $SrcDir)
    Ok '构建与全量校验通过'

    Info '正在同步改写 exe 内嵌的 asar 头部哈希...'
    $fromCandidates = @($st.headerHash, $meta.headerHash) | Where-Object { $_ } | Select-Object -Unique
    Invoke-Node $node @('exe', '--exe', $FrontendExe, '--from', ($fromCandidates -join ','), '--to', $tmpHash) | Out-Null

    Info '正在替换 app.asar...'
    Move-Item $AsarPath "$AsarPath.old" -Force
    try {
      Move-Item $tmpOut $AsarPath -Force
    } catch {
      Move-Item "$AsarPath.old" $AsarPath -Force
      Invoke-Node $node @('exe', '--exe', $FrontendExe, '--from', $tmpHash, '--to', $st.headerHash) | Out-Null
      Die "替换失败，已回滚: $_"
    }
    Remove-Item "$AsarPath.old" -Force -ErrorAction SilentlyContinue

    $st2 = Get-AsarStatus $node
    if (-not $st2.patched) { Die '安装后校验失败：asar 未包含汉化标记' }
    if ($st2.headerHash -ne $tmpHash) { Die '安装后校验失败：头部哈希不一致' }
    $dictCount = '未知'
    try {
      # 用 node 统计（PS 5.1 的 ConvertFrom-Json 大小写不敏感，无法解析 Running/running 这类键）
      $dictCount = (& $node -e "process.stdout.write(String(Object.keys(require(process.argv[1]).exact).length))" (Join-Path $SrcDir 'zh-cn.dict.json'))
    } catch { }
    Write-Meta $st2.version $st2.headerHash
    Ok ("汉化完成！版本 {0}，词典 {1} 条" -f $st2.version, $dictCount)

    if (-not $NoStart) { Start-DockerDesktopUi }
  }

  'uninstall' {
    Assert-Admin
    $node = Get-NodeExe
    if (-not (Test-Path $BakPath)) {
      if (-not $node) { Die '未找到 Node.js，无法检查状态；请手动还原 app.asar.bak' }
      $st = Get-AsarStatus $node
      if (-not $st.patched) { Ok '未安装汉化，无需还原' ; exit 0 }
      Die "已汉化但找不到备份 $BakPath，无法自动还原"
    }
    Stop-DockerDesktopUi
    Info '正在还原原始 app.asar 与 exe 头部哈希...'
    $curHash = (Get-AsarStatus $node).headerHash
    $origHash = (Get-AsarStatus $node $BakPath).headerHash
    Copy-Item $BakPath $AsarPath -Force
    if ($curHash -ne $origHash) {
      # exe 内嵌哈希同步改回（若 exe 已是原始哈希则为幂等操作）
      $fromCandidates = @($curHash, (Read-Meta).headerHash) | Where-Object { $_ } | Select-Object -Unique
      Invoke-Node $node @('exe', '--exe', $FrontendExe, '--from', ($fromCandidates -join ','), '--to', $origHash) | Out-Null
    }
    Remove-Item $BakPath -Force
    Remove-Item $MetaPath -Force -ErrorAction SilentlyContinue
    if ($node) {
      $st = Get-AsarStatus $node
      if ($st.patched) { Die '还原后仍检测到汉化标记，请检查备份文件' }
      if ($st.headerHash -ne $origHash) { Die '还原后头部哈希不一致' }
    }
    Ok '已还原为英文原版'
    if (-not $NoStart) { Start-DockerDesktopUi }
  }
}
