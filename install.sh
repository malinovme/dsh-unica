#!/bin/sh
# Installs the DSH port of unica on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | UNICA_VERSION=vX.Y.Z.N sh
#
# This is a downloader, not the installer: it fetches the release archive, checks
# it against the published SHA-256, unpacks it and hands over to `install.mjs`,
# which owns every decision about profiles and cache paths. That keeps one
# implementation of the install logic, written once in Node.
#
# Environment overrides:
#   UNICA_VERSION=vX.Y.Z.N    release tag to install (default: the latest)
#   UNICA_PROFILE=web           DSH profile to patch (default: desktop if the
#                               Desktop app has one, otherwise web)
#   UNICA_DSH_HOME=~/.dsh       DSH home; normally taken from the environment
#   UNICA_VERIFY=0              skip the native self-test after installing
#   UNICA_TARGET=preset         preset | profile | both
#   UNICA_BASE_URL=http://...   release download base: a mirror, or a local
#                               directory served for the tests; matches the
#                               -BaseUrl parameter of install.ps1
set -eu

REPO="${UNICA_REPO:-malinovme/dsh-unica}"
ASSET="dsh-plugin-unica.tar.gz"
DSH_HOME="${UNICA_DSH_HOME:-${DSH_HOME:-$HOME/.dsh}}"
VERIFY="${UNICA_VERIFY:-1}"
TARGET="${UNICA_TARGET:-preset}"

say() { printf '%s\n' "$*"; }
die() { printf 'unica installer: %s\n' "$*" >&2; exit 1; }

# ── prerequisites ───────────────────────────────────────────────────────────
# Node is the one hard requirement, and DSH could not run without it either.
command -v node >/dev/null 2>&1 || die "Node.js is required (DSH itself needs it). Install it from https://nodejs.org and run this again."
command -v tar >/dev/null 2>&1 || die "tar is required to unpack the archive."

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "this script handles macOS and Linux; on Windows use install.ps1" ;;
esac

# ── which profile ───────────────────────────────────────────────────────────
# DSH Desktop serves its sessions from a profile of its own, and patching `web`
# instead would look successful and change nothing for that app.
if [ -n "${UNICA_PROFILE:-}" ]; then
  PROFILE="$UNICA_PROFILE"
elif [ -d "$DSH_HOME/profiles/desktop" ]; then
  PROFILE="desktop"
else
  PROFILE="web"
fi

say "unica for DeepSeek Harness — installer"
say "  profile : $PROFILE"
say "  dsh home: $DSH_HOME"

# Keep staging and backup on the destination filesystem so that each move is
# a rename. The fixed transaction directory also excludes competing updaters.
INSTALL="$(node -p 'require("node:path").resolve(process.argv[1])' -- "${UNICA_INSTALL_DIR:-$HOME/.local/share/unica-plugin}")"
PARENT="$(dirname "$INSTALL")"
[ "$INSTALL" != "$PARENT" ] || die "the filesystem root cannot be an install directory."
mkdir -p "$PARENT"
TX="$PARENT/.$(basename "$INSTALL").update"
# Keep a kernel lock separate from the journal. Closing the last inherited
# descriptor (including an install.mjs orphan) releases it after a hard stop.
# Never unlink the lock file: contenders must all lock the same inode.
LOCK="$TX.lock"
exec 9>>"$LOCK"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || die "another updater holds $LOCK"
elif command -v perl >/dev/null 2>&1; then
  perl -MFcntl=:flock -e 'open my $lock, ">&=9" or die $!; flock($lock, LOCK_EX | LOCK_NB) or exit 1' || die "another updater holds $LOCK"
else
  die "flock or Perl is required to lock an update"
fi
STAGE="$TX/new"
BACKUP="$TX/previous"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
PATCH="$(node -p 'require("node:path").resolve(process.argv[1])' -- "$PATCH")"
# Atomically detach a completed transaction before deleting its journal.
retire_tx() {
  if [ -L "$TX" ]; then
    claim="$(readlink "$TX")" || return 1
    rm "$TX" || return 1
    rm -rf "$PARENT/$claim"
    return
  fi
  retired="$(mktemp -d "$PARENT/.unica-finished.XXXXXX")" || return 1
  mv "$TX" "$retired/transaction" || return 1
  rm -rf "$retired"
}

rollback() {
  # The snapshot and original profile path are complete before 'prepared'.
  [ -f "$TX/prepared" ] || return 0
  if [ ! -f "$TX/journal-v2" ] && [ ! -d "$STAGE" ] && [ -f "$TX/profile" ]; then
    # v1 recorded no fingerprint of installed settings. Preserve both versions
    # if the live bytes differ; recovery can be repeated after another crash.
    if ! cmp -s "$TX/profile" "$PATCH"; then
      saved="$(mktemp -d "$PARENT/.unica-profile-backup.XXXXXXXX")" || return 1
      cp -p "$TX/profile" "$saved/cordis.patch.yml" || return 1
      say "  keeping current profile; previous profile saved to $saved/cordis.patch.yml"
    fi
  fi
  if [ ! -d "$STAGE" ] && [ -d "$INSTALL" ]; then
    mv "$INSTALL" "$STAGE" || return 1
  fi
  if [ -d "$BACKUP" ]; then
    [ ! -e "$INSTALL" ] || return 1
    mv "$BACKUP" "$INSTALL" || return 1
  fi
}

publish_profile() {
  draft="$TX/draft/cordis.patch.yml"
  if node -e '
    const fs = require("node:fs"), path = require("node:path")
    let published = false
    function publish() {
      let [source, target, baseline] = process.argv.slice(1)
      while (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
        target = path.resolve(path.dirname(target), fs.readlinkSync(target))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // The symlink target may live on a different filesystem.
      const tmp = path.join(path.dirname(target), ".unica-" + require("node:crypto").randomUUID())
      try {
        fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL)
        function readOptional(file) {
          try { return fs.readFileSync(file) }
          catch (error) { if (error.code === "ENOENT") return null; throw error }
        }
        const draft = fs.readFileSync(tmp), original = readOptional(baseline), live = readOptional(target)
        if (!live?.equals(draft)) {
          if (live === null ? original === null : original !== null && live.equals(original)) {
            fs.renameSync(tmp, target)
          } else {
            process.exitCode = 3 // A user edit requires rollback.
            return
          }
        }
        published = true
      } finally { fs.rmSync(tmp, { force: true }) }
    }
    try { publish() } catch (error) {
      console.error(error)
      process.exitCode = published ? 1 : 4
    }
  ' -- "$draft" "$PATCH" "$TX/profile"; then
    : > "$TX/committed"
    return
  else
    publication_status=$?
  fi
  # During recovery the previous publisher may already have replaced the profile.
  case "$publication_status:$1" in
    3:*|4:install) ;;
    *) die "could not publish profile at $PATCH" ;;
  esac
  # Revoke publication intent before rollback, so another interruption is replayable.
  rm "$TX/publishing-profile"
  if [ "$1" = recover ]; then
    # Normal installation already has an EXIT trap to roll back and retire.
    rollback || die "rollback incomplete; recovery files retained at $TX"
    retire_tx || die "could not retire transaction at $TX"
  fi
  [ "$publication_status" -ne 3 ] || die "profile changed during update: $PATCH"
  die "could not publish profile at $PATCH"
}

if [ -e "$TX" ] || [ -L "$TX" ]; then
  if [ -L "$TX" ]; then
    claim="$(readlink "$TX")"
    case "$claim" in */*|.unica-claim.) die "invalid claim at $TX";; .unica-claim.*) ;; *) die "invalid claim at $TX";; esac
    [ ! -L "$PARENT/$claim" ] && [ -f "$TX/journal-v2" ] || die "invalid claim at $TX"
  fi
  journal="$TX/journal-v2"
  [ -f "$journal" ] || journal="$TX/journal-v1"
  [ -d "$TX" ] && [ -f "$journal" ] ||
    die "unrecognized or active update at $TX; see README: recovery"
  if [ ! -f "$TX/committed" ]; then
    requested_patch=$PATCH
    PATCH="$(cat "$journal")"
    case "$PATCH" in /*/cordis.patch.yml) ;; *) die "invalid profile path in $TX";; esac
    if [ -f "$TX/publishing-profile" ]; then
      publish_profile recover
    else
      rollback || die "rollback incomplete; recovery files retained at $TX"
    fi
    PATCH=$requested_patch
  fi
  retire_tx || die "could not retire transaction at $TX"
  say "  recovered interrupted update"
fi
# ── which release ───────────────────────────────────────────────────────────
# A local mirror answers by URL, so it rules out `gh release download` and the
# latest-release lookup: the version is only a label then.
USE_GH=0
if [ -z "${UNICA_BASE_URL:-}" ] && command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
  USE_GH=1
fi
# The latest release is asked for rather than hard-coded: a version written into
# this script goes stale silently, and the failure would surface as a download
# error on a tag that used to exist. A pinned UNICA_VERSION skips the lookup,
# which is also what makes this work offline against a mirror.
if [ -n "${UNICA_VERSION:-}" ]; then
  VERSION="$UNICA_VERSION"
elif [ -n "${UNICA_BASE_URL:-}" ]; then
  VERSION="local"
elif [ "$USE_GH" = "1" ]; then
  VERSION="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
fi
if [ -z "${VERSION:-}" ]; then
  VERSION="$(node -e '
const url = `https://api.github.com/repos/${process.argv[1]}/releases/latest`
fetch(url, { headers: { accept: "application/vnd.github+json" } })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((j) => process.stdout.write(j.tag_name))
  .catch(() => process.exit(1))
' "$REPO" 2>/dev/null || true)"
fi
[ -n "${VERSION:-}" ] || die "cannot determine the latest release of $REPO. Pass UNICA_VERSION=<tag> to pin a release."

say "  version : $VERSION"
# ── download ────────────────────────────────────────────────────────────────
if [ "$USE_GH" = "1" ]; then
  fetch() { gh release download "$VERSION" --repo "$REPO" --pattern "${1##*/}" --dir "$WORK"; }
elif command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "authenticated GitHub CLI (gh), curl or wget is required to download the archive."
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/unica-install.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# `UNICA_BASE_URL` names a mirror (or the local directory the tests serve); a
# release tag has no meaning there, so the base is used verbatim.
BASE="${UNICA_BASE_URL:-https://github.com/$REPO/releases/download/$VERSION}"
say "  archive : $BASE/$ASSET"
fetch "$BASE/$ASSET" "$WORK/$ASSET" || die "cannot download $BASE/$ASSET — check the version and that the release is published."
fetch "$BASE/$ASSET.sha256.json" "$WORK/$ASSET.sha256.json" || die "cannot download the checksum manifest."

# ── verify ──────────────────────────────────────────────────────────────────
# The manifest is the published one, so this proves the bytes arrived intact
# rather than merely that something downloaded.
EXPECTED="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.sha256)' "$WORK/$ASSET.sha256.json")" || die "cannot read the checksum manifest."
ACTUAL="$(node -e '
const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))
' "$WORK/$ASSET")" || die "cannot hash the archive."
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch: the archive is not the published one (expected $EXPECTED, got $ACTUAL)."
say "  sha256  : ok"

# Publish a complete journal with an exclusive symlink. symlinkSync fails if
# even an empty directory was claimed by an older mkdir-based installer.
claim="$(mktemp -d "$PARENT/.unica-claim.XXXXXXXX")"
printf '%s' "$PATCH" > "$claim/journal-v2"
if ! node -e 'require("node:fs").symlinkSync(process.argv[1], process.argv[2])' -- "$(basename "$claim")" "$TX"; then
  rm -rf "$claim"
  die "cannot claim transaction at $TX"
fi

finish() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ -f "$TX/publishing-profile" ] && [ ! -f "$TX/committed" ]; then
    : # Keep the journal for a retry if publication failed.
  elif [ -f "$TX/committed" ] || rollback; then
    retire_tx || status=1
  else
    echo "unica installer: rollback incomplete; recovery files retained at $TX" >&2
    status=1
  fi
  cleanup
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP

mkdir "$STAGE"
tar -xzf "$WORK/$ASSET" -C "$STAGE" || die "cannot unpack the archive."
is_plugin() {
  [ -f "$1/install.mjs" ] && [ -f "$1/package.json" ] && node -e '
    const fs = require("node:fs")
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.exitCode = pkg.name === "dsh-plugin-unica" ? 0 : 1
  ' "$1/package.json"
}
is_plugin "$STAGE" || die "the archive does not contain the Unica plugin."
# Repair the CRLF launcher shipped with older releases before publishing them.
if [ -f "$STAGE/bootstrap/launch.sh" ]; then
  node -e '
const fs = require("node:fs")
const file = process.argv[1]
fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
' "$STAGE/bootstrap/launch.sh" || die "cannot normalize the POSIX launcher."
fi

# Keep the actual DSH home (and runtime cache); only the profile argument is
# redirected. The final config contains the installed plugin and cache paths.
draft_dir="$TX/draft"
mkdir "$draft_dir"
draft="$draft_dir/cordis.patch.yml"
draft_profile="$(node -e '
  const { realpathSync } = require("node:fs")
  const { basename, dirname, join, relative, resolve } = require("node:path")
  // install.mjs resolves existing ancestors of DSH_HOME even on first install.
  function physicalHome(path) {
    try { return realpathSync.native(path) }
    catch (error) {
      if (error.code !== "ENOENT") throw error
      return join(physicalHome(dirname(path)), basename(path))
    }
  }
  const home = physicalHome(resolve(process.argv[1]))
  process.stdout.write(relative(join(home, "profiles"), realpathSync.native(process.argv[2])))
' -- "$DSH_HOME" "$draft_dir")"
if [ -f "$PATCH" ]; then
  cp -p "$PATCH" "$TX/profile"
  cp -p "$TX/profile" "$draft"
fi
if [ -L "$INSTALL" ]; then die "choose the actual install directory instead of a symbolic link: $INSTALL"; fi
if [ -e "$INSTALL" ]; then
  [ -d "$INSTALL" ] || die "not an install directory: $INSTALL"
  contents="$(ls -A "$INSTALL")"
  if [ -n "$contents" ]; then
    is_plugin "$INSTALL" || die "refusing to replace a directory that is not an Unica installation: $INSTALL"
  fi
fi
: > "$TX/prepared"
if [ -d "$INSTALL" ]; then mv "$INSTALL" "$BACKUP"; fi

# install.mjs writes absolute paths, so run it from its final location.
mv "$STAGE" "$INSTALL"
set -- --target "$TARGET" --profile "$draft_profile" --dsh-home "$DSH_HOME"
[ "$VERIFY" = "1" ] && set -- "$@" --verify
node "$INSTALL/install.mjs" "$@"
[ -f "$draft" ] || die "installer did not prepare a profile"
# Record intent before publishing. A retry also recognizes a completed rename.
: > "$TX/publishing-profile"
publish_profile install
say "  installed to: $INSTALL"
