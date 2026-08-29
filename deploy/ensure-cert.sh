#!/usr/bin/env bash
# md2pdf.qiangi.top 证书自动签发：
# DNS A 记录生效后自动运行 certbot（HTTP-01），签发成功后本脚本自退（标记文件）。
# 由 cron 每 10 分钟调用一次；已签发则直接退出。
set -u

DOMAIN="md2pdf.qiangi.top"
FLAG="/root/.md2pdf-cert-issued"
LOG="/var/log/md2pdf-cert.log"

[ -f "$FLAG" ] && exit 0

# 域名必须解析到本机才可能通过 HTTP-01 校验
SERVER_IP="103.212.187.98"
RESOLVED="$(dig +short "$DOMAIN" @dns1.hichina.com 2>/dev/null | tail -1)"
if [ "$RESOLVED" != "$SERVER_IP" ]; then
  echo "$(date '+%F %T') DNS 未生效 ($RESOLVED)，等待中" >> "$LOG"
  exit 0
fi

echo "$(date '+%F %T') DNS 已生效，开始签发证书" >> "$LOG"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email >> "$LOG" 2>&1; then
  touch "$FLAG"
  echo "$(date '+%F %T') 证书签发成功" >> "$LOG"
else
  echo "$(date '+%F %T') 签发失败，下轮重试" >> "$LOG"
fi
