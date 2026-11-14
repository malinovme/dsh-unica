#!/bin/sh
# Installs the DSH port of unica on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | UNICA_VERSION=v0.15.0.3 sh
#
# This is a downloader, not the installer: it fetches the release archive, checks
# it against the published SHA-256, unpacks it and hands over to `install.mjs`,
# which owns every decision about profiles and cache paths. That keeps one
# implementation of the install logic, written once in Node.
#
# Environment overrides:
#   UNICA_VERSION=v0.15.0.3    release tag to install (default: the latest)
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
say "  version : $VERSION"
say "  profile : $PROFILE"
say "  dsh home: $DSH_HOME"

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

# Keep staging and backup on the destination filesystem so that each move is
# a rename. The fixed transaction directory also excludes competing updaters.
INSTALL="$(node -p 'require("node:path").resolve(process.argv[1])' -- "${UNICA_INSTALL_DIR:-$HOME/.local/share/unica-plugin}")"
PARENT="$(dirname "$INSTALL")"
[ "$INSTALL" != "$PARENT" ] || die "the filesystem root cannot be an install directory."
mkdir -p "$PARENT"
TX="$PARENT/.$(basename "$INSTALL").update"
(umask 077 && mkdir "$TX") || die "update directory already exists or cannot be created: $TX (check for an unfinished update)."
STAGE="$TX/new"
BACKUP="$TX/previous"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
RESTORE_PATCH=0
PUBLISHING=0
COMMITTED=0

rollback() {
  # If the second rename failed, the candidate is still under new/.
  if [ "$PUBLISHING" = 1 ] && [ ! -d "$STAGE" ] && [ -d "$INSTALL" ]; then
    mv "$INSTALL" "$STAGE" || return 1
  fi
  if [ -d "$BACKUP" ]; then mv "$BACKUP" "$INSTALL" || return 1; fi
  if [ "$RESTORE_PATCH" = 1 ]; then
    if [ -f "$TX/profile" ]; then
      cp -p "$TX/profile" "$PATCH" || return 1
    elif [ -e "$PATCH" ]; then
      rm -f "$PATCH" || return 1
    fi
  fi
}

finish() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$COMMITTED" = 1 ] || rollback; then
    rm -rf "$TX"
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

if [ -f "$PATCH" ]; then cp -p "$PATCH" "$TX/profile"; fi
if [ -L "$INSTALL" ]; then die "choose the actual install directory instead of a symbolic link: $INSTALL"; fi
if [ -e "$INSTALL" ]; then
  [ -d "$INSTALL" ] || die "not an install directory: $INSTALL"
  contents="$(ls -A "$INSTALL")"
  if [ -n "$contents" ]; then
    is_plugin "$INSTALL" || die "refusing to replace a directory that is not an Unica installation: $INSTALL"
  fi
  mv "$INSTALL" "$BACKUP"
fi

# install.mjs writes absolute paths, so run it from its final location.
PUBLISHING=1
mv "$STAGE" "$INSTALL"
set -- --target "$TARGET" --profile "$PROFILE" --dsh-home "$DSH_HOME"
[ "$VERIFY" = "1" ] && set -- "$@" --verify
RESTORE_PATCH=1
node "$INSTALL/install.mjs" "$@"
COMMITTED=1
say "  installed to: $INSTALL"
