#!/bin/sh
# Run against a real packaged plugin; the argument is the release mirror URL.
set -eu
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
target="$root/storage/deeper/dsh home"
mkdir -p "$target"
ln -s "$target" "$root/dsh"
export UNICA_BASE_URL="$1" UNICA_DSH_HOME="$root/dsh" UNICA_INSTALL_DIR="$root/plugin"
export UNICA_PROFILE=web UNICA_VERIFY=0 UNICA_TARGET=profile
sh install.sh
patch="$target/profiles/web/cordis.patch.yml"
grep -q 'id: unica-native' "$patch"
printf '\n- insert:\n    - id: user-settings\n      name: user-preferences\n' >> "$patch"
touch "$UNICA_INSTALL_DIR/old-install-only"
sh install.sh
test ! -e "$UNICA_INSTALL_DIR/old-install-only"
grep -q 'name: user-preferences' "$patch"
test "$(grep -c 'id: unica-native' "$patch")" -eq 1
test -z "$(find "$root" -name '.plugin.update' -o -name draft)"
