# Installs the DSH port of unica on Windows.
#
#   irm https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.ps1 | iex
#
# This is a downloader, not the installer: it fetches the release archive, checks
# it against the published SHA-256, unpacks it and hands over to `install.mjs`,
# which owns every decision about profiles and cache paths. That keeps one
# implementation of the install logic, written once in Node.
#
# The file is deliberately ASCII-only and BOM-less. ASCII-only because Windows
# PowerShell 5.1 reads a BOM-less script as ANSI, so a stray em dash in a comment
# would break parsing on the very machines this script is for. BOM-less because
# `irm ... | iex` is the documented entry point, and Invoke-RestMethod on
# PowerShell 7 keeps a UTF-8 BOM as U+FEFF: the attribute list then stops being
# the first thing the parser sees and the run dies with "Unexpected attribute
# 'CmdletBinding'" before a single line executes.
#
# Parameters:
#   -Version v0.15.0.4   release tag to install (default: the latest)
#   -Profile web         DSH profile to patch (default: desktop if the Desktop
#                        app has one, otherwise web)
#   -DshHome C:\...\.dsh DSH home; normally taken from the environment
#   -NoVerify            skip the native self-test after installing
#   -Target preset       preset | profile | both
#
# No [CmdletBinding()] on purpose: it is a statement attribute, and the text
# `irm ... | iex` evaluates is not a script file, so a host that accepts the
# attribute only at the head of a file rejects it. Nothing below needs it.
#
# Nothing here calls `exit` under `irm ... | iex`: the text is evaluated inside the
# interactive session, so `exit` ends that session instead of returning to a prompt
# - and the console window then stays on screen, owned by whatever the self-test
# left running. `Die` throws, which is fatal in both modes, and a `-File` run gets
# its exit code from the single `exit` at the very end.
param(
  [string]$Version,
  [string]$Profile,
  [string]$DshHome,
  [string]$Target = 'preset',
  [string]$Repo = 'malinovme/dsh-unica',
  # Overridable so the download can be exercised without the network.
  [string]$BaseUrl,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$Asset = 'dsh-plugin-unica.tar.gz'

function Say([string]$Message) { Write-Host $Message }
function Die([string]$Message) { throw "unica installer: $Message" }

# -- prerequisites ----------------------------------------------------------
# Node is the one hard requirement, and DSH could not run without it either.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die 'Node.js is required (DSH itself needs it). Install it from https://nodejs.org and run this again.'
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Die 'tar is required to unpack the archive; Windows 10 1803 and newer ship it.'
}

# -- which release ----------------------------------------------------------
# Asked for rather than hard-coded: a version written into this script goes
# stale silently, and the failure would surface as a download error on a tag
# that used to exist. A pinned -Version skips the lookup.
if (-not $Version) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $Version = (& gh release view --repo $Repo --json tagName -q .tagName 2>$null | Select-Object -First 1)
  }
  if (-not $Version) {
    # TLS 1.2 is not the default on every Windows PowerShell, and the lookup
    # then fails with an error that says nothing about TLS.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ accept = 'application/vnd.github+json' } -UseBasicParsing
      $Version = $release.tag_name
    } catch {
      Die "cannot determine the latest release of $Repo. Pass -Version <tag> to pin a release."
    }
  }
}

# -- where things are -------------------------------------------------------
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
# DSH Desktop serves its sessions from a profile of its own, and patching `web`
# instead would look successful and change nothing for that app.
if (-not $Profile) {
  $Profile = if (Test-Path (Join-Path $DshHome 'profiles\desktop')) { 'desktop' } else { 'web' }
}

Say 'unica for DeepSeek Harness - installer'
Say "  version : $Version"
Say "  profile : $Profile"
Say "  dsh home: $DshHome"

# -- download ---------------------------------------------------------------
$work = Join-Path ([IO.Path]::GetTempPath()) ("unica-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$base = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { "https://github.com/$Repo/releases/download/$Version" }
Say "  archive : $base/$Asset"

# TLS 1.2 is not the default on every Windows PowerShell in the wild, and the
# download then fails with an unhelpful error.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Test-UnicaPlugin([string]$Directory) {
  $package = Join-Path $Directory 'package.json'
  if (-not [IO.File]::Exists((Join-Path $Directory 'install.mjs')) -or -not [IO.File]::Exists($package)) { return $false }
  return (([IO.File]::ReadAllText($package) | ConvertFrom-Json).name -ceq 'dsh-plugin-unica')
}

$code = 1
$ownsTransaction = $false
$committed = $false
$publishing = $false
$restorePatch = $false
try {
  Invoke-WebRequest -Uri "$base/$Asset" -OutFile (Join-Path $work $Asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$Asset.sha256.json" -OutFile (Join-Path $work "$Asset.sha256.json") -UseBasicParsing
  $manifest = Get-Content -LiteralPath (Join-Path $work "$Asset.sha256.json") -Raw | ConvertFrom-Json
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead((Join-Path $work $Asset))
    try {
      $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
  if ($manifest.sha256 -ne $actual) { Die "checksum mismatch: expected $($manifest.sha256), got $actual." }
  Say "  sha256  : ok"

  $install = if ($env:UNICA_INSTALL_DIR) { $env:UNICA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'unica-plugin' }
  $install = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($install)
  $parent = [IO.Directory]::GetParent($install)
  if ($null -eq $parent) { Die 'the filesystem root cannot be an install directory.' }
  $install = $install.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $parent = [IO.Directory]::GetParent($install).FullName
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $tx = Join-Path $parent ('.' + [IO.Path]::GetFileName($install) + '.update')
  $stage = Join-Path $tx 'new'
  $backup = Join-Path $tx 'previous'
  $savedProfile = Join-Path $tx 'profile'
  $patch = Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'cordis.patch.yml'
  $patch = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($patch)
  # Directory.Move claims the shared name exclusively, even with simultaneous starts.
  $claim = Join-Path $parent ('.unica-claim-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($claim) | Out-Null
  try {
    [IO.Directory]::Move($claim, $tx)
    $ownsTransaction = $true
  } finally {
    if ([IO.Directory]::Exists($claim)) { [IO.Directory]::Delete($claim) }
  }
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  & tar -xzf (Join-Path $work $Asset) -C $stage
  if ($LASTEXITCODE -ne 0) { Die 'cannot unpack the archive.' }
  if (-not (Test-UnicaPlugin $stage)) { Die 'the archive does not contain the Unica plugin.' }

  if ([IO.File]::Exists($patch)) { [IO.File]::Copy($patch, $savedProfile) }
  if (Test-Path -LiteralPath $install) {
    $item = Get-Item -LiteralPath $install -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Die "choose an actual install directory: $install"
    }
    if ((Get-ChildItem -LiteralPath $install -Force | Select-Object -First 1) -and -not (Test-UnicaPlugin $install)) {
      Die "refusing to replace a directory that is not an Unica installation: $install"
    }
    [IO.Directory]::Move($install, $backup)
  }
  $publishing = $true
  [IO.Directory]::Move($stage, $install)
  $arguments = @('--target', $Target, '--profile', $Profile, '--dsh-home', $DshHome)
  if (-not $NoVerify) { $arguments += '--verify' }
  $restorePatch = $true
  & node (Join-Path $install 'install.mjs') @arguments
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    $committed = $true
    Say "  installed to: $install"
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  if ($ownsTransaction) {
    if (-not $committed) {
      try {
        if ($publishing -and -not [IO.Directory]::Exists($stage) -and [IO.Directory]::Exists($install)) {
          [IO.Directory]::Move($install, $stage)
        }
        if ([IO.Directory]::Exists($backup)) { [IO.Directory]::Move($backup, $install) }
        if ($restorePatch) {
          if ([IO.File]::Exists($savedProfile)) { [IO.File]::Copy($savedProfile, $patch, $true) }
          elseif ([IO.File]::Exists($patch)) { [IO.File]::Delete($patch) }
        }
      } catch {
        Die "rollback incomplete; recovery files retained at $tx. $($_.Exception.Message)"
      }
    }
    Remove-Item -LiteralPath $tx -Recurse -Force
  }
}

# No unconditional `exit` here. The documented entry point is `irm ... | iex`, and
# there `exit` ends the whole PowerShell session instead of returning to a prompt:
# the window then stays on screen, held by the unica daemon the self-test inherited
# it to, and looks hung after the install has already finished. When this file is
# run as a script (`powershell -File install.ps1 ...`) it is its own host, so the
# exit code still has to travel - $PSCommandPath is set only in that case.
$global:LASTEXITCODE = $code
if ($PSCommandPath) { exit $code }
