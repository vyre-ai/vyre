#!/usr/bin/env bash
# macOS only, runner only. Prints CASE lines for the Keychain access-control idea (k1 another program, k2 the named program, k3 the security CLI).
set -u
[ "$(uname)" = Darwin ] || { echo "CASE k-keychain skip macOS only"; exit 0; }
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); KC=$T/probe.keychain-db
swiftc -O "$HERE/kc.swift" -o "$T/vyre-like" 2>"$T/swiftc.log" && cp "$T/vyre-like" "$T/other" || { echo "CASE k1-keychain-other-binary error swiftc: $(tail -2 "$T/swiftc.log" | tr '\n' ' ')"; exit 0; }
codesign -s - -f "$T/vyre-like" >/dev/null 2>&1; codesign -s - -f -i other.probe "$T/other" >/dev/null 2>&1
security create-keychain -p pw "$KC" && security unlock-keychain -p pw "$KC" && security set-keychain-settings "$KC"
OLD=$(security list-keychains -d user | tr -d '"' | tr '\n' ' '); security list-keychains -d user -s "$KC" $OLD
m=$("$T/vyre-like" make "$KC" 2>&1 | tail -1)
r2=$("$T/vyre-like" read "$KC" 2>&1 | tail -1)
r1=$("$T/other" read "$KC" 2>&1 | tail -1)
r3=$(security find-generic-password -s vyre-probe -a key -w "$KC" 2>&1 | tail -1)
v() { case "$1" in READ*) echo works;; DENIED*-25308*|*"User interaction is not allowed"*) echo prompts;; DENIED*) echo blocked;; *) echo error;; esac; }
echo "CASE k0-make-item $( [ "$m" = MADE ] && echo works || echo error ) $m"
echo "CASE k1-keychain-other-binary $(v "$r1") another program's read of an item that trusts only vyre: $r1 (prompts = the system prompt would show on the person's screen; interaction is off here, so it is refused)"
echo "CASE k2-keychain-the-named-binary $(v "$r2") the program the item trusts reads it: $r2"
echo "CASE k3-keychain-security-cli $(v "$r3") the security tool (not on the item's list) reads it: $r3"
security delete-keychain "$KC" >/dev/null 2>&1
