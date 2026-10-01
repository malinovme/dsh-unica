#!/bin/sh
# Installs the DSH port of unica on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/malinovme/dsh-unica/main/install.sh | sh
#
# This is a downloader, not the installer: it fetches the release archive,
# checks it against the published SHA-256, unpacks it and hands over to
# `install.mjs`, which owns every decision about profiles and cache paths. That
# keeps one implementation of the install logic, written once in Node.
#
# Environment overrides:
#   UNICA_VERSION=v0.12.3.3     release tag to install (default: the latest here)
#   UNICA_PROFILE=web           DSH profile to patch (default: desktop if the
#                               Desktop app has one, otherwise web)
#   UNICA_DSH_HOME=~/.dsh       DSH home; normally taken from the environment
#   UNICA_VERIFY=0              skip the MCP handshake check after installing
#   UNICA_TARGET=preset         preset | profile | both
set -eu

# Bumped by the release that publishes the archives this script downloads. A
# wrong tag fails loudly at the download, which is the right place to notice.
VERSION="${UNICA_VERSION:-v0.12.3.3}"
REPO="${UNICA_REPO:-malinovme/dsh-unica}"
ASSET="dsh-plugin-unica-full.tar.gz"
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
say "  version : $VERSION"
say "  profile : $PROFILE"
say "  dsh home: $DSH_HOME"

# ── download ────────────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required to download the archive."
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
INSTALL="${UNICA_INSTALL_DIR:-$HOME/.local/share/unica-plugin}"
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
tar -xzf "$WORK/$ASSET" -C "$INSTALL" || die "cannot unpack the archive."
[ -f "$INSTALL/install.mjs" ] || die "the archive does not contain install.mjs — it is not the plugin archive."
say "  installed to: $INSTALL"

# macOS quarantines anything a browser or curl wrote, and Gatekeeper then refuses
# to start the third-party bootstrap binary. Clearing the flag on this directory
# only is what makes the MCP server able to start at all.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$INSTALL" 2>/dev/null || true
  say "  quarantine: cleared (macOS)"
fi
# An archive built on Windows carries no executable bit, so the POSIX launch
# script and the macOS bootstrap need it added here.
chmod +x "$INSTALL/bootstrap/launch.sh" 2>/dev/null || true
[ -f "$INSTALL/bootstrap/bin/darwin-arm64/unica-bootstrap" ] && chmod +x "$INSTALL/bootstrap/bin/darwin-arm64/unica-bootstrap" 2>/dev/null || true

# ── install ─────────────────────────────────────────────────────────────────
say ""
set -- --target "$TARGET" --profile "$PROFILE" --dsh-home "$DSH_HOME"
[ "$VERIFY" = "1" ] && set -- "$@" --verify
node "$INSTALL/install.mjs" "$@"
