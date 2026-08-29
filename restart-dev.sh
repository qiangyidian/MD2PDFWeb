#!/usr/bin/env bash
# 开发期快速重启后端（生产环境请使用 systemd: systemctl restart md2pdf-backend）
set -e
pkill -f '[n]ode src/index.js' 2>/dev/null || true
sleep 0.5
cd "$(dirname "$0")/server"
setsid nohup env PORT=8002 node src/index.js > /tmp/md2pdf-server.log 2>&1 < /dev/null &
sleep 2
curl -s http://127.0.0.1:8002/api/health && echo " <- backend ok"
