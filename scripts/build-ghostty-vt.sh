#!/usr/bin/env bash
#
# Builds the terminal kernel of the client: the VT of Ghostty, compiled to
# WebAssembly.
#
# The result is kept in the repository, so this script only has to run when
# the kernel is built again, for example to move to a newer Ghostty.
#
# It needs Zig (0.17 or newer) and the optimizer of binaryen:
#
#   brew install zig binaryen
#
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${TMPDIR:-/tmp}/ghostty-vt-build"
version="${GHOSTTY_VERSION:-v1.4.0}"

echo "fetching ghostty $version"
rm -rf "$work"
git clone --quiet --depth 1 --branch "$version" \
  https://github.com/ghostty-org/ghostty.git "$work"

echo "building the kernel"
cd "$work"
# Only the render state is kept: the client reads the screen of the pane
# through it and nothing else. The other features of the library would only
# make the module bigger.
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall \
  -Dvt-features=-all,+render-state

echo "optimizing the module"
wasm-opt -Oz --strip-debug --strip-producers \
  --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext \
  --enable-mutable-globals --enable-nontrapping-float-to-int --enable-simd \
  "$work/zig-out/bin/ghostty-vt.wasm" -o "$work/ghostty-vt.wasm"

echo "installing the kernel"
mkdir -p "$root/web/vendor/ghostty"
cp "$work/ghostty-vt.wasm" "$root/web/vendor/ghostty/ghostty-vt.wasm"
cp "$work/LICENSE" "$root/web/vendor/ghostty/LICENSE"

echo "done: web/vendor/ghostty/ghostty-vt.wasm"
ls -l "$root/web/vendor/ghostty/ghostty-vt.wasm"
