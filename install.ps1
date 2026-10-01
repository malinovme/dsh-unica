# Installs the DSH port of unica on Windows.
#
#   irm https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.ps1 | iex
#
# This is a downloader, not the installer: it fetches the release archive, checks
# it against the published SHA-256, unpacks it and hands over to `install.mjs`,
# which owns every decision about profiles and cache paths. That keeps one
# implementation of the install logic, written once in Node.
#
# The file is deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less
# script as ANSI, so a stray em dash in a comment breaks parsing on the very
# machines this script is for.
#
# Parameters:
#   -Version v0.12.3.3   release tag to install (default: the latest here)
#   -Profile web         DSH profile to patch (default: desktop if the Desktop
#                        app has one, otherwise web)
#   -DshHome C:\...\.dsh DSH home; normally taken from the environment
#   -NoVerify            skip the MCP handshake check after installing
#   -Target preset       preset | profile | both
[CmdletBinding()]
param(
  [string]$Version = 'v0.12.3.3',
  [string]$Profile,
  [string]$DshHome,
  [string]$Target = 'preset',
  [string]$Repo = 'malinovme/dsh-unica',
  # Overridable so the download can be exercised without the network.
  [string]$BaseUrl,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$Asset = 'dsh-plugin-unica-full.tar.gz'

function Say([string]$Message) { Write-Host $Message }
function Die([string]$Message) { Write-Error "unica installer: $Message"; exit 1 }

# -- prerequisites ----------------------------------------------------------
# Node is the one hard requirement, and DSH could not run without it either.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die 'Node.js is required (DSH itself needs it). Install it from https://nodejs.org and run this again.'
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Die 'tar is required to unpack the archive; Windows 10 1803 and newer ship it.'
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
try {
  Invoke-WebRequest -Uri "$base/$Asset" -OutFile (Join-Path $work $Asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$Asset.sha256.json" -OutFile (Join-Path $work "$Asset.sha256.json") -UseBasicParsing
} catch {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Die "cannot download from $base - check the version and that you have access to the repository (it is private). $($_.Exception.Message)"
}

# -- verify -----------------------------------------------------------------
# The manifest is the published one, so this proves the bytes arrived intact
# rather than merely that something downloaded.
$manifest = Get-Content (Join-Path $work "$Asset.sha256.json") -Raw | ConvertFrom-Json
$actual = (Get-FileHash (Join-Path $work $Asset) -Algorithm SHA256).Hash.ToLower()
if ($manifest.sha256 -ne $actual) {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Die "checksum mismatch: the archive is not the published one (expected $($manifest.sha256), got $actual)."
}
Say "  sha256  : ok"

# -- place the plugin -------------------------------------------------------
# The profile patch stores absolute paths, so the unpacked directory is what DSH
# will run: it has to outlive this script. Unpacking straight into the install
# directory and clearing it first also keeps a re-run from mixing two versions.
$install = if ($env:UNICA_INSTALL_DIR) { $env:UNICA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'unica-plugin' }
if (Test-Path $install) { Remove-Item -Recurse -Force $install }
New-Item -ItemType Directory -Force -Path $install | Out-Null
tar -xzf (Join-Path $work $Asset) -C $install
if (-not (Test-Path (Join-Path $install 'install.mjs'))) {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Die "the archive does not contain install.mjs - it is not the plugin archive."
}
Say "  installed to: $install"

# -- install ----------------------------------------------------------------
Say ''
$arguments = @('--target', $Target, '--profile', $Profile, '--dsh-home', $DshHome)
if (-not $NoVerify) { $arguments += '--verify' }
& node (Join-Path $install 'install.mjs') @arguments
$code = $LASTEXITCODE
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
exit $code
