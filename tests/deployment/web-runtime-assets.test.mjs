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
const publicJavaScript = readFileSync(
  new URL('../../apps/web/public/assets/app.js', import.meta.url),
  'utf8',
);
const publicCss = readFileSync(
  new URL('../../apps/web/public/assets/app.css', import.meta.url),
  'utf8',
);
const webCurrentSymlinkGuard = ['[[ -L "', '$', '{WEB_CURRENT}', '" ]]'].join('');
const publicPageMarker = '<title>Better Agent · Studio</title>';
const modelConfigurator = readFileSync(
  new URL('../../scripts/deployment/configure-production-model.sh', import.meta.url),
  'utf8',
);

test('runs the web runtime as a dedicated hardened loopback service', () => {
  assert.match(unit, /^User=better-agent-web$/m);
  assert.match(unit, /^Group=better-agent-web$/m);
  assert.match(unit, /^EnvironmentFile=\/opt\/better-agent\/shared\/web\.env$/m);
  assert.match(unit, /^EnvironmentFile=\/opt\/better-agent\/shared\/postgres\/env\/product\.env$/m);
  assert.match(unit, /^EnvironmentFile=-\/opt\/better-agent\/shared\/model\.env$/m);
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
  assert.match(
    deploymentWorkflow,
    /page="\$\(curl --fail --silent --show-error --max-time 10 https:\/\/songuu\.top\/better-agent\/\)"/u,
  );
  assert.match(
    deploymentWorkflow,
    /grep -Fq '<title>Better Agent · Studio<\/title>' <<<"\$\{page\}"/u,
  );
  assert.doesNotMatch(deploymentWorkflow, /curl[^\r\n|]*\|\s*grep -Fq/u);
  assert.doesNotMatch(deploymentWorkflow, /BETTER AGENT \/ STUDIO/u);
});

test('ships the Flow editor, environment deployment and durable debug controls', () => {
  for (const marker of [
    'id="show-flows"',
    'id="flow-form"',
    'id="flow-debug-logs"',
    'id="flow-environment"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Flow Studio control: ${marker}`);
  }
  for (const route of ['/flows', '/debug', '/publish']) {
    assert.ok(publicJavaScript.includes(route), `missing Flow Studio API route: ${route}`);
  }
  assert.doesNotMatch(publicJavaScript, /localStorage|sessionStorage/u);
});

test('ships the durable Knowledge Center ingestion and retrieval controls', () => {
  for (const marker of [
    'id="show-knowledge"',
    'id="knowledge-base-form"',
    'id="knowledge-document-form"',
    'id="knowledge-search-form"',
    'id="knowledge-hits"',
    'id="agent-knowledge-base"',
    'id="agent-database-table"',
    'id="agent-role-mode"',
    'id="agent-role-profile"',
    'id="role-assist-generate"',
    'id="role-assist-optimize"',
    'id="role-assist-capabilities"',
    'id="role-perspective-dialog"',
    'id="role-fullscreen"',
    'id="agent-routing-mode"',
    'id="agent-forced-capability"',
    'id="agent-model-routes"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Knowledge Center control: ${marker}`);
  }
  for (const route of ['/knowledge-bases', '/documents', '/search']) {
    assert.ok(publicJavaScript.includes(route), `missing Knowledge Center API route: ${route}`);
  }
  assert.ok(publicJavaScript.includes('knowledge_base_id'));
  assert.ok(publicJavaScript.includes('database_table_id'));
  assert.ok(publicJavaScript.includes('role_profile'));
  assert.ok(publicJavaScript.includes('【身份定位】'));
  assert.ok(publicJavaScript.includes('/role-assist'));
  assert.ok(publicJavaScript.includes('compileRolePreview'));
  assert.ok(publicJavaScript.includes('readStrategyProfile'));
  assert.ok(publicJavaScript.includes('product-agent-strategy/1'));
  assert.ok(publicJavaScript.includes('renderAgentKnowledgeOptions'));
  assert.doesNotMatch(publicJavaScript, /localStorage|sessionStorage/u);
  assert.match(publicCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/u);
  assert.match(publicCss, /@media \(max-width: 1400px\) \{\s*\.knowledge-studio \{/u);
  assert.match(publicCss, /@media \(max-width: 1400px\) \{\s*\.flow-studio \{/u);
});

test('ships a release and evaluation center backed by recorded product evidence', () => {
  for (const marker of [
    'id="show-evaluation"',
    'id="evaluation-view"',
    'id="release-targets"',
    'id="evaluation-evidence"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing release evaluation control: ${marker}`);
  }
  for (const marker of [
    'renderEvaluationCenter',
    'completedRuns',
    'deployedFlows',
    '/release-evaluation',
  ]) {
    assert.ok(publicJavaScript.includes(marker), `missing evaluation evidence logic: ${marker}`);
  }
  assert.doesNotMatch(publicJavaScript, /mockEvaluation|fakeEvaluation|simulatedEvaluation/u);
});

test('ships the managed PostgreSQL Database Studio with parameterized read controls', () => {
  for (const marker of [
    'id="show-database"',
    'id="database-view"',
    'id="database-table-form"',
    'id="database-rows-form"',
    'id="database-query-form"',
    'id="database-results"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Database Studio control: ${marker}`);
  }
  for (const marker of ['/database-tables', '/rows', '/query', 'loadDatabaseTables']) {
    assert.ok(publicJavaScript.includes(marker), `missing Database Studio behavior: ${marker}`);
  }
  assert.doesNotMatch(publicJavaScript, /SELECT\s+\*\s+FROM|executeSql|rawSql/iu);
});

test('packages the PostgreSQL client dependency required by the product runtime', () => {
  assert.match(
    deploymentWorkflow,
    /pnpm --config\.inject-workspace-packages=true --filter @better-agent\/web/u,
  );
  assert.match(deploymentWorkflow, /web-runtime\/node_modules\/pg\/package\.json/u);
  assert.match(deploymentWorkflow, /apps\/web\/node_modules/u);
});

test('configures model credentials through a private file without logging their value', () => {
  assert.match(deploymentWorkflow, /secrets\.BETTER_AGENT_MODEL_API_KEY/u);
  assert.match(deploymentWorkflow, /better-agent-model-\$\{ACCEPTED_SHA\}\.env/u);
  assert.match(modelConfigurator, /^install -m 0640 -o root -g better-agent-web/m);
  assert.match(modelConfigurator, /h\.model_runtime!=="configured"/u);
  assert.doesNotMatch(modelConfigurator, /set -x|echo "\$\{?MODEL_API_KEY/u);
});
