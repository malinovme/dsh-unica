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
#   -Version v0.15.0.7   release tag to install (default: the latest)
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

# -- where things are -------------------------------------------------------
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
# DSH Desktop serves its sessions from a profile of its own, and patching `web`
# instead would look successful and change nothing for that app.
if (-not $Profile) {
  $Profile = if (Test-Path (Join-Path $DshHome 'profiles\desktop')) { 'desktop' } else { 'web' }
}

Say 'unica for DeepSeek Harness - installer'
Say "  profile : $Profile"
Say "  dsh home: $DshHome"

# -- download ---------------------------------------------------------------
$work = Join-Path ([IO.Path]::GetTempPath()) ("unica-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
# TLS 1.2 is not the default on every Windows PowerShell in the wild, and the
# download then fails with an unhelpful error.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Test-UnicaPlugin([string]$Directory) {
  $package = Join-Path $Directory 'package.json'
  if (-not [IO.File]::Exists((Join-Path $Directory 'install.mjs')) -or -not [IO.File]::Exists($package)) { return $false }
  return (([IO.File]::ReadAllText($package) | ConvertFrom-Json).name -ceq 'dsh-plugin-unica')
}

$publishScript = @'
const fs = require('node:fs'), path = require('node:path')
let [source, target, baseline] = process.argv.slice(1)
while (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
  target = path.resolve(path.dirname(target), fs.readlinkSync(target))
fs.mkdirSync(path.dirname(target), { recursive: true })
// The symlink target may live on a different filesystem.
const tmp = path.join(path.dirname(target), '.unica-' + require('node:crypto').randomUUID())
try {
  fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL)
  const read = p => fs.existsSync(p) ? fs.readFileSync(p) : null
  const original = read(baseline), live = read(target)
  if (live === null ? original === null : original !== null && live.equals(original)) {
    fs.renameSync(tmp, target)
  } else {
    console.error('keeping changed profile: ' + target)
  }
} finally { fs.rmSync(tmp, { force: true }) }
'@
$probeScript = @'
const net = require('node:net')
const name = 'unica-' + process.argv[1]
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '/tmp/' + name
const socket = net.connect(endpoint)
socket.on('connect', () => { socket.destroy(); process.exitCode = 2 })
socket.on('error', err => { if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) throw err })
'@
$code = 1
$ownsTransaction = $false
$updateLock = $null
function Restore-Transaction([string]$ProfilePath) {
  if (-not [IO.File]::Exists((Join-Path $tx 'prepared'))) { return }
  $candidatePublished = -not [IO.Directory]::Exists($stage) -and [IO.Directory]::Exists($install)
  if ($candidatePublished -and -not [IO.File]::Exists((Join-Path $tx 'journal-v2')) -and
      [IO.File]::Exists($savedProfile) -and -not (Test-OriginalProfile $ProfilePath)) {
    $dir = Join-Path $parent ('.unica-profile-backup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    [IO.File]::Copy($savedProfile, (Join-Path $dir 'cordis.patch.yml'))
    Say "  keeping current profile; previous profile saved to $dir"
  }
  if ($candidatePublished) {
    [IO.Directory]::Move($install, $stage)
  }
  if ([IO.Directory]::Exists($backup)) { [IO.Directory]::Move($backup, $install) }
}

function Get-UnicaSha256([string]$Path) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try {
      return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
}

function Test-OriginalProfile([string]$ProfilePath) {
  if (-not [IO.File]::Exists($savedProfile)) { return -not [IO.File]::Exists($ProfilePath) }
  if (-not [IO.File]::Exists($ProfilePath)) { return $false }
  return (Get-UnicaSha256 $savedProfile) -eq (Get-UnicaSha256 $ProfilePath)
}

function Get-DraftDirectory([string]$ProfilePath) {
  $name = [IO.File]::ReadAllText((Join-Path $tx 'draft-name'))
  if ($name -notmatch '^\.unica-profile-[0-9a-f]{32}$') { Die "invalid draft name at $tx" }
  return Join-Path ([IO.Path]::GetDirectoryName($ProfilePath)) $name
}
function Publish-Profile([string]$ProfilePath) {
  $draft = Join-Path (Get-DraftDirectory $ProfilePath) 'cordis.patch.yml'
  & node -e $publishScript -- $draft $ProfilePath $savedProfile
  if ($LASTEXITCODE -ne 0) { Die "could not publish profile at $ProfilePath" }
}

function Remove-FinishedTransaction {
  if ([IO.File]::Exists((Join-Path $tx 'draft-name'))) {
    $dir = Get-DraftDirectory ([IO.File]::ReadAllText((Join-Path $tx 'journal-v2')))
    if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir, $true) }
  }
  # Once committed, the previous plugin is disposable. Windows can refuse to
  # rename a directory containing an open descendant. Drain the backup first,
  # keeping the committed marker in place if deletion is interrupted.
  if ([IO.File]::Exists((Join-Path $tx 'committed')) -and [IO.Directory]::Exists($backup)) {
    & node -e "require('node:fs').rmSync(process.argv[1], {recursive: true, force: true, maxRetries: 8, retryDelay: 150})" -- $backup
    if ($LASTEXITCODE -ne 0) { Die "could not remove previous plugin at $backup" }
  }
  $retired = Join-Path $parent ('.unica-finished-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::Move($tx, $retired)
  Remove-Item -LiteralPath $retired -Recurse -Force
}
try {
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
  # Hold an OS lock for recovery as well as installation. Leave the lock file
  # in place; the handle is released by Windows even on forced termination.
  try {
    $updateLock = [IO.File]::Open("$tx.lock", 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [IO.IOException] { Die "another updater holds $tx.lock, or the lock file is inaccessible" }
  $journal = Join-Path $tx 'journal-v2'
  if (-not [IO.File]::Exists($journal)) { $journal = Join-Path $tx 'journal-v1' }
  if ([IO.Directory]::Exists($tx)) {
    if (((Get-Item -LiteralPath $tx -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        -not [IO.File]::Exists($journal)) { Die "unrecognized or active update at $tx; see README: recovery" }
    if (-not [IO.File]::Exists((Join-Path $tx 'committed'))) {
      $oldPatch = [IO.File]::ReadAllText($journal)
      if (-not [IO.Path]::IsPathRooted($oldPatch) -or [IO.Path]::GetFileName($oldPatch) -ne 'cordis.patch.yml') {
        Die "invalid profile path in $tx"
      }
      # A killed PowerShell host can leave install.mjs running. Revoke its
      # unique ticket first, then probe the socket held by that exact child.
      Get-ChildItem -LiteralPath $tx -Filter '*.ticket' | Remove-Item -Force
      foreach ($guardFile in (Get-ChildItem -LiteralPath $tx -Filter '*.ticket.mjs')) {
        & node -e $probeScript -- $guardFile.BaseName
        if ($LASTEXITCODE -eq 2) { Die 'installer child is still active' }
        if ($LASTEXITCODE -ne 0) { Die 'could not check installer child' }
      }
      # Older journals registered only a PID. A later start time proves reuse.
      foreach ($pidFile in (Get-ChildItem -LiteralPath $tx -Filter '*.pid')) {
        $childId = [int][IO.File]::ReadAllText($pidFile.FullName)
        $running = Get-Process -Id $childId -ErrorAction SilentlyContinue
        if ($running -and (-not $running.StartTime -or $running.StartTime.ToUniversalTime() -le $pidFile.LastWriteTimeUtc)) {
          Die "installer child $childId is still active"
        }
      }
      if ([IO.File]::Exists((Join-Path $tx 'publishing-profile'))) { Publish-Profile $oldPatch }
      else { Restore-Transaction $oldPatch }
    }
    Remove-FinishedTransaction
    Say '  recovered interrupted update'
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

  Say "  version : $Version"
  $base = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { "https://github.com/$Repo/releases/download/$Version" }
  Say "  archive : $base/$Asset"

  Invoke-WebRequest -Uri "$base/$Asset" -OutFile (Join-Path $work $Asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$Asset.sha256.json" -OutFile (Join-Path $work "$Asset.sha256.json") -UseBasicParsing
  $manifest = Get-Content -LiteralPath (Join-Path $work "$Asset.sha256.json") -Raw | ConvertFrom-Json
  $actual = Get-UnicaSha256 (Join-Path $work $Asset)
  if ($manifest.sha256 -ne $actual) { Die "checksum mismatch: expected $($manifest.sha256), got $actual." }
  Say "  sha256  : ok"

  # Directory.Move claims the shared name exclusively, even with simultaneous starts.
  $claim = Join-Path $parent ('.unica-claim-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($claim) | Out-Null
  try {
    [IO.File]::WriteAllText((Join-Path $claim 'journal-v2'), $patch)
    [IO.Directory]::Move($claim, $tx)
    $ownsTransaction = $true
  } finally {
    if ([IO.Directory]::Exists($claim)) { [IO.Directory]::Delete($claim, $true) }
  }
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  & tar -xzf (Join-Path $work $Asset) -C $stage
  if ($LASTEXITCODE -ne 0) { Die 'cannot unpack the archive.' }
  if (-not (Test-UnicaPlugin $stage)) { Die 'the archive does not contain the Unica plugin.' }

  $draftName = '.unica-profile-' + [guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText((Join-Path $tx 'draft-name'), $draftName)
  $draftDir = Get-DraftDirectory $patch
  [IO.Directory]::CreateDirectory($draftDir) | Out-Null
  $draft = Join-Path $draftDir 'cordis.patch.yml'
  $draftProfile = Join-Path $Profile $draftName
  if ([IO.File]::Exists($patch)) {
    [IO.File]::Copy($patch, $savedProfile)
    [IO.File]::Copy($savedProfile, $draft)
  }
  if (Test-Path -LiteralPath $install) {
    $item = Get-Item -LiteralPath $install -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Die "choose an actual install directory: $install"
    }
    if ((Get-ChildItem -LiteralPath $install -Force | Select-Object -First 1) -and -not (Test-UnicaPlugin $install)) {
      Die "refusing to replace a directory that is not an Unica installation: $install"
    }
  }
  [IO.File]::WriteAllText((Join-Path $tx 'prepared'), '')
  if ([IO.Directory]::Exists($install)) { [IO.Directory]::Move($install, $backup) }
  [IO.Directory]::Move($stage, $install)
  $arguments = @('--target', $Target, '--profile', $draftProfile, '--dsh-home', $DshHome)
  if (-not $NoVerify) { $arguments += '--verify' }
  $ticket = Join-Path $tx ([guid]::NewGuid().ToString('N') + '.ticket')
  [IO.File]::WriteAllText($ticket, '')
  # The socket lives exactly as long as this Node process. Register before
  # checking admission, so revoking a ticket also covers a delayed startup.
  $guard = "$ticket.mjs"
  [IO.File]::WriteAllText($guard, @'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const ticket = fileURLToPath(import.meta.url).slice(0, -4)
const name = 'unica-' + basename(ticket)
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '/tmp/' + name
const server = createServer(socket => socket.end())
await new Promise((resolve, reject) => server.once('error', reject).listen(endpoint, resolve))
if (!existsSync(ticket)) process.exit(1)
server.unref()
'@)
  # --import takes a URL. A native Windows path is not a valid ESM specifier.
  $guardUrl = ([uri]::new($guard)).AbsoluteUri
  & node --import $guardUrl (Join-Path $install 'install.mjs') @arguments
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    if (-not [IO.File]::Exists($draft)) { Die 'installer did not prepare a profile' }
    if (-not (Test-OriginalProfile $patch)) { Die "profile changed during update: $patch" }
    [IO.File]::WriteAllText((Join-Path $tx 'publishing-profile'), '')
    Publish-Profile $patch
    [IO.File]::WriteAllText((Join-Path $tx 'committed'), '')
    Say "  installed to: $install"
  }
} finally {
  try {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    if ($ownsTransaction -and (-not [IO.File]::Exists((Join-Path $tx 'publishing-profile')) -or
        [IO.File]::Exists((Join-Path $tx 'committed')))) {
      if (-not [IO.File]::Exists((Join-Path $tx 'committed'))) {
        try { Restore-Transaction $patch }
        catch { Die "rollback incomplete; recovery files retained at ${tx}: $($_.Exception.Message)" }
      }
      Remove-FinishedTransaction
    }
  } finally {
    if ($null -ne $updateLock) { $updateLock.Dispose() }
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
