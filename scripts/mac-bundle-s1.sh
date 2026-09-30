#!/bin/sh
# mac-bundle-s1.sh: spike S1's code-signing checks (docs/work/capsule-bundle.md), in CI only.
#
#   scripts/mac-bundle-s1.sh DIR
#
# DIR holds four builds of Vyre.app:
#   A.app  build 1, signed with the CI certificate
#   B.app  build 2 (different source, so a different cdhash), signed with the same certificate
#   C.app  build 2 signed with another self-signed certificate with the same name
#   D.app  build 2 signed ad hoc
# TCC keeps the designated requirement (DR) of the build a person granted, and checks later
# builds against it. So B must satisfy A's DR, and C and D must not. Exits 1 when any of that fails.
set -u
dir="$1"
fail=0
dr() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
for b in A B C D; do
  printf '%s  cdhash %s\n   DR  %s\n' "$b" "$(cdhash "$dir/$b.app")" "$(dr "$dir/$b.app")"
  codesign -dvv "$dir/$b.app" 2>&1 | grep -E '^(Authority|Signature|TeamIdentifier)=' | sed 's/^/     /'
done
reqA="$(dr "$dir/A.app")"
[ -n "$reqA" ] || { echo "A has no designated requirement"; exit 1; }
[ "$(cdhash "$dir/A.app")" != "$(cdhash "$dir/B.app")" ] || { echo "FAIL: A and B have the same cdhash, so the test proves nothing"; fail=1; }
check() { # name, expected (pass|fail)
  if codesign --verify --strict -R "=$reqA" "$dir/$1.app" 2>"$dir/$1.verify"; then got=pass; else got=fail; fi
  printf '%s against A'"'"'s DR: %s (expected %s)  %s\n' "$1" "$got" "$2" "$(tail -n 1 "$dir/$1.verify")"
  [ "$got" = "$2" ] || fail=1
}
check A pass
check B pass
check C fail
check D fail
# Whole-bundle validity (nested node included), which says nothing about trust.
for b in A B; do
  if codesign --verify --strict --deep "$dir/$b.app" 2>/dev/null; then echo "$b verifies (strict, deep)"; else echo "FAIL: $b does not verify"; fail=1; fi
done
# Gatekeeper's view, for the record: it wants a Developer ID and notarization, so a self-signed
# app is rejected here. Files fetched by curl carry no quarantine flag, so Gatekeeper is not asked.
spctl --assess --type execute -vv "$dir/A.app" 2>&1 | sed 's/^/spctl: /'
exit $fail
