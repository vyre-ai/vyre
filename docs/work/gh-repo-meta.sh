#!/usr/bin/env sh
# Run after work/readme-011 lands on main (integrator only).
gh repo edit vyre-ai/vyre \
  --description "Open-source, self-hosted Claude Code agents. They run on your server and answer from your Mac or your phone. Your keys stay in your own vault." \
  --add-topic claude-code \
  --add-topic ai-agents \
  --add-topic self-hosted \
  --add-topic macos \
  --add-topic open-source \
  --add-topic agents
