const apiRoot = '/better-agent/api/product';
const state = { agents: [], conversationId: null, current: null, runs: [] };
const byId = (id) => document.getElementById(id);
const form = byId('agent-form');
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
    await Promise.all([loadAgents(), loadRuns()]);
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
    await Promise.all([loadAgents(), loadRuns()]);
    toast('工作区已连接');
  } catch (error) {
    byId('login-error').textContent = error.message;
  }
});

document.querySelectorAll('[data-create]').forEach((button) => {
  button.addEventListener('click', () => showEditor());
});
byId('new-agent').addEventListener('click', () => showEditor());
form.elements.instructions.addEventListener('input', () => {
  byId('instruction-count').textContent = String(form.elements.instructions.value.length);
});
form.elements.name.addEventListener('input', () => {
  byId('editor-title').textContent = form.elements.name.value.trim() || '未命名 Agent';
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
