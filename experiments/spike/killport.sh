#!/usr/bin/env bash
# Kill whatever listens on the given TCP ports (Windows netstat). Usage: spike/killport.sh 7801 7802
for p in "$@"; do for pid in $(netstat -ano | grep -E "[:.]$p +[^ ]+ +LISTENING" | awk '{print $5}' | sort -u); do taskkill //F //PID $pid >/dev/null 2>&1; done; done
