#!/bin/sh
FAKE_CLAUDE_LOG=/dev/null exec node /opt/vyre/core/switchboard/testing/fake-claude.js "$@"
