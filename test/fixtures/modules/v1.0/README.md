# Pinned fixtures: module contract 1.0

Frozen. Each module here is written against exactly module contract 1.0 and is never edited. When
a contract minor ships, add a new folder (`v1.1/`, ...) with a module written against it, and leave
this one as it is. `test/module-api-compat.test.js` runs every fixture against every supported
contract version (ADR 0047 section 8): a release that breaks one doesn't ship.
