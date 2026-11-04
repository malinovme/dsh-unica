#!/bin/sh
# Installs the DSH port of unica on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | sh
#   gh api -H "Accept: application/vnd.github.raw+json" repos/malinovme/dsh-unica/contents/install.sh | sh
#
# This is a downloader, not the installer: it fetches the release archive, checks
# it against the published SHA-256, unpacks it and hands over to `install.mjs`,
# which owns every decision about profiles and cache paths. That keeps one
# implementation of the install logic, written once in Node.
#
# Environment overrides:
#   UNICA_VERSION=v0.13.0       release tag to install (default: the latest)
#   UNICA_PROFILE=web           DSH profile to patch (default: desktop if the
#                               Desktop app has one, otherwise web)
#   UNICA_DSH_HOME=~/.dsh       DSH home; normally taken from the environment
#   UNICA_VERIFY=0              skip the MCP handshake check after installing
#   UNICA_TARGET=preset         preset | profile | both
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
USE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
  USE_GH=1
fi
# The latest release is asked for rather than hard-coded: a version written into
# this script goes stale silently, and the failure would surface as a download
# error on a tag that used to exist. A pinned UNICA_VERSION skips the lookup,
# which is also what makes this work offline against a mirror.
if [ -n "${UNICA_VERSION:-}" ]; then
  VERSION="$UNICA_VERSION"
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
[ -n "${VERSION:-}" ] || die "cannot determine the latest release of $REPO. Pass UNICA_VERSION=<tag> (the repository is private, so an unauthenticated lookup cannot see its releases)."

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
trap cleanup EXIT INT TERM

BASE="https://github.com/$REPO/releases/download/$VERSION"
say "  archive : $BASE/$ASSET"
fetch "$BASE/$ASSET" "$WORK/$ASSET" || die "cannot download $BASE/$ASSET — check the version and that you have access to the repository (it is private)."
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

# ── place the plugin ────────────────────────────────────────────────────────
# The profile patch stores absolute paths, so this directory is what DSH will
# run and it has to outlive the script. Unpacking straight into it, after
# clearing it, also keeps a re-run from mixing two versions.
#
# Nothing here needs an execute bit: the port ships no binaries, and the one file
# DSH starts — bootstrap/launch.mjs — is invoked through `node`. It fetches the
# runtime itself on first use.
INSTALL="${UNICA_INSTALL_DIR:-$HOME/.local/share/unica-plugin}"
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
tar -xzf "$WORK/$ASSET" -C "$INSTALL" || die "cannot unpack the archive."
[ -f "$INSTALL/install.mjs" ] || die "the archive does not contain install.mjs — it is not the plugin archive."
# Older releases were packaged on Windows with CRLF in the POSIX launcher.
# Normalize only this text file, after verifying the original archive bytes.
node -e '
const fs = require("node:fs")
const file = process.argv[1]
const text = fs.readFileSync(file, "utf8")
fs.writeFileSync(file, text.replace(/\r\n/g, "\n"))
' "$INSTALL/bootstrap/launch.sh" || die "cannot normalize the POSIX launcher."
say "  installed to: $INSTALL"

# ── install ─────────────────────────────────────────────────────────────────
say ""
set -- --target "$TARGET" --profile "$PROFILE" --dsh-home "$DSH_HOME"
[ "$VERIFY" = "1" ] && set -- "$@" --verify
node "$INSTALL/install.mjs" "$@"
