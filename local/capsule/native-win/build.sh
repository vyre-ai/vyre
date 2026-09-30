#!/bin/sh
# Build/test the Windows Capsule shell. Unlike native/build.sh (Swift, macOS only), the hotkey
# module here has no Win32 dependency, so `test` runs on any platform with a Rust toolchain; only
# a real Tauri app build (not scaffolded yet, see docs/design/windows-plan.md section 9) would
# need to run on win32 specifically.
#
#   build.sh test [filter]   cargo test, optionally filtered
#   build.sh app             not yet: the full Tauri panel is future work
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-test}"
command -v cargo >/dev/null 2>&1 || { echo "cargo not found. Install Rust: https://rustup.rs" >&2; exit 1; }

case "$mode" in
  test)
    shift || true
    # No Cargo.lock committed yet (no Rust toolchain was available to generate one writing this;
    # CI resolves and locks on its own first run). Once one exists, add --locked here.
    cd "$here" && cargo test ${1:+"$1"}
    ;;
  app)
    echo "the Tauri app shell is not scaffolded yet; see docs/design/windows-plan.md section 9" >&2
    exit 1
    ;;
  *)
    echo "usage: build.sh [test|app]" >&2
    exit 1
    ;;
esac
