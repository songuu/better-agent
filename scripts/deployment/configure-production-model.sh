#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_FILE="${1:?model environment source file is required}"
readonly SHARED_ROOT="${SHARED_ROOT:-/opt/better-agent/shared}"
readonly TARGET_FILE="${SHARED_ROOT}/model.env"
readonly WEB_SERVICE_NAME="better-agent-web.service"
readonly WORKER_SERVICE_NAME="better-agent-worker.service"

[[ -f "${SOURCE_FILE}" && ! -L "${SOURCE_FILE}" ]]
[[ "$(stat -c %h -- "${SOURCE_FILE}")" == 1 ]]
[[ "$(wc -l < "${SOURCE_FILE}")" == 3 ]]
grep -Eq '^BETTER_AGENT_MODEL_API_KEY=[A-Za-z0-9_.-]{8,512}$' "${SOURCE_FILE}"
grep -Eq '^BETTER_AGENT_MODEL_BASE_URL=https://[^[:space:]]{1,1000}$' "${SOURCE_FILE}"
grep -Eq '^BETTER_AGENT_MODEL_NAME=(deepseek-v4-flash|deepseek-v4-pro|gpt-5\.4-mini|gpt-5\.5|gpt-5\.6-sol)$' "${SOURCE_FILE}"
[[ "$(grep -Ec '^BETTER_AGENT_MODEL_(API_KEY|BASE_URL|NAME)=' "${SOURCE_FILE}")" == 3 ]]

node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trimEnd().split("\n");
const base = lines.find((line) => line.startsWith("BETTER_AGENT_MODEL_BASE_URL="))?.slice(28);
const url = new URL(base);
if (url.protocol !== "https:" || url.username || url.password || url.hash) process.exit(1);
' "${SOURCE_FILE}"

install -d -m 0700 "${SHARED_ROOT}"
backup="$(mktemp "${SHARED_ROOT}/model.env.backup.XXXXXX")"
target_existed=0
cookie_jar=""
if [[ -f "${TARGET_FILE}" ]]; then
  [[ ! -L "${TARGET_FILE}" ]]
  cp -a -- "${TARGET_FILE}" "${backup}"
  target_existed=1
fi

rollback() {
  local exit_code="${1:-$?}"
  trap - ERR INT TERM
  if [[ "${target_existed}" == 1 ]]; then
    install -m 0640 -o root -g better-agent-web "${backup}" "${TARGET_FILE}"
  else
    rm -f -- "${TARGET_FILE}"
  fi
  systemctl restart "${WEB_SERVICE_NAME}" || true
  systemctl restart "${WORKER_SERVICE_NAME}" || true
  if [[ -n "${cookie_jar}" ]]; then
    rm -f -- "${cookie_jar}"
  fi
  rm -f -- "${backup}"
  exit "${exit_code}"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

install -m 0640 -o root -g better-agent-web "${SOURCE_FILE}" "${TARGET_FILE}"
systemctl restart "${WEB_SERVICE_NAME}"
systemctl restart "${WORKER_SERVICE_NAME}"
systemctl is-active --quiet "${WORKER_SERVICE_NAME}"
for attempt in {1..20}; do
  if health="$(curl --fail --silent --show-error --max-time 2 --noproxy '*' \
    http://127.0.0.1:4310/better-agent/api/healthz)" && \
    HEALTH="${health}" node -e 'const h=JSON.parse(process.env.HEALTH);if(h.status!=="ok"||h.model_runtime!=="configured")process.exit(1)'; then
    break
  fi
  if [[ "${attempt}" == 20 ]]; then false; fi
  sleep 1
done

readonly product_environment="${SHARED_ROOT}/postgres/env/product.env"
readonly model_name="$(sed -n 's/^BETTER_AGENT_MODEL_NAME=//p' "${SOURCE_FILE}")"
admin_password="$(sed -n 's/^BETTER_AGENT_ADMIN_PASSWORD=//p' "${product_environment}")"
[[ "${admin_password}" =~ ^[A-Za-z0-9_-]{32}$ ]]
cookie_jar="$(mktemp)"
login_payload="$(printf '{"password":"%s"}' "${admin_password}")"
login_response="$(printf '%s' "${login_payload}" | curl --fail --silent --show-error \
  --max-time 20 --cookie-jar "${cookie_jar}" \
  --header 'Content-Type: application/json' \
  --header 'X-Better-Agent-CSRF: 1' \
  --data-binary @- \
  https://songuu.top/better-agent/api/product/login)"
LOGIN_RESPONSE="${login_response}" node -e 'const r=JSON.parse(process.env.LOGIN_RESPONSE);if(r.authenticated!==true)process.exit(1)'
assist_payload="$(MODEL_NAME="${model_name}" node -e 'process.stdout.write(JSON.stringify({action:"generate",capability_kinds:[],description:"验证生产模型运行时可返回结构化角色结果",model:process.env.MODEL_NAME,name:"Production Smoke",role_mode:"text"}))')"
assist_response="$(printf '%s' "${assist_payload}" | curl --fail --silent --show-error \
  --max-time 90 --cookie "${cookie_jar}" \
  --header 'Content-Type: application/json' \
  --header 'X-Better-Agent-CSRF: 1' \
  --data-binary @- \
  https://songuu.top/better-agent/api/product/role-assist)"
ASSIST_RESPONSE="${assist_response}" node -e 'const r=JSON.parse(process.env.ASSIST_RESPONSE);const instructions=r?.suggestion?.instructions;if(typeof instructions!=="string"||instructions.length<1)process.exit(1)'
rm -f -- "${cookie_jar}"
cookie_jar=""

trap - ERR INT TERM
rm -f -- "${backup}"
printf 'Better Agent model runtime configured without exposing credentials.\n'
