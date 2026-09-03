#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASE_ROOT="${RELEASE_ROOT:?RELEASE_ROOT is required}"
readonly SHARED_ROOT="${SHARED_ROOT:?SHARED_ROOT is required}"
readonly REMOTE_RELEASE="${REMOTE_RELEASE:?REMOTE_RELEASE is required}"
readonly ACCEPTED_SHA="${ACCEPTED_SHA:?ACCEPTED_SHA is required}"
readonly WEB_CURRENT="${WEB_CURRENT:-/opt/better-agent/web-current}"
readonly NGINX_MAIN_CONFIG="${NGINX_MAIN_CONFIG:-/etc/nginx/conf.d/default.conf}"
readonly NGINX_SNIPPET="/etc/nginx/snippets/better-agent.location.conf"
readonly SYSTEMD_UNIT="/etc/systemd/system/better-agent-web.service"
readonly SERVICE_NAME="better-agent-web.service"
readonly INCLUDE_ANCHOR='    include /etc/nginx/snippets/essay-manage.location.conf;'
readonly INCLUDE_LINE='    include /etc/nginx/snippets/better-agent.location.conf;'

if [[ ! "${ACCEPTED_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ACCEPTED_SHA must be a lowercase 40-character Git SHA" >&2
  exit 64
fi

release="$(readlink -f -- "${REMOTE_RELEASE}")"
if [[ "${release}" != "${RELEASE_ROOT}/better-agent-${ACCEPTED_SHA}" ]]; then
  echo "release path is not bound to ACCEPTED_SHA" >&2
  exit 65
fi

require_release_file() {
  local candidate="$1"
  local resolved
  resolved="$(readlink -e -- "${candidate}")"
  [[ "${resolved}" == "${release}/"* ]]
  [[ -f "${candidate}" && ! -L "${candidate}" ]]
  [[ "$(stat -c %h -- "${candidate}")" == 1 ]]
}

require_release_file "${release}/apps/web/dist/server.js"
require_release_file "${release}/apps/web/public/index.html"
require_release_file "${release}/deploy/systemd/better-agent-web.service"
require_release_file "${release}/deploy/nginx/better-agent.location.conf"
[[ -f "${NGINX_MAIN_CONFIG}" && ! -L "${NGINX_MAIN_CONFIG}" ]]
if [[ -e "${WEB_CURRENT}" || -L "${WEB_CURRENT}" ]]; then
  [[ -L "${WEB_CURRENT}" ]]
fi

backup_dir="$(mktemp -d /tmp/better-agent-web-install.XXXXXX)"
previous_web_release="$(readlink -f -- "${WEB_CURRENT}" 2>/dev/null || true)"
unit_existed=0
snippet_existed=0
env_existed=0
service_was_enabled=0
service_was_active=0

backup_file() {
  local source="$1"
  local name="$2"
  if [[ -f "${source}" ]]; then
    cp -a -- "${source}" "${backup_dir}/${name}"
    return 0
  fi
  return 1
}

restore_file() {
  local target="$1"
  local name="$2"
  local existed="$3"
  if [[ "${existed}" == 1 ]]; then
    cp -a -- "${backup_dir}/${name}" "${target}"
  else
    rm -f -- "${target}"
  fi
}

backup_file "${SYSTEMD_UNIT}" unit && unit_existed=1 || true
backup_file "${NGINX_SNIPPET}" snippet && snippet_existed=1 || true
backup_file "${SHARED_ROOT}/web.env" env && env_existed=1 || true
cp -a -- "${NGINX_MAIN_CONFIG}" "${backup_dir}/nginx-main"
systemctl is-enabled --quiet "${SERVICE_NAME}" && service_was_enabled=1 || true
systemctl is-active --quiet "${SERVICE_NAME}" && service_was_active=1 || true

rollback() {
  local exit_code="${1:-$?}"
  trap - ERR INT TERM
  set +e
  cp -a -- "${backup_dir}/nginx-main" "${NGINX_MAIN_CONFIG}"
  restore_file "${NGINX_SNIPPET}" snippet "${snippet_existed}"
  restore_file "${SYSTEMD_UNIT}" unit "${unit_existed}"
  restore_file "${SHARED_ROOT}/web.env" env "${env_existed}"
  rm -f -- "${WEB_CURRENT}.next"
  if [[ -n "${previous_web_release}" ]]; then
    ln -sfn -- "${previous_web_release}" "${WEB_CURRENT}.next"
    mv -Tf -- "${WEB_CURRENT}.next" "${WEB_CURRENT}"
  else
    rm -f -- "${WEB_CURRENT}"
  fi
  systemctl daemon-reload
  if [[ "${service_was_enabled}" == 0 ]]; then systemctl disable "${SERVICE_NAME}"; fi
  if [[ "${service_was_active}" == 1 ]]; then
    systemctl restart "${SERVICE_NAME}"
  else
    systemctl stop "${SERVICE_NAME}"
  fi
  nginx -t && systemctl reload nginx
  rm -rf -- "${backup_dir}"
  exit "${exit_code}"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

if ! getent passwd better-agent-web >/dev/null; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin better-agent-web
fi
install -d -m 0755 /etc/nginx/snippets
install -m 0644 "${release}/deploy/systemd/better-agent-web.service" "${SYSTEMD_UNIT}"
install -m 0644 "${release}/deploy/nginx/better-agent.location.conf" "${NGINX_SNIPPET}"

if ! grep -Fqx "${INCLUDE_LINE}" "${NGINX_MAIN_CONFIG}"; then
  if [[ "$(grep -Fxc "${INCLUDE_ANCHOR}" "${NGINX_MAIN_CONFIG}")" != 1 ]]; then
    echo "Nginx include anchor must exist exactly once" >&2
    false
  fi
  awk -v anchor="${INCLUDE_ANCHOR}" -v include_line="${INCLUDE_LINE}" \
    '{ print; if ($0 == anchor) print include_line }' \
    "${NGINX_MAIN_CONFIG}" > "${backup_dir}/nginx-main.next"
  install -m 0644 "${backup_dir}/nginx-main.next" "${NGINX_MAIN_CONFIG}"
fi

install -d -m 0700 "${SHARED_ROOT}"
printf 'BETTER_AGENT_WEB_HOST=127.0.0.1\nBETTER_AGENT_WEB_PORT=4310\nBETTER_AGENT_BUILD_SHA=%s\n' \
  "${ACCEPTED_SHA}" > "${backup_dir}/web.env.next"
install -m 0640 -o root -g better-agent-web "${backup_dir}/web.env.next" "${SHARED_ROOT}/web.env"
ln -sfn -- "${release}" "${WEB_CURRENT}.next"
mv -Tf -- "${WEB_CURRENT}.next" "${WEB_CURRENT}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

for attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 2 --noproxy '*' \
    http://127.0.0.1:4310/better-agent/api/healthz > "${backup_dir}/health.json"; then
    break
  fi
  if [[ "${attempt}" == 20 ]]; then false; fi
  sleep 1
done
node -e 'const fs=require("node:fs");const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(h.status!=="ok"||h.build_sha!==process.argv[2])process.exit(1)' \
  "${backup_dir}/health.json" "${ACCEPTED_SHA}"

nginx -t
systemctl reload nginx
for attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 5 --noproxy '*' \
    --resolve songuu.top:443:127.0.0.1 \
    https://songuu.top/better-agent/api/healthz > "${backup_dir}/public-health.json" && \
    node -e 'const fs=require("node:fs");const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(h.status!=="ok"||h.build_sha!==process.argv[2])process.exit(1)' \
      "${backup_dir}/public-health.json" "${ACCEPTED_SHA}"; then
    break
  fi
  # nginx reload is asynchronous; old workers may briefly serve the pre-deploy route table.
  if [[ "${attempt}" == 20 ]]; then false; fi
  sleep 1
done

trap - ERR INT TERM
rm -rf -- "${backup_dir}"
echo "Better Agent web deployed release=${release}"
