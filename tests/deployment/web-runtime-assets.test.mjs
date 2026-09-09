import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const unit = readFileSync(
  new URL('../../deploy/systemd/better-agent-web.service', import.meta.url),
  'utf8',
);
const workerUnit = readFileSync(
  new URL('../../deploy/systemd/better-agent-worker.service', import.meta.url),
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

test('runs the asynchronous SubAgent worker with independent execution credentials', () => {
  assert.match(workerUnit, /^User=better-agent-worker$/m);
  assert.match(workerUnit, /^Group=better-agent-worker$/m);
  assert.match(
    workerUnit,
    /^EnvironmentFile=\/opt\/better-agent\/shared\/postgres\/env\/execution\.env$/m,
  );
  assert.match(workerUnit, /^EnvironmentFile=\/opt\/better-agent\/shared\/model\.env$/m);
  assert.match(workerUnit, /^ConditionPathExists=\/opt\/better-agent\/shared\/model\.env$/m);
  assert.match(
    workerUnit,
    /^ExecStart=\/usr\/bin\/node \/opt\/better-agent\/worker-current\/apps\/worker\/dist\/main\.js$/m,
  );
  assert.match(workerUnit, /^NoNewPrivileges=true$/m);
  assert.match(workerUnit, /^ProtectSystem=strict$/m);
  assert.match(workerUnit, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(workerUnit, /^Environment=.*(?:SECRET|PASSWORD|TOKEN)/m);
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
    'better-agent-worker.service',
    'apps/worker/dist/main.js',
    'WORKER_CURRENT',
    'systemctl is-active --quiet "${WORKER_SERVICE_NAME}"',
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
    'id="flow-condition-enabled"',
    'id="flow-condition-node"',
    'id="flow-plugin-enabled"',
    'id="flow-plugin-node"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Flow Studio control: ${marker}`);
  }
  for (const route of ['/flows', '/debug', '/publish']) {
    assert.ok(publicJavaScript.includes(route), `missing Flow Studio API route: ${route}`);
  }
  assert.ok(publicHtml.includes('value="starts_with"'), 'missing Flow condition operator control');
  for (const marker of [
    "type: 'condition'",
    "type: 'plugin'",
    'plugin.resource.identity',
    'pipeline.slice(1).map',
  ]) {
    assert.ok(publicJavaScript.includes(marker), `missing executable Flow node marker: ${marker}`);
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
    'id="agent-database-operation"',
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
    'name="knowledge_query_default"',
    'name="database_contains_default"',
    'name="max_iterations"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Knowledge Center control: ${marker}`);
  }
  for (const route of ['/knowledge-bases', '/documents', '/search']) {
    assert.ok(publicJavaScript.includes(route), `missing Knowledge Center API route: ${route}`);
  }
  assert.ok(publicJavaScript.includes('knowledge_base_id'));
  assert.ok(publicJavaScript.includes('database_table_id'));
  assert.ok(publicJavaScript.includes('database_operation_id'));
  assert.ok(publicJavaScript.includes('role_profile'));
  assert.ok(publicJavaScript.includes('【身份定位】'));
  assert.ok(publicJavaScript.includes('/role-assist'));
  assert.ok(publicJavaScript.includes('compileRolePreview'));
  assert.ok(publicJavaScript.includes('readStrategyProfile'));
  assert.ok(publicJavaScript.includes('product-agent-strategy/5'));
  assert.ok(publicJavaScript.includes('child_agent_id'));
  assert.ok(publicJavaScript.includes('child_agent_ids'));
  assert.ok(publicJavaScript.includes('selectedOptions'));
  assert.ok(publicJavaScript.includes('renderAgentChildOptions'));
  assert.ok(publicHtml.includes('multiple size="3"'));
  assert.ok(publicHtml.includes('并行子 Agent（最多 3 个，每支递归 3 层）'));
  assert.ok(publicJavaScript.includes('SUBAGENT TREE'));
  assert.ok(publicJavaScript.includes('subagentInvocations'));
  assert.ok(publicJavaScript.includes('invocation.branch || 1'));
  assert.ok(publicJavaScript.includes('parameter_defaults'));
  assert.ok(publicJavaScript.includes('knowledge_query_default'));
  assert.ok(publicJavaScript.includes('database_contains_default'));
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

test('ships managed PostgreSQL Database Studio with versioned row and Operation releases', () => {
  for (const marker of [
    'id="show-database"',
    'id="database-view"',
    'id="database-table-form"',
    'id="database-rows-form"',
    'id="database-query-form"',
    'id="database-operation-form"',
    'id="database-operation-list"',
    'id="database-operation-run-form"',
    'id="flow-database-enabled"',
    'id="flow-database-node"',
    'id="database-results"',
  ]) {
    assert.ok(publicHtml.includes(marker), `missing Database Studio control: ${marker}`);
  }
  for (const marker of [
    '/database-tables',
    '/rows',
    '/query',
    'expected_version',
    'editDatabaseRow',
    'deleteDatabaseRow',
    'loadDatabaseTables',
    '/database-operations',
    'loadDatabaseOperations',
    "type: 'database'",
    'operationRevision',
  ]) {
    assert.ok(publicJavaScript.includes(marker), `missing Database Studio behavior: ${marker}`);
  }
  assert.doesNotMatch(publicJavaScript, /SELECT\s+\*\s+FROM|executeSql|rawSql/iu);
});

test('ships a workspace-scoped versioned Plugin catalog and installation control', () => {
  for (const marker of [
    'id="show-plugins"',
    'id="plugin-view"',
    'id="plugin-catalog"',
    'data-install-plugin',
    'flow-plugin-resource',
    'plugin.operations',
  ]) {
    assert.ok(
      publicHtml.includes(marker) || publicJavaScript.includes(marker),
      `missing Plugin catalog control: ${marker}`,
    );
  }
  for (const marker of ['/plugins', '/plugins/install', 'loadPluginCatalog']) {
    assert.ok(publicJavaScript.includes(marker), `missing Plugin catalog behavior: ${marker}`);
  }
  assert.doesNotMatch(publicJavaScript, /eval\(|new Function|https?:\/\//u);
});

test('ships version-pinned Custom HTTPS API resources and Flow controls', () => {
  for (const marker of [
    'id="flow-api-enabled"',
    'id="flow-api-node"',
    'id="custom-api-form"',
    'id="custom-api-list"',
    'SSRF guard / 5s / 32 KiB',
  ]) {
    assert.match(publicHtml, new RegExp(marker, 'u'));
  }
  for (const marker of [
    '/custom-apis',
    'apiRevision',
    'responsePath',
    "type: 'api'",
    'loadCustomApis',
  ]) {
    assert.match(publicJavaScript, new RegExp(marker, 'u'));
  }
  assert.doesNotMatch(publicJavaScript, /eval\(|new Function|https?:\/\//u);
});

test('ships workspace Custom Plugin authoring and exact Flow binding controls', () => {
  for (const marker of [
    'id="custom-plugin-form"',
    'id="custom-plugin-list"',
    'id="flow-plugin-resource"',
    '发布并自动安装',
  ]) {
    assert.match(publicHtml, new RegExp(marker, 'u'));
  }
  for (const marker of [
    '/custom-plugins',
    'pluginResourceId',
    'pluginRevision',
    'loadCustomPlugins',
  ]) {
    assert.match(publicJavaScript, new RegExp(marker, 'u'));
  }
});

test('ships versioned Skill Pack resources and exact Agent binding controls', () => {
  for (const marker of [
    'id="agent-skill-pack"',
    'id="skill-pack-form"',
    'id="skill-pack-list"',
    'Skill Pack',
  ]) {
    assert.match(publicHtml, new RegExp(marker, 'u'));
  }
  for (const marker of [
    '/skill-packs',
    'skill_pack_id',
    'skill_pack_release_version',
    'loadSkillPacks',
  ]) {
    assert.match(publicJavaScript, new RegExp(marker, 'u'));
  }
});

test('ships versioned MCP Streamable HTTP services and exact Agent binding controls', () => {
  for (const marker of [
    'id="agent-mcp-server"',
    'id="mcp-server-form"',
    'id="mcp-server-list"',
    'MODEL CONTEXT PROTOCOL',
  ]) {
    assert.match(publicHtml, new RegExp(marker, 'u'));
  }
  for (const marker of [
    '/mcp-servers',
    'mcp_server_id',
    'mcp_server_release_version',
    'loadMcpServers',
  ]) {
    assert.match(publicJavaScript, new RegExp(marker, 'u'));
  }
});

test('packages the PostgreSQL client dependency required by the product runtime', () => {
  assert.match(
    deploymentWorkflow,
    /pnpm --config\.inject-workspace-packages=true --filter @better-agent\/web/u,
  );
  assert.match(deploymentWorkflow, /web-runtime\/node_modules\/pg\/package\.json/u);
  assert.match(deploymentWorkflow, /apps\/web\/node_modules/u);
  assert.match(
    deploymentWorkflow,
    /pnpm --config\.inject-workspace-packages=true --filter @better-agent\/worker/u,
  );
  assert.match(deploymentWorkflow, /worker-runtime\/node_modules\/pg\/package\.json/u);
  assert.match(deploymentWorkflow, /apps\/worker\/node_modules/u);
});

test('configures model credentials through a private file without logging their value', () => {
  assert.match(deploymentWorkflow, /secrets\.BETTER_AGENT_MODEL_API_KEY/u);
  assert.match(deploymentWorkflow, /test -n "\$\{MODEL_API_KEY:-\}"/u);
  assert.doesNotMatch(
    deploymentWorkflow,
    /when provisioned|preserving current host configuration/u,
  );
  assert.match(
    deploymentWorkflow,
    /h\.build_sha!==process\.argv\[1\]\|\|h\.model_runtime!=="configured"/u,
  );
  assert.match(deploymentWorkflow, /better-agent-model-\$\{ACCEPTED_SHA\}\.env/u);
  assert.match(modelConfigurator, /^install -m 0640 -o root -g better-agent-web/m);
  assert.match(modelConfigurator, /h\.model_runtime!=="configured"/u);
  assert.match(modelConfigurator, /better-agent-worker\.service/u);
  assert.match(modelConfigurator, /systemctl is-active --quiet/u);
  assert.doesNotMatch(modelConfigurator, /set -x|echo "\$\{?MODEL_API_KEY/u);
  assert.match(
    deploymentWorkflow,
    /rm -f ~\/\.ssh\/better_agent_deploy_key "\$\{RUNNER_TEMP\}\/better-agent-model\.env"/u,
  );
});

test('requires a real production model response before deployment can pass', () => {
  assert.match(modelConfigurator, /postgres\/env\/product\.env/u);
  assert.match(modelConfigurator, /\/better-agent\/api\/product\/login/u);
  assert.match(modelConfigurator, /\/better-agent\/api\/product\/role-assist/u);
  assert.match(modelConfigurator, /instructions\.length<1/u);
  assert.match(modelConfigurator, /rollback/u);
  assert.ok(
    modelConfigurator.indexOf('/better-agent/api/product/role-assist') <
      modelConfigurator.lastIndexOf('trap - ERR INT TERM'),
  );
  assert.doesNotMatch(modelConfigurator, /echo "\$\{admin_password\}"/u);
});
