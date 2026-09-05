#!/usr/bin/env bash
set -Eeuo pipefail

readonly config=/etc/nginx/conf.d/default.conf
readonly backup=/etc/nginx/conf.d/default.conf.bak-better-agent-cache-20260905
temporary="$(mktemp /tmp/songuu-nginx.XXXXXX)"
trap 'rm -f -- "${temporary}"' EXIT

cp -a -- "${config}" "${backup}"
awk '
  { print }
  /^[[:space:]]*location = \/ \{[[:space:]]*$/ {
    print "        add_header Cache-Control \"no-store, no-cache, must-revalidate\" always;"
  }
' "${config}" > "${temporary}"

if [[ "$(grep -Fxc '        add_header Cache-Control "no-store, no-cache, must-revalidate" always;' "${temporary}")" != 1 ]]; then
  echo 'root Cache-Control insertion is not unique' >&2
  exit 1
fi

install -m 0644 "${temporary}" "${config}"
if nginx -t; then
  systemctl reload nginx
else
  cp -a -- "${backup}" "${config}"
  nginx -t
  exit 1
fi
