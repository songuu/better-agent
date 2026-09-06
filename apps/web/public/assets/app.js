const apiRoot = '/better-agent/api/product';
const state = {
  agents: [],
  conversationId: null,
  current: null,
  currentFlow: null,
  currentKnowledge: null,
  flows: [],
  knowledgeBases: [],
  knowledgeDocuments: [],
  runs: [],
  view: 'agents',
};
const byId = (id) => document.getElementById(id);
const form = byId('agent-form');
const flowForm = byId('flow-form');
const knowledgeBaseForm = byId('knowledge-base-form');
const knowledgeDocumentForm = byId('knowledge-document-form');
const loginDialog = byId('login-dialog');

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

function flowGraph(template) {
  return {
    edges: [
      { id: 'input_prompt', source: 'input', target: 'prompt' },
      { id: 'prompt_output', source: 'prompt', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: '消息输入', type: 'input' },
      { config: { template }, id: 'prompt', label: '模板映射', type: 'template' },
      { config: { source: 'prompt' }, id: 'output', label: '结果输出', type: 'output' },
    ],
  };
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

function showFlowEditor(flow = null) {
  state.currentFlow = flow;
  byId('flow-welcome').hidden = true;
  flowForm.hidden = false;
  flowForm.elements.name.value = flow?.name || '';
  flowForm.elements.description.value = flow?.description || '';
  const templateNode = flow?.graph.nodes.find((node) => node.type === 'template');
  flowForm.elements.template.value = templateNode?.config.template || '已处理：{{message}}';
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
  renderFlows();
}

function selectFlow(id) {
  const flow = state.flows.find((item) => item.id === id);
  if (flow) showFlowEditor(flow);
}

async function loadFlows() {
  const payload = await request('/flows');
  state.flows = payload.flows;
  renderFlows();
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
}

function setStudioView(view) {
  state.view = view;
  const isFlow = view === 'flows';
  const isKnowledge = view === 'knowledge';
  const isAgent = view === 'agents';
  byId('agent-view').hidden = !isAgent;
  byId('flow-view').hidden = !isFlow;
  byId('knowledge-view').hidden = !isKnowledge;
  byId('show-agents').classList.toggle('is-active', isAgent);
  byId('show-flows').classList.toggle('is-active', isFlow);
  byId('show-knowledge').classList.toggle('is-active', isKnowledge);
  byId('new-agent').hidden = !isAgent;
  byId('new-flow').hidden = !isFlow;
  byId('new-knowledge').hidden = !isKnowledge;
  byId('workspace-path').textContent = isKnowledge
    ? '独立工作区 / KNOWLEDGE'
    : isFlow
      ? '独立工作区 / FLOWS'
      : '独立工作区 / AGENTS';
  byId('studio-title').textContent = isKnowledge
    ? 'Knowledge Center'
    : isFlow
      ? 'Flow Studio'
      : 'Agent Studio';
}

function renderRuns() {
  const list = byId('runs-list');
  if (state.runs.length === 0) {
    list.innerHTML = '<p class="empty-note">暂无运行记录。</p>';
    return;
  }
  list.innerHTML = state.runs
    .map(
      (run) =>
        `<article class="run-row"><span>${String(run.sequence).padStart(2, '0')}</span><div><b>${escapeHtml(run.inputText)}</b><small>${escapeHtml(run.outputText || run.errorCode || '运行中')}</small></div><em class="is-${run.status}">${run.status.toUpperCase()}</em><time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></article>`,
    )
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
  state.current = agent;
  state.conversationId = null;
  resetConversationView();
  byId('welcome-panel').hidden = true;
  form.hidden = false;
  form.elements.name.value = agent?.name || '';
  form.elements.description.value = agent?.description || '';
  form.elements.instructions.value = agent?.instructions || '';
  form.elements.model.value = agent?.model || 'gpt-5.6-sol';
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
    await Promise.all([loadAgents(), loadFlows(), loadKnowledgeBases(), loadRuns()]);
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
    await Promise.all([loadAgents(), loadFlows(), loadKnowledgeBases(), loadRuns()]);
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
byId('show-agents').addEventListener('click', () => setStudioView('agents'));
byId('show-flows').addEventListener('click', () => setStudioView('flows'));
byId('show-knowledge').addEventListener('click', () => setStudioView('knowledge'));
byId('new-agent').addEventListener('click', () => showEditor());
byId('new-flow').addEventListener('click', () => showFlowEditor());
byId('new-knowledge').addEventListener('click', () => showKnowledgeCreator());
form.elements.instructions.addEventListener('input', () => {
  byId('instruction-count').textContent = String(form.elements.instructions.value.length);
});
form.elements.name.addEventListener('input', () => {
  byId('editor-title').textContent = form.elements.name.value.trim() || '未命名 Agent';
});
flowForm.elements.name.addEventListener('input', () => {
  byId('flow-editor-title').textContent = flowForm.elements.name.value.trim() || '未命名 Flow';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(form));
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
    toast('不可变版本已发布');
  } catch (error) {
    toast(error.message, true);
  }
});

flowForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = {
    description: flowForm.elements.description.value,
    graph: flowGraph(flowForm.elements.template.value),
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
    toast('不可变 Flow 版本已部署');
  } catch (error) {
    toast(error.message, true);
  }
});

knowledgeBaseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(knowledgeBaseForm));
  try {
    const payload = await request('/knowledge-bases', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    state.knowledgeBases.unshift(payload.knowledge_base);
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
