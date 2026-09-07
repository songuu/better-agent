const apiRoot = '/better-agent/api/product';
const state = {
  agents: [],
  conversationId: null,
  current: null,
  currentFlow: null,
  currentKnowledge: null,
  currentDatabase: null,
  databaseTables: [],
  flows: [],
  flowReleases: [],
  flowRollbacks: [],
  knowledgeBases: [],
  knowledgeDocuments: [],
  releaseTargets: [],
  runs: [],
  view: 'agents',
};
const byId = (id) => document.getElementById(id);
const form = byId('agent-form');
const flowForm = byId('flow-form');
const knowledgeBaseForm = byId('knowledge-base-form');
const knowledgeDocumentForm = byId('knowledge-document-form');
const databaseTableForm = byId('database-table-form');
const databaseRowsForm = byId('database-rows-form');
const loginDialog = byId('login-dialog');
const roleThemes = [
  'identity',
  'objective',
  'audience',
  'expertise',
  'tone',
  'constraints',
  'process',
];
const roleLabels = {
  audience: '服务对象',
  constraints: '边界约束',
  expertise: '专业能力',
  identity: '身份定位',
  objective: '核心目标',
  process: '工作流程',
  tone: '表达风格',
};
const textRoleTemplate = `【身份定位】
你是：

【核心目标】
你需要完成：

【服务对象】
你的用户与默认沟通深度：

【能力与知识】
你擅长且可以使用：

【边界约束】
你必须遵守：

【工作流程与输出】
你应按以下步骤工作，并以以下格式输出：`;

function setRoleMode(mode) {
  const structured = mode === 'structured';
  byId('agent-role-profile').hidden = !structured;
  byId('agent-text-role').hidden = structured;
  form.elements.instructions.required = !structured;
  for (const theme of roleThemes) {
    form.elements[`role_${theme}_content`].required = structured;
  }
}

function populateRoleProfile(profile = null) {
  for (const theme of roleThemes) {
    const content = form.elements[`role_${theme}_content`];
    const weight = form.elements[`role_${theme}_weight`];
    if (profile?.[theme]) {
      content.value = profile[theme].content;
      weight.value = String(profile[theme].weight);
    } else {
      content.value = '';
      weight.value = weight.defaultValue;
    }
    content.closest('article').querySelector('output').textContent = weight.value;
  }
}

function readRoleProfile() {
  return Object.fromEntries(
    roleThemes.map((theme) => [
      theme,
      {
        content: form.elements[`role_${theme}_content`].value,
        weight: Number(form.elements[`role_${theme}_weight`].value),
      },
    ]),
  );
}

function compileRolePreview() {
  if (form.elements.role_mode.value === 'text') return form.elements.instructions.value.trim();
  const profile = readRoleProfile();
  return [
    'STRUCTURED_ROLE_PROFILE',
    '以下七项定义角色行为；权重仅用于角色要求冲突时的优先级，不得覆盖系统安全边界。',
    ...roleThemes.map(
      (theme) =>
        `[${roleLabels[theme]} | 权重 ${profile[theme].weight}/100]\n${profile[theme].content.trim()}`,
    ),
    'END_STRUCTURED_ROLE_PROFILE',
  ].join('\n\n');
}

function currentCapabilityKinds() {
  return [
    ...(form.elements.knowledge_base_id.value ? ['knowledge'] : []),
    ...(form.elements.database_table_id.value ? ['database'] : []),
    ...(form.elements.child_agent_id.value ? ['subagent'] : []),
    ...(form.elements.flow_id.value ? ['flow'] : []),
  ];
}

const modelRouteDescriptions = {
  'gpt-5.4-mini': '快速与低成本任务',
  'gpt-5.5': '平衡的通用执行',
  'gpt-5.6-sol': '复杂推理与生产任务',
};

function readStrategyProfile() {
  const routes = [...byId('agent-model-routes').querySelectorAll('input:checked')].map((input) => ({
    description: modelRouteDescriptions[input.value],
    model: input.value,
  }));
  return {
    forced_capability: form.elements.forced_capability.value,
    max_input_tokens: Number(form.elements.max_input_tokens.value),
    max_iterations: Number(form.elements.max_iterations.value),
    max_output_tokens: Number(form.elements.max_output_tokens.value),
    max_tool_calls: Number(form.elements.max_tool_calls.value),
    parameter_defaults: {
      database_contains: form.elements.database_contains_default.value.trim(),
      knowledge_query: form.elements.knowledge_query_default.value.trim(),
    },
    parameter_extraction: form.elements.parameter_extraction.checked,
    routes,
    routing_mode: form.elements.routing_mode.value,
    schema_version: 'product-agent-strategy/5',
    temperature: Number(form.elements.temperature.value),
  };
}

function populateStrategyProfile(profile = null, model = 'gpt-5.6-sol', version = 1) {
  const strategy = profile || {
    forcedCapability: 'none',
    maxInputTokens: 32000,
    maxIterations: 3,
    maxOutputTokens: 2000,
    maxToolCalls: 2,
    parameterDefaults: { databaseContains: '', knowledgeQuery: '' },
    parameterExtraction: false,
    routes: [{ model }],
    routingMode: 'fixed',
    temperature: 0.2,
  };
  form.elements.routing_mode.value = strategy.routingMode;
  form.elements.forced_capability.value = strategy.forcedCapability;
  form.elements.max_input_tokens.value = String(strategy.maxInputTokens);
  form.elements.max_iterations.value = String(strategy.maxIterations || 1);
  form.elements.max_output_tokens.value = String(strategy.maxOutputTokens);
  form.elements.max_tool_calls.value = String(strategy.maxToolCalls);
  form.elements.knowledge_query_default.value = strategy.parameterDefaults?.knowledgeQuery || '';
  form.elements.database_contains_default.value =
    strategy.parameterDefaults?.databaseContains || '';
  form.elements.parameter_extraction.checked = strategy.parameterExtraction;
  form.elements.temperature.value = String(strategy.temperature);
  byId('strategy-temperature-value').textContent = String(strategy.temperature);
  byId('strategy-version').textContent = `STRATEGY V${version}`;
  const selected = new Set(strategy.routes.map((route) => route.model));
  byId('agent-model-routes')
    .querySelectorAll('input')
    .forEach((input) => {
      input.checked = selected.has(input.value);
    });
}

function enforceStrategyRouteSelection() {
  const defaultModel = form.elements.model.value;
  const defaultRoute = [...byId('agent-model-routes').querySelectorAll('input')].find(
    (input) => input.value === defaultModel,
  );
  defaultRoute.checked = true;
  if (form.elements.routing_mode.value === 'fixed') {
    byId('agent-model-routes')
      .querySelectorAll('input')
      .forEach((input) => {
        input.checked = input.value === defaultModel;
      });
  }
}

function applyRoleSuggestion(suggestion) {
  form.elements.role_mode.value = suggestion.role_mode;
  form.elements.instructions.value = suggestion.instructions;
  populateRoleProfile(suggestion.role_profile);
  setRoleMode(suggestion.role_mode);
  byId('instruction-count').textContent = String(suggestion.instructions.length);
}

async function runRoleAssist(action) {
  const name = form.elements.name.value.trim();
  if (!name) {
    toast('请先填写 Agent 名称', true);
    form.elements.name.focus();
    return;
  }
  const capabilityKinds = currentCapabilityKinds();
  if (action === 'optimize_for_capabilities' && capabilityKinds.length === 0) {
    toast('请先绑定知识库或数据表', true);
    return;
  }
  const buttons = [
    byId('role-assist-generate'),
    byId('role-assist-optimize'),
    byId('role-assist-capabilities'),
  ];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  byId(
    `role-assist-${action === 'optimize_for_capabilities' ? 'capabilities' : action}`,
  ).dataset.loading = 'true';
  const mode = form.elements.role_mode.value;
  const input = {
    action,
    capability_kinds: capabilityKinds,
    description: form.elements.description.value,
    model: form.elements.model.value,
    name,
    role_mode: mode,
    ...(action === 'generate'
      ? {}
      : mode === 'structured'
        ? { role_profile: readRoleProfile() }
        : { instructions: form.elements.instructions.value }),
  };
  try {
    const payload = await request('/role-assist', {
      body: JSON.stringify(input),
      method: 'POST',
    });
    applyRoleSuggestion(payload.suggestion);
    toast(action === 'generate' ? '角色草案已生成，请确认后保存' : '角色已优化，请确认后保存');
  } catch (error) {
    toast(
      error.message === 'model_runtime_not_configured'
        ? '模型运行时尚未配置，无法使用 AI 角色助手'
        : error.message,
      true,
    );
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      delete button.dataset.loading;
    });
  }
}

function showRolePerspective() {
  const compiled = compileRolePreview();
  byId('role-perspective-mode').textContent =
    form.elements.role_mode.value === 'structured' ? 'STRUCTURED · 7 THEMES' : 'TEXT · 6 SECTIONS';
  byId('role-perspective-length').textContent = `${compiled.length.toLocaleString('zh-CN')} CHARS`;
  byId('role-perspective-output').textContent = compiled || '角色内容为空。';
  byId('role-perspective-dialog').showModal();
}

function setRoleFullscreen(enabled) {
  document.body.classList.toggle('role-fullscreen-open', enabled);
  byId('role-fullscreen').setAttribute('aria-pressed', String(enabled));
  byId('role-fullscreen').textContent = enabled ? '退出全屏' : '全屏';
}

function toast(message, error = false) {
  const node = byId('toast');
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.classList.add('is-visible');
  window.setTimeout(() => node.classList.remove('is-visible'), 2800);
}

async function request(path, options = {}) {
  const mutation = options.method && options.method !== 'GET' && options.method !== 'HEAD';
  const response = await fetch(`${apiRoot}${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(mutation ? { 'X-Better-Agent-CSRF': '1' } : {}),
      ...options.headers,
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span.innerHTML;
}

function renderAgents() {
  byId('agent-count').textContent = String(state.agents.length).padStart(2, '0');
  const list = byId('agent-list');
  if (state.agents.length === 0) {
    list.innerHTML = '<p class="empty-note">还没有 Agent。创建一个开始。</p>';
    return;
  }
  list.innerHTML = state.agents
    .map(
      (agent) =>
        `<button class="agent-row ${state.current?.id === agent.id ? 'is-current' : ''}" data-agent-id="${agent.id}"><i>${escapeHtml(agent.name.slice(0, 1).toUpperCase())}</i><span><b>${escapeHtml(agent.name)}</b><small>${escapeHtml(agent.model)}</small></span><em>${agent.status === 'published' ? 'LIVE' : 'DRAFT'}</em></button>`,
    )
    .join('');
  list.querySelectorAll('[data-agent-id]').forEach((button) => {
    button.addEventListener('click', () => selectAgent(button.dataset.agentId));
  });
}

function flowGraph(template, condition) {
  const nodes = [
    { config: { key: 'message' }, id: 'input', label: '消息输入', type: 'input' },
    { config: { template }, id: 'prompt', label: '模板映射', type: 'template' },
  ];
  if (condition.enabled) {
    nodes.push({
      config: {
        operand: condition.operand,
        operator: condition.operator,
        source: 'prompt',
        whenFalse: condition.whenFalse,
        whenTrue: condition.whenTrue,
      },
      id: 'condition',
      label: '条件判断',
      type: 'condition',
    });
  }
  const outputSource = condition.enabled ? 'condition' : 'prompt';
  nodes.push({ config: { source: outputSource }, id: 'output', label: '结果输出', type: 'output' });
  return {
    edges: [
      { id: 'input_prompt', source: 'input', target: 'prompt' },
      {
        id: condition.enabled ? 'prompt_condition' : 'prompt_output',
        source: 'prompt',
        target: condition.enabled ? 'condition' : 'output',
      },
      ...(condition.enabled
        ? [{ id: 'condition_output', source: 'condition', target: 'output' }]
        : []),
    ],
    nodes,
  };
}

function syncFlowConditionEditor() {
  const enabled = flowForm.elements.conditionEnabled.checked;
  byId('flow-condition-node').hidden = !enabled;
  byId('flow-canvas').classList.toggle('has-condition', enabled);
  byId('flow-canvas').querySelector('.node-output code').textContent = enabled
    ? 'condition → output'
    : 'prompt → output';
}

function renderFlows() {
  byId('flow-count').textContent = String(state.flows.length).padStart(2, '0');
  const list = byId('flow-list');
  if (state.flows.length === 0) {
    list.innerHTML = '<p class="empty-note">还没有 Flow。创建一个开始。</p>';
    return;
  }
  list.innerHTML = state.flows
    .map(
      (flow) =>
        `<button class="flow-row ${state.currentFlow?.id === flow.id ? 'is-current' : ''}" data-flow-id="${flow.id}"><i>F</i><span><b>${escapeHtml(flow.name)}</b><small>${flow.graph.nodes.length} NODES · REV ${flow.revision}</small></span><em>${flow.status === 'published' ? `V${flow.publishedVersion}` : 'DRAFT'}</em></button>`,
    )
    .join('');
  list.querySelectorAll('[data-flow-id]').forEach((button) => {
    button.addEventListener('click', () => selectFlow(button.dataset.flowId));
  });
}

function renderFlowInspector(flow = state.currentFlow) {
  const deployments = byId('flow-deployments');
  if (!flow || flow.deployments.length === 0) {
    deployments.innerHTML = '<span>尚未部署环境</span>';
    return;
  }
  deployments.innerHTML = flow.deployments
    .map(
      (deployment) =>
        `<span><b>${escapeHtml(deployment.environment.toUpperCase())}</b> · V${deployment.releaseVersion}</span>`,
    )
    .join('');
}

function renderFlowHistory() {
  const environment = byId('flow-environment').value;
  const deployment = state.currentFlow?.deployments.find(
    (item) => item.environment === environment,
  );
  byId('flow-release-history').innerHTML = state.flowReleases.length
    ? state.flowReleases
        .map(
          (release) =>
            `<article><span><b>V${release.version} · ${escapeHtml(release.name)}</b><small>${new Date(release.publishedAt).toLocaleString('zh-CN')}</small></span><button type="button" class="button button-ghost" data-rollback-version="${release.version}" ${!deployment || deployment.releaseVersion === release.version ? 'disabled' : ''}>恢复</button></article>`,
        )
        .join('')
    : '<span>尚无已发布版本。</span>';
  byId('flow-rollback-history').innerHTML = state.flowRollbacks.length
    ? state.flowRollbacks
        .map(
          (receipt) =>
            `<article><span><b>${escapeHtml(receipt.environment.toUpperCase())} · V${receipt.fromReleaseVersion} → V${receipt.targetReleaseVersion}</b><small>${escapeHtml(receipt.reason)} · ${new Date(receipt.rolledBackAt).toLocaleString('zh-CN')}</small></span></article>`,
        )
        .join('')
    : '<span>暂无回滚记录。</span>';
  byId('flow-release-history')
    .querySelectorAll('[data-rollback-version]')
    .forEach((button) => {
      button.addEventListener('click', () => rollbackFlow(Number(button.dataset.rollbackVersion)));
    });
}

async function loadFlowHistory(flow = state.currentFlow) {
  if (!flow) {
    state.flowReleases = [];
    state.flowRollbacks = [];
    renderFlowHistory();
    return;
  }
  const flowId = flow.id;
  const [releases, rollbacks] = await Promise.all([
    request(`/flows/${flowId}/releases`),
    request(`/flows/${flowId}/rollbacks`),
  ]);
  if (state.currentFlow?.id !== flowId) return;
  state.flowReleases = releases.releases;
  state.flowRollbacks = rollbacks.rollbacks;
  renderFlowHistory();
}

function showFlowEditor(flow = null) {
  state.currentFlow = flow;
  byId('flow-welcome').hidden = true;
  flowForm.hidden = false;
  flowForm.elements.name.value = flow?.name || '';
  flowForm.elements.description.value = flow?.description || '';
  const templateNode = flow?.graph.nodes.find((node) => node.type === 'template');
  const conditionNode = flow?.graph.nodes.find((node) => node.type === 'condition');
  flowForm.elements.template.value = templateNode?.config.template || '已处理：{{message}}';
  flowForm.elements.conditionEnabled.checked = Boolean(conditionNode);
  flowForm.elements.conditionOperator.value = conditionNode?.config.operator || 'contains';
  flowForm.elements.conditionOperand.value = conditionNode?.config.operand || '紧急';
  flowForm.elements.conditionTrue.value = conditionNode?.config.whenTrue || '紧急队列：{{value}}';
  flowForm.elements.conditionFalse.value = conditionNode?.config.whenFalse || '普通队列：{{value}}';
  syncFlowConditionEditor();
  byId('flow-editor-title').textContent = flow?.name || '未命名 Flow';
  byId('flow-kicker').textContent = flow
    ? `${flow.status.toUpperCase()} · REV ${flow.revision}`
    : 'DRAFT · NEW';
  byId('flow-save-state').textContent = flow
    ? `更新于 ${new Date(flow.updatedAt).toLocaleString('zh-CN')}`
    : '尚未保存';
  byId('debug-flow').disabled = !flow;
  byId('publish-flow').disabled = !flow;
  byId('flow-debug-output').innerHTML = '<span>等待调试</span>';
  byId('flow-debug-logs').innerHTML = '<li>输入内容并运行调试。</li>';
  renderFlowInspector(flow);
  state.flowReleases = [];
  state.flowRollbacks = [];
  renderFlowHistory();
  if (flow) loadFlowHistory(flow).catch((error) => toast(error.message, true));
  renderFlows();
}

async function rollbackFlow(targetReleaseVersion) {
  const flow = state.currentFlow;
  if (!flow) return;
  const environment = byId('flow-environment').value;
  const deployment = flow.deployments.find((item) => item.environment === environment);
  const reason = byId('flow-rollback-reason').value.trim();
  if (!deployment) return toast('当前环境尚未部署', true);
  if (!reason) return toast('请填写回滚原因', true);
  try {
    const payload = await request(`/flows/${flow.id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({
        environment,
        expected_release_version: deployment.releaseVersion,
        reason,
        target_release_version: targetReleaseVersion,
      }),
    });
    upsertFlow(payload.flow);
    byId('flow-rollback-reason').value = '';
    await loadFlowHistory(payload.flow);
    toast(`已恢复 ${environment} 到 V${targetReleaseVersion}`);
  } catch (error) {
    toast(error.message, true);
    await loadFlows();
  }
}

function selectFlow(id) {
  const flow = state.flows.find((item) => item.id === id);
  if (flow) showFlowEditor(flow);
}

async function loadFlows() {
  const payload = await request('/flows');
  state.flows = payload.flows;
  renderFlows();
  renderAgentFlowOptions();
}

function upsertFlow(flow) {
  const index = state.flows.findIndex((item) => item.id === flow.id);
  if (index === -1) state.flows.unshift(flow);
  else state.flows[index] = flow;
  showFlowEditor(flow);
}

function renderKnowledgeBases() {
  byId('knowledge-count').textContent = String(state.knowledgeBases.length).padStart(2, '0');
  const list = byId('knowledge-list');
  if (state.knowledgeBases.length === 0) {
    list.innerHTML = '<p class="empty-note">还没有知识库。创建一个开始。</p>';
    return;
  }
  list.innerHTML = state.knowledgeBases
    .map(
      (base) =>
        `<button class="knowledge-row ${state.currentKnowledge?.id === base.id ? 'is-current' : ''}" data-knowledge-id="${base.id}"><i>K</i><span><b>${escapeHtml(base.name)}</b><small>${base.documentCount} DOCUMENTS</small></span><em>READY</em></button>`,
    )
    .join('');
  list.querySelectorAll('[data-knowledge-id]').forEach((button) => {
    button.addEventListener('click', () => selectKnowledgeBase(button.dataset.knowledgeId));
  });
}

function renderAgentKnowledgeOptions() {
  const select = byId('agent-knowledge-base');
  const selected = state.current?.knowledgeBaseId || '';
  select.innerHTML = [
    '<option value="">不绑定知识库</option>',
    ...state.knowledgeBases.map(
      (base) =>
        `<option value="${base.id}">${escapeHtml(base.name)} · ${base.documentCount} DOCS</option>`,
    ),
  ].join('');
  select.value = selected;
}

function renderAgentDatabaseOptions() {
  const select = byId('agent-database-table');
  const selected = state.current?.databaseTableId || '';
  select.innerHTML = [
    '<option value="">不绑定数据表</option>',
    ...state.databaseTables.map(
      (table) =>
        `<option value="${table.id}">${escapeHtml(table.name)} · ${table.rowCount} ROWS</option>`,
    ),
  ].join('');
  select.value = selected;
}

function renderAgentChildOptions() {
  const select = byId('agent-child-agent');
  const selected = state.current?.childAgentId || '';
  select.innerHTML = [
    '<option value="">不绑定子 Agent</option>',
    ...state.agents
      .filter((agent) => agent.status === 'published' && agent.id !== state.current?.id)
      .map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} · LIVE</option>`),
  ].join('');
  select.value = selected;
}

function renderAgentFlowOptions() {
  const select = byId('agent-flow');
  const selected = state.current?.flowId || '';
  select.innerHTML = [
    '<option value="">不绑定 Flow</option>',
    ...state.flows
      .filter((flow) => flow.publishedVersion)
      .map(
        (flow) =>
          `<option value="${flow.id}">${escapeHtml(flow.name)} · V${flow.publishedVersion}</option>`,
      ),
  ].join('');
  select.value = selected;
}

function renderKnowledgeDocuments() {
  const list = byId('knowledge-documents');
  if (state.knowledgeDocuments.length === 0) {
    list.innerHTML = '<span class="empty-note">暂无文档。</span>';
    return;
  }
  list.innerHTML = state.knowledgeDocuments
    .map(
      (document) =>
        `<article><i>DOC</i><div><b>${escapeHtml(document.title)}</b><small>${document.chunkCount} CHUNKS · ${new Date(document.createdAt).toLocaleString('zh-CN')}</small></div></article>`,
    )
    .join('');
}

function showKnowledgeCreator() {
  state.currentKnowledge = null;
  byId('knowledge-welcome').hidden = true;
  byId('knowledge-detail').hidden = true;
  knowledgeBaseForm.hidden = false;
  knowledgeBaseForm.reset();
  byId('knowledge-hits').innerHTML = '<span>创建知识库后开始检索。</span>';
  renderKnowledgeBases();
}

async function selectKnowledgeBase(id) {
  const base = state.knowledgeBases.find((item) => item.id === id);
  if (!base) return;
  state.currentKnowledge = base;
  knowledgeBaseForm.hidden = true;
  byId('knowledge-welcome').hidden = true;
  byId('knowledge-detail').hidden = false;
  byId('knowledge-title').textContent = base.name;
  byId('knowledge-description').textContent = base.description || '无额外说明';
  byId('knowledge-doc-count').textContent = `${base.documentCount} DOCS`;
  byId('knowledge-hits').innerHTML = '<span>输入问题或关键词，验证检索结果。</span>';
  const payload = await request(`/knowledge-bases/${base.id}/documents`);
  state.knowledgeDocuments = payload.documents;
  renderKnowledgeDocuments();
  renderKnowledgeBases();
}

async function loadKnowledgeBases() {
  const payload = await request('/knowledge-bases');
  state.knowledgeBases = payload.knowledge_bases;
  renderKnowledgeBases();
  renderAgentKnowledgeOptions();
}

function renderDatabaseTables() {
  byId('database-count').textContent = String(state.databaseTables.length).padStart(2, '0');
  const list = byId('database-list');
  if (state.databaseTables.length === 0) {
    list.innerHTML = '<p class="empty-note">还没有数据表。创建一个开始。</p>';
    return;
  }
  list.innerHTML = state.databaseTables
    .map(
      (table) =>
        `<button class="knowledge-row ${state.currentDatabase?.id === table.id ? 'is-current' : ''}" data-database-id="${table.id}"><i>DB</i><span><b>${escapeHtml(table.name)}</b><small>${table.rowCount} ROWS · ${table.columns.length} COLS</small></span><em>READ</em></button>`,
    )
    .join('');
  list.querySelectorAll('[data-database-id]').forEach((button) => {
    button.addEventListener('click', () => selectDatabaseTable(button.dataset.databaseId));
  });
}

function showDatabaseCreator() {
  state.currentDatabase = null;
  byId('database-welcome').hidden = true;
  byId('database-detail').hidden = true;
  databaseTableForm.hidden = false;
  databaseTableForm.reset();
  byId('database-results').innerHTML = '<span>创建数据表后执行只读操作。</span>';
  renderDatabaseTables();
}

function selectDatabaseTable(id) {
  const table = state.databaseTables.find((item) => item.id === id);
  if (!table) return;
  state.currentDatabase = table;
  databaseTableForm.hidden = true;
  byId('database-welcome').hidden = true;
  byId('database-detail').hidden = false;
  byId('database-title').textContent = table.name;
  byId('database-description').textContent = table.description || '无额外说明';
  byId('database-row-count').textContent = `${table.rowCount} ROWS`;
  byId('database-columns').innerHTML = table.columns
    .map((column) => `<code>${escapeHtml(column)}</code>`)
    .join('');
  byId('database-query-column').innerHTML = table.columns
    .map((column) => `<option value="${escapeHtml(column)}">${escapeHtml(column)}</option>`)
    .join('');
  byId('database-results').innerHTML = '<span>选择列并执行参数化查询。</span>';
  renderDatabaseTables();
}

async function loadDatabaseTables() {
  const payload = await request('/database-tables');
  state.databaseTables = payload.database_tables;
  renderDatabaseTables();
  renderAgentDatabaseOptions();
  renderAgentChildOptions();
  renderAgentFlowOptions();
  renderAgentChildOptions();
  if (state.currentDatabase) {
    const id = state.currentDatabase.id;
    state.currentDatabase = state.databaseTables.find((item) => item.id === id) || null;
    if (state.currentDatabase) selectDatabaseTable(id);
  }
}

function setStudioView(view) {
  state.view = view;
  const isFlow = view === 'flows';
  const isKnowledge = view === 'knowledge';
  const isDatabase = view === 'database';
  const isEvaluation = view === 'evaluation';
  const isAgent = view === 'agents';
  byId('agent-view').hidden = !isAgent;
  byId('flow-view').hidden = !isFlow;
  byId('knowledge-view').hidden = !isKnowledge;
  byId('database-view').hidden = !isDatabase;
  byId('evaluation-view').hidden = !isEvaluation;
  byId('show-agents').classList.toggle('is-active', isAgent);
  byId('show-flows').classList.toggle('is-active', isFlow);
  byId('show-knowledge').classList.toggle('is-active', isKnowledge);
  byId('show-database').classList.toggle('is-active', isDatabase);
  byId('show-evaluation').classList.toggle('is-active', isEvaluation);
  byId('new-agent').hidden = !isAgent;
  byId('new-flow').hidden = !isFlow;
  byId('new-knowledge').hidden = !isKnowledge;
  byId('new-database').hidden = !isDatabase;
  byId('workspace-path').textContent = isEvaluation
    ? '独立工作区 / RELEASES'
    : isDatabase
      ? '独立工作区 / DATABASE'
      : isKnowledge
        ? '独立工作区 / KNOWLEDGE'
        : isFlow
          ? '独立工作区 / FLOWS'
          : '独立工作区 / AGENTS';
  byId('studio-title').textContent = isEvaluation
    ? 'Release & Evaluation'
    : isDatabase
      ? 'Database Studio'
      : isKnowledge
        ? 'Knowledge Center'
        : isFlow
          ? 'Flow Studio'
          : 'Agent Studio';
  if (isEvaluation) renderEvaluationCenter();
}

function renderEvaluationCenter() {
  const publishedAgents = new Set(
    state.releaseTargets.filter((target) => target.kind === 'agent').map((target) => target.id),
  ).size;
  const publishedFlows = new Set(
    state.releaseTargets.filter((target) => target.kind === 'flow').map((target) => target.id),
  ).size;
  const deployedFlows = state.releaseTargets
    .filter((target) => target.kind === 'flow')
    .reduce((count, target) => count + target.environments.length, 0);
  const completedRuns = state.releaseTargets.reduce(
    (count, target) => count + target.successfulEvidenceCount,
    0,
  );
  const failedRuns = state.releaseTargets.reduce(
    (count, target) => count + target.failedEvidenceCount,
    0,
  );
  const totalRuns = state.releaseTargets.reduce(
    (count, target) => count + target.totalEvidenceCount,
    0,
  );
  const pendingRuns = totalRuns - completedRuns - failedRuns;
  byId('published-agents').textContent = String(publishedAgents);
  byId('published-flows').textContent = String(publishedFlows);
  byId('deployed-flows').textContent = String(deployedFlows);
  byId('completed-runs').textContent = String(completedRuns);
  const targets = state.releaseTargets.map((target) => ({
    detail: `${target.model || 'DETERMINISTIC'} · VERSION ${target.releaseVersion} · ${target.successfulEvidenceCount}/${target.totalEvidenceCount} PASS`,
    environments: target.environments.map((environment) => environment.toUpperCase()),
    kind: target.kind.toUpperCase(),
    name: target.name,
  }));
  byId('release-count').textContent = `${String(targets.length).padStart(2, '0')} TARGETS`;
  byId('release-targets').innerHTML = targets.length
    ? targets
        .map(
          (target) =>
            `<article><i>${target.kind.slice(0, 1)}</i><div><small>${target.kind}</small><b>${escapeHtml(target.name)}</b><span>${escapeHtml(target.detail)}</span></div><em>${target.environments.map(escapeHtml).join(' / ') || 'NOT DEPLOYED'}</em></article>`,
        )
        .join('')
    : '<p class="empty-note">尚无已发布资产。请先在 Agent Studio 或 Flow Studio 发布版本。</p>';
  const successRate = totalRuns === 0 ? 'N/A' : `${Math.round((completedRuns / totalRuns) * 100)}%`;
  byId('evaluation-evidence').innerHTML = [
    ['已完成', completedRuns, '真实模型响应已持久化'],
    ['失败', failedRuns, '保留错误码供定位'],
    ['执行中', pendingRuns, '尚未形成终态证据'],
    ['观测成功率', successRate, `${totalRuns} 条 Agent Run`],
  ]
    .map(
      ([label, value, note]) =>
        `<article><span>${label}</span><b>${value}</b><small>${note}</small></article>`,
    )
    .join('');
}

async function loadReleaseTargets() {
  const payload = await request('/release-evaluation');
  state.releaseTargets = payload.targets;
  if (state.view === 'evaluation') renderEvaluationCenter();
}

function renderRuns() {
  const list = byId('runs-list');
  if (state.runs.length === 0) {
    list.innerHTML = '<p class="empty-note">暂无运行记录。</p>';
    return;
  }
  list.innerHTML = state.runs
    .map((run) => {
      const tools = (run.iterationTrace || [])
        .filter((iteration) => iteration.action === 'tool')
        .map(
          (iteration) =>
            `${String(iteration.iteration)} ${String(iteration.capability).toUpperCase()} · ${String(iteration.toolInput).slice(0, 80)}`,
        );
      return `<article class="run-row"><span>${String(run.sequence).padStart(2, '0')}</span><div><b>${escapeHtml(run.inputText)}</b><small>${escapeHtml(run.outputText || run.errorCode || '运行中')} · ${Number(run.iterationCount || 0)} ITER</small>${tools.length > 0 ? `<small>TOOLS · ${tools.map(escapeHtml).join(' / ')}</small>` : ''}</div><em class="is-${run.status}">${run.status.toUpperCase()}</em><time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></article>`;
    })
    .join('');
}

function resetConversationView() {
  byId('run-messages').innerHTML =
    '<div class="run-empty"><b>发布版本已锁定</b><span>发送消息，验证真实模型响应与持久化 Run。</span></div>';
}

async function loadRuns() {
  const payload = await request('/runs');
  state.runs = payload.runs;
  renderRuns();
}

function showEditor(agent = null) {
  setRoleFullscreen(false);
  state.current = agent;
  state.conversationId = null;
  resetConversationView();
  byId('welcome-panel').hidden = true;
  form.hidden = false;
  form.elements.name.value = agent?.name || '';
  form.elements.description.value = agent?.description || '';
  form.elements.instructions.value = agent?.instructions || textRoleTemplate;
  form.elements.model.value = agent?.model || 'gpt-5.6-sol';
  populateStrategyProfile(
    agent?.strategyProfile,
    form.elements.model.value,
    agent?.strategyVersion,
  );
  form.elements.role_mode.value = agent?.roleMode || 'text';
  populateRoleProfile(agent?.roleProfile || null);
  setRoleMode(form.elements.role_mode.value);
  renderAgentKnowledgeOptions();
  renderAgentDatabaseOptions();
  byId('editor-title').textContent = agent?.name || '未命名 Agent';
  byId('agent-kicker').textContent = agent
    ? `${agent.status.toUpperCase()} · REV ${agent.revision}`
    : 'DRAFT · NEW';
  byId('save-state').textContent = agent
    ? `更新于 ${new Date(agent.updatedAt).toLocaleString('zh-CN')}`
    : '尚未保存';
  byId('instruction-count').textContent = String(form.elements.instructions.value.length);
  byId('publish-agent').disabled = !agent;
  byId('test-agent').disabled = agent?.status !== 'published';
  renderAgents();
}

function selectAgent(id) {
  const agent = state.agents.find((item) => item.id === id);
  if (agent) showEditor(agent);
}

async function loadAgents() {
  const payload = await request('/agents');
  state.agents = payload.agents;
  byId('persistence-state').textContent = 'PostgreSQL 已连接';
  renderAgents();
}

async function bootstrap() {
  try {
    const health = await fetch('/better-agent/api/healthz', { cache: 'no-store' }).then(
      (response) => response.json(),
    );
    byId('runtime-label').textContent = health.status === 'ok' ? '在线' : '异常';
    byId('build-label').textContent =
      `BUILD · ${health.build_sha === 'development' ? 'LOCAL' : health.build_sha.slice(0, 8).toUpperCase()}`;
    await request('/session');
    await Promise.all([
      loadAgents(),
      loadFlows(),
      loadKnowledgeBases(),
      loadDatabaseTables(),
      loadRuns(),
      loadReleaseTargets(),
    ]);
  } catch (error) {
    if (error.status === 401) loginDialog.showModal();
    else {
      byId('runtime-label').textContent = '未配置';
      byId('persistence-state').textContent = '服务端待配置';
      toast('产品运行时尚未配置', true);
    }
  }
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('login-error').textContent = '';
  try {
    await request('/login', {
      method: 'POST',
      body: JSON.stringify({ password: event.currentTarget.elements.password.value }),
    });
    loginDialog.close();
    event.currentTarget.reset();
    await Promise.all([
      loadAgents(),
      loadFlows(),
      loadKnowledgeBases(),
      loadDatabaseTables(),
      loadRuns(),
      loadReleaseTargets(),
    ]);
    toast('工作区已连接');
  } catch (error) {
    byId('login-error').textContent = error.message;
  }
});

document.querySelectorAll('[data-create]').forEach((button) => {
  button.addEventListener('click', () => showEditor());
});
document.querySelectorAll('[data-create-flow]').forEach((button) => {
  button.addEventListener('click', () => showFlowEditor());
});
document.querySelectorAll('[data-create-knowledge]').forEach((button) => {
  button.addEventListener('click', () => showKnowledgeCreator());
});
document.querySelectorAll('[data-create-database]').forEach((button) => {
  button.addEventListener('click', () => showDatabaseCreator());
});
byId('show-agents').addEventListener('click', () => setStudioView('agents'));
byId('show-flows').addEventListener('click', () => setStudioView('flows'));
byId('show-knowledge').addEventListener('click', () => setStudioView('knowledge'));
byId('show-database').addEventListener('click', () => setStudioView('database'));
byId('show-evaluation').addEventListener('click', () => setStudioView('evaluation'));
byId('new-agent').addEventListener('click', () => showEditor());
byId('new-flow').addEventListener('click', () => showFlowEditor());
byId('new-knowledge').addEventListener('click', () => showKnowledgeCreator());
byId('new-database').addEventListener('click', () => showDatabaseCreator());
form.elements.instructions.addEventListener('input', () => {
  byId('instruction-count').textContent = String(form.elements.instructions.value.length);
});
form.elements.role_mode.addEventListener('change', () => {
  setRoleMode(form.elements.role_mode.value);
});
form.elements.model.addEventListener('change', enforceStrategyRouteSelection);
form.elements.routing_mode.addEventListener('change', enforceStrategyRouteSelection);
form.elements.temperature.addEventListener('input', () => {
  byId('strategy-temperature-value').textContent = form.elements.temperature.value;
});
byId('role-assist-generate').addEventListener('click', () => runRoleAssist('generate'));
byId('role-assist-optimize').addEventListener('click', () => runRoleAssist('optimize'));
byId('role-assist-capabilities').addEventListener('click', () =>
  runRoleAssist('optimize_for_capabilities'),
);
byId('role-perspective').addEventListener('click', showRolePerspective);
byId('role-fullscreen').addEventListener('click', () =>
  setRoleFullscreen(!document.body.classList.contains('role-fullscreen-open')),
);
document.querySelectorAll('[data-close-role-perspective]').forEach((button) => {
  button.addEventListener('click', () => byId('role-perspective-dialog').close());
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('role-fullscreen-open')) {
    setRoleFullscreen(false);
  }
});
for (const theme of roleThemes) {
  form.elements[`role_${theme}_weight`].addEventListener('input', (event) => {
    event.currentTarget.closest('article').querySelector('output').textContent =
      event.currentTarget.value;
  });
}
form.elements.name.addEventListener('input', () => {
  byId('editor-title').textContent = form.elements.name.value.trim() || '未命名 Agent';
});
flowForm.elements.name.addEventListener('input', () => {
  byId('flow-editor-title').textContent = flowForm.elements.name.value.trim() || '未命名 Flow';
});

flowForm.elements.conditionEnabled.addEventListener('change', syncFlowConditionEditor);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const input = {
    child_agent_id: values.child_agent_id || null,
    database_table_id: values.database_table_id || null,
    description: values.description,
    flow_id: values.flow_id || null,
    instructions: values.instructions,
    knowledge_base_id: values.knowledge_base_id || null,
    model: values.model,
    name: values.name,
    role_mode: values.role_mode,
    role_profile: values.role_mode === 'structured' ? readRoleProfile() : null,
    strategy_profile: readStrategyProfile(),
  };
  try {
    const payload = state.current
      ? await request(`/agents/${state.current.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...input, expected_revision: state.current.revision }),
        })
      : await request('/agents', { method: 'POST', body: JSON.stringify(input) });
    const index = state.agents.findIndex((agent) => agent.id === payload.agent.id);
    if (index === -1) state.agents.unshift(payload.agent);
    else state.agents[index] = payload.agent;
    showEditor(payload.agent);
    toast('Draft 已持久化');
  } catch (error) {
    toast(error.message, true);
  }
});

byId('publish-agent').addEventListener('click', async () => {
  if (!state.current) return;
  try {
    const payload = await request(`/agents/${state.current.id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: state.current.revision }),
    });
    state.agents[state.agents.findIndex((agent) => agent.id === payload.agent.id)] = payload.agent;
    showEditor(payload.agent);
    await loadReleaseTargets();
    toast('不可变版本已发布');
  } catch (error) {
    toast(error.message, true);
  }
});

flowForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = {
    description: flowForm.elements.description.value,
    graph: flowGraph(flowForm.elements.template.value, {
      enabled: flowForm.elements.conditionEnabled.checked,
      operand: flowForm.elements.conditionOperand.value,
      operator: flowForm.elements.conditionOperator.value,
      whenFalse: flowForm.elements.conditionFalse.value,
      whenTrue: flowForm.elements.conditionTrue.value,
    }),
    name: flowForm.elements.name.value,
  };
  try {
    const payload = state.currentFlow
      ? await request(`/flows/${state.currentFlow.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...input, expected_revision: state.currentFlow.revision }),
        })
      : await request('/flows', { method: 'POST', body: JSON.stringify(input) });
    upsertFlow(payload.flow);
    toast('Flow Draft 已持久化');
  } catch (error) {
    toast(error.message, true);
  }
});

byId('debug-flow').addEventListener('click', async () => {
  if (!state.currentFlow) return;
  const input = byId('flow-debug-input').value.trim();
  if (!input) {
    toast('请输入调试内容', true);
    return;
  }
  byId('debug-flow').disabled = true;
  byId('flow-debug-output').innerHTML = '<span>正在执行节点图……</span>';
  try {
    const payload = await request(`/flows/${state.currentFlow.id}/debug`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: state.currentFlow.revision, input }),
    });
    byId('flow-debug-output').textContent = payload.debug.outputText;
    byId('flow-debug-logs').innerHTML = payload.debug.logs
      .map(
        (log, index) =>
          `<li><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(log.nodeId)}</b><small>${escapeHtml(log.outputPreview)}</small></div><em>PASS</em></li>`,
      )
      .join('');
    toast('Flow 调试完成并已记录');
  } catch (error) {
    byId('flow-debug-output').textContent = `调试失败：${error.message}`;
    toast(error.message, true);
  } finally {
    byId('debug-flow').disabled = false;
  }
});

byId('publish-flow').addEventListener('click', async () => {
  if (!state.currentFlow) return;
  try {
    const payload = await request(`/flows/${state.currentFlow.id}/publish`, {
      method: 'POST',
      body: JSON.stringify({
        environment: byId('flow-environment').value,
        expected_revision: state.currentFlow.revision,
      }),
    });
    upsertFlow(payload.flow);
    await loadReleaseTargets();
    toast('不可变 Flow 版本已部署');
  } catch (error) {
    toast(error.message, true);
  }
});

byId('flow-environment').addEventListener('change', renderFlowHistory);

knowledgeBaseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(knowledgeBaseForm));
  try {
    const payload = await request('/knowledge-bases', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    state.knowledgeBases.unshift(payload.knowledge_base);
    renderAgentKnowledgeOptions();
    await selectKnowledgeBase(payload.knowledge_base.id);
    toast('知识库已持久化');
  } catch (error) {
    toast(error.message, true);
  }
});

knowledgeDocumentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.currentKnowledge) return;
  const input = Object.fromEntries(new FormData(knowledgeDocumentForm));
  try {
    await request(`/knowledge-bases/${state.currentKnowledge.id}/documents`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    knowledgeDocumentForm.reset();
    await loadKnowledgeBases();
    await selectKnowledgeBase(state.currentKnowledge.id);
    toast('文档已切分并写入 PostgreSQL');
  } catch (error) {
    toast(error.message, true);
  }
});

byId('knowledge-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.currentKnowledge) {
    toast('请先选择知识库', true);
    return;
  }
  const query = event.currentTarget.elements.query.value.trim();
  const hits = byId('knowledge-hits');
  hits.innerHTML = '<span>正在检索不可变片段……</span>';
  try {
    const payload = await request(`/knowledge-bases/${state.currentKnowledge.id}/search`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    hits.innerHTML =
      payload.hits.length === 0
        ? '<span>没有匹配片段，请调整关键词。</span>'
        : payload.hits
            .map(
              (hit) =>
                `<article><header><b>${escapeHtml(hit.documentTitle)}</b><em>#${hit.ordinal + 1} · ${Number(hit.score).toFixed(3)}</em></header><p>${escapeHtml(hit.content)}</p></article>`,
            )
            .join('');
  } catch (error) {
    hits.textContent = `检索失败：${error.message}`;
    toast(error.message, true);
  }
});

databaseTableForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(databaseTableForm));
  const input = {
    columns: String(values.columns)
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean),
    description: values.description,
    name: values.name,
  };
  try {
    const payload = await request('/database-tables', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    state.databaseTables.unshift(payload.database_table);
    selectDatabaseTable(payload.database_table.id);
    toast('托管数据表已创建');
  } catch (error) {
    toast(error.message, true);
  }
});

databaseRowsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.currentDatabase) return;
  try {
    const rows = JSON.parse(event.currentTarget.elements.rows.value);
    const payload = await request(`/database-tables/${state.currentDatabase.id}/rows`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
    databaseRowsForm.reset();
    await loadDatabaseTables();
    toast(`${payload.appended} 行记录已追加到 PostgreSQL`);
  } catch (error) {
    toast(error instanceof SyntaxError ? 'JSON 格式无效' : error.message, true);
  }
});

byId('database-query-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.currentDatabase) {
    toast('请先选择数据表', true);
    return;
  }
  const results = byId('database-results');
  results.innerHTML = '<span>正在执行受控只读操作……</span>';
  try {
    const payload = await request(`/database-tables/${state.currentDatabase.id}/query`, {
      method: 'POST',
      body: JSON.stringify({
        column: event.currentTarget.elements.column.value,
        contains: event.currentTarget.elements.contains.value,
        limit: 20,
      }),
    });
    results.innerHTML = payload.rows.length
      ? payload.rows
          .map(
            (row) =>
              `<article><header><b>ROW #${row.ordinal + 1}</b><em>PARAMETERIZED</em></header><p>${escapeHtml(JSON.stringify(row.record, null, 2))}</p></article>`,
          )
          .join('')
      : '<span>没有匹配记录。</span>';
  } catch (error) {
    results.textContent = `查询失败：${error.message}`;
    toast(error.message, true);
  }
});

function appendMessage(role, text, pending = false) {
  const messages = byId('run-messages');
  messages.querySelector('.run-empty')?.remove();
  const article = document.createElement('article');
  article.className = `run-message is-${role}${pending ? ' is-pending' : ''}`;
  const label = document.createElement('span');
  label.textContent = role === 'user' ? 'YOU' : 'AGENT';
  const body = document.createElement('p');
  body.textContent = text;
  article.append(label, body);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return article;
}

byId('test-agent').addEventListener('click', () => {
  if (!state.current || state.current.status !== 'published') return;
  byId('run-agent-name').textContent = state.current.name;
  byId('run-dialog').showModal();
  byId('run-form').elements.message.focus();
});
byId('run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.current) return;
  const textarea = event.currentTarget.elements.message;
  const message = textarea.value.trim();
  if (!message) return;
  textarea.value = '';
  textarea.disabled = true;
  appendMessage('user', message);
  const pending = appendMessage('assistant', '正在调用已发布模型……', true);
  try {
    if (!state.conversationId) {
      const payload = await request(`/agents/${state.current.id}/conversations`, {
        method: 'POST',
        body: '{}',
      });
      state.conversationId = payload.conversation.id;
    }
    const payload = await request(`/conversations/${state.conversationId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    pending.remove();
    appendMessage('assistant', payload.run.outputText);
    await loadRuns();
  } catch (error) {
    pending.remove();
    appendMessage('assistant', `运行失败：${error.message}`);
    await loadRuns().catch(() => undefined);
  } finally {
    textarea.disabled = false;
    textarea.focus();
  }
});

byId('show-runs').addEventListener('click', async () => {
  await loadRuns().catch((error) => toast(error.message, true));
  byId('runs-dialog').showModal();
});
document
  .querySelector('[data-close-run]')
  .addEventListener('click', () => byId('run-dialog').close());
document
  .querySelector('[data-close-runs]')
  .addEventListener('click', () => byId('runs-dialog').close());

bootstrap();
