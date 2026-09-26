#!/bin/sh
# c.sh <route> [json]
curl -s -X POST 127.0.0.1:19300$1 -d "${2:-{\}}"
