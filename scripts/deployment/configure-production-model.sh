#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_FILE="${1:?model environment source file is required}"
readonly SHARED_ROOT="${SHARED_ROOT:-/opt/better-agent/shared}"
readonly TARGET_FILE="${SHARED_ROOT}/model.env"
readonly SERVICE_NAME="better-agent-web.service"

[[ -f "${SOURCE_FILE}" && ! -L "${SOURCE_FILE}" ]]
[[ "$(stat -c %h -- "${SOURCE_FILE}")" == 1 ]]
[[ "$(wc -l < "${SOURCE_FILE}")" == 2 ]]
grep -Eq '^BETTER_AGENT_MODEL_API_KEY=[A-Za-z0-9_.-]{8,512}$' "${SOURCE_FILE}"
grep -Eq '^BETTER_AGENT_MODEL_BASE_URL=https://[^[:space:]]{1,1000}$' "${SOURCE_FILE}"
[[ "$(grep -Ec '^BETTER_AGENT_MODEL_(API_KEY|BASE_URL)=' "${SOURCE_FILE}")" == 2 ]]

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
  systemctl restart "${SERVICE_NAME}" || true
  rm -f -- "${backup}"
  exit "${exit_code}"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

install -m 0640 -o root -g better-agent-web "${SOURCE_FILE}" "${TARGET_FILE}"
systemctl restart "${SERVICE_NAME}"
for attempt in {1..20}; do
  if health="$(curl --fail --silent --show-error --max-time 2 --noproxy '*' \
    http://127.0.0.1:4310/better-agent/api/healthz)" && \
    HEALTH="${health}" node -e 'const h=JSON.parse(process.env.HEALTH);if(h.status!=="ok"||h.model_runtime!=="configured")process.exit(1)'; then
    break
  fi
  if [[ "${attempt}" == 20 ]]; then false; fi
  sleep 1
done

trap - ERR INT TERM
rm -f -- "${backup}"
printf 'Better Agent model runtime configured without exposing credentials.\n'
