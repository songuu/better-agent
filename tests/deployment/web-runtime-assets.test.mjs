import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const unit = readFileSync(
  new URL('../../deploy/systemd/better-agent-web.service', import.meta.url),
  'utf8',
);
const nginx = readFileSync(
  new URL('../../deploy/nginx/better-agent.location.conf', import.meta.url),
  'utf8',
);
const installer = readFileSync(
  new URL('../../scripts/deployment/install-production-web.sh', import.meta.url),
  'utf8',
);
const deploymentWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy-foundation.yml', import.meta.url),
  'utf8',
);
const publicHtml = readFileSync(
  new URL('../../apps/web/public/index.html', import.meta.url),
  'utf8',
);
const webCurrentSymlinkGuard = ['[[ -L "', '$', '{WEB_CURRENT}', '" ]]'].join('');
const publicPageMarker = '<title>Better Agent · Studio</title>';

test('runs the web runtime as a dedicated hardened loopback service', () => {
  assert.match(unit, /^User=better-agent-web$/m);
  assert.match(unit, /^Group=better-agent-web$/m);
  assert.match(unit, /^EnvironmentFile=\/opt\/better-agent\/shared\/web\.env$/m);
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/opt\/better-agent\/web-current\/apps\/web\/dist\/server\.js$/m,
  );
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(unit, /^Environment=.*(?:SECRET|PASSWORD|TOKEN)/m);
});

test('owns only the canonical Better Agent Nginx path and preserves its URI', () => {
  assert.match(nginx, /^location = \/better-agent \{$/m);
  assert.match(nginx, /^location \/better-agent\/ \{$/m);
  assert.match(nginx, /^\s+proxy_pass http:\/\/127\.0\.0\.1:4310;$/m);
  assert.doesNotMatch(nginx, /location \/(?:agent-build|aicrew|pipeline)\//u);
  assert.doesNotMatch(nginx, /proxy_pass\s+https?:\/\/(?!127\.0\.0\.1:4310)/u);
});

test('installs transactionally and verifies loopback plus TLS-routed health', () => {
  for (const required of [
    "trap 'rollback $?' ERR",
    "trap 'rollback 130' INT",
    "trap 'rollback 143' TERM",
    'Nginx include anchor must exist exactly once',
    'require_release_file',
    webCurrentSymlinkGuard,
    "--noproxy '*'",
    'nginx -t',
    'systemctl reload nginx',
    'http://127.0.0.1:4310/better-agent/api/healthz',
    '--resolve songuu.top:443:127.0.0.1',
    'https://songuu.top/better-agent/api/healthz',
    'h.build_sha!==process.argv[2]',
  ]) {
    assert.ok(installer.includes(required), `missing deployment invariant: ${required}`);
  }
  assert.match(installer, /\^\[0-9a-f\]\{40\}\$/u);
  assert.doesNotMatch(installer, /StrictHostKeyChecking=no|ssh-keyscan|chmod\s+777/u);
});

test('retries TLS acceptance while nginx retires workers with the old route table', () => {
  const reloadIndex = installer.lastIndexOf('systemctl reload nginx');
  const acceptanceEndIndex = installer.indexOf('\ntrap - ERR', reloadIndex);
  assert.ok(reloadIndex >= 0);
  assert.ok(acceptanceEndIndex > reloadIndex);
  const publicAcceptance = installer.slice(reloadIndex, acceptanceEndIndex);

  assert.equal(installer.match(/for attempt in \{1\.\.20\};/gu)?.length, 2);
  assert.match(
    publicAcceptance,
    /for attempt in \{1\.\.20\};[\s\S]*if curl[\s\S]*https:\/\/songuu\.top\/better-agent\/api\/healthz[\s\S]*&&[\s\\]+node -e[\s\S]*h\.build_sha!==process\.argv\[2\][\s\S]*"\$\{ACCEPTED_SHA\}"; then\s+break/u,
  );
  assert.match(
    publicAcceptance,
    /if \[\[ "\$\{attempt\}" == 20 \]\]; then false; fi\s+sleep 1\s+done/u,
  );
  assert.equal(publicAcceptance.match(/for attempt in \{1\.\.20\};/gu)?.length, 1);
});

test('verifies the deployed page with a marker owned by the public HTML', () => {
  assert.ok(publicHtml.includes(publicPageMarker));
  assert.ok(deploymentWorkflow.includes(`grep -Fq '${publicPageMarker}'`));
  assert.doesNotMatch(deploymentWorkflow, /BETTER AGENT \/ STUDIO/u);
});
