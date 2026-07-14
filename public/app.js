'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && location.pathname !== '/login.html') location.href = '/login.html';
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

const loginForm = $('#login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector('button');
    const error = $('#login-error');
    button.disabled = true;
    error.textContent = '';
    try {
      await request('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      location.href = '/';
    } catch (cause) {
      error.textContent = cause.message;
      $('#password').select();
    } finally {
      button.disabled = false;
    }
  });
}

if ($('#composer-form')) {
  const state = {
    threadId: null,
    turnId: null,
    cwd: null,
    running: false,
    streamingNode: null,
    pendingApproval: null,
    threads: [],
    activeThreadIds: new Set(),
  };

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('#toasts').append(node);
    setTimeout(() => node.remove(), 5000);
  }

  function setConnected(connected, label = connected ? 'Codex connected' : 'Reconnecting') {
    $('#connection-dot').classList.toggle('online', connected);
    $('#connection-label').textContent = label;
  }

  function updateRunStatus() {
    const currentRunning = state.threadId && state.activeThreadIds.has(state.threadId);
    const backgroundCount = [...state.activeThreadIds].filter((id) => id !== state.threadId).length;
    const pill = $('#run-status');
    pill.classList.toggle('online', state.activeThreadIds.size > 0);
    if (currentRunning) pill.lastChild.textContent = ' Working in this chat';
    else if (backgroundCount) pill.lastChild.textContent = ` ${backgroundCount} running in background`;
    else pill.lastChild.textContent = ' Ready';
  }

  function setRunning(running) {
    state.running = running;
    if (state.threadId) {
      if (running) state.activeThreadIds.add(state.threadId);
      else state.activeThreadIds.delete(state.threadId);
    }
    updateRunStatus();
    $('#interrupt').classList.toggle('hidden', !running);
    $('.send-button').disabled = running;
  }

  function syncThreadStatus(thread) {
    const type = thread?.status?.type || thread?.status;
    if (type === 'active') state.activeThreadIds.add(thread.id);
  }

  function threadTitle(thread) {
    return thread.title || thread.name || thread.preview || thread.firstUserMessage || 'Untitled thread';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderThreads() {
    const list = $('#thread-list');
    list.replaceChildren();
    if (!state.threads.length) {
      const empty = document.createElement('p');
      empty.className = 'thread-item';
      empty.textContent = 'No threads yet';
      list.append(empty);
      return;
    }
    for (const thread of state.threads) {
      const button = document.createElement('button');
      button.className = `thread-item${thread.id === state.threadId ? ' active' : ''}`;
      const title = document.createElement('strong');
      title.textContent = threadTitle(thread);
      if (state.activeThreadIds.has(thread.id)) {
        const activity = document.createElement('i');
        activity.className = 'thread-activity';
        activity.title = 'Codex is working in this chat';
        title.append(activity);
      }
      const meta = document.createElement('span');
      meta.textContent = formatDate(thread.updatedAt || thread.updated_at || thread.createdAt || thread.created_at) || thread.cwd || '';
      button.append(title, meta);
      button.addEventListener('click', () => openThread(thread.id));
      list.append(button);
    }
  }

  async function loadThreads() {
    try {
      const [result, activity] = await Promise.all([request('/api/threads'), request('/api/activity')]);
      state.threads = result.data || result.threads || result.items || [];
      state.activeThreadIds.clear();
      for (const active of activity.activeThreads || []) state.activeThreadIds.add(active.threadId);
      state.threads.forEach(syncThreadStatus);
      renderThreads();
      updateRunStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function addMessage(role, text, streaming = false) {
    $('#empty-state').classList.add('hidden');
    $('#conversation').classList.remove('hidden');
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'Y' : 'C';
    const wrapper = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'YOU' : 'CODEX';
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = text || '';
    wrapper.append(label, body);
    article.append(avatar, wrapper);
    $('#conversation').append(article);
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
    if (streaming) state.streamingNode = body;
    return body;
  }

  function addEvent(title, detail = '') {
    const card = document.createElement('div');
    card.className = 'event-card';
    const strong = document.createElement('strong');
    strong.textContent = title;
    card.append(strong);
    if (detail) card.append(document.createTextNode(` · ${detail}`));
    $('#conversation').append(card);
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
  }

  function extractText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    return value.text || value.content || value.message || value.outputText || value.output_text || extractText(value.input) || '';
  }

  function renderHistory(thread) {
    const conversation = $('#conversation');
    conversation.replaceChildren();
    const turns = thread.turns || [];
    for (const turn of turns) {
      for (const item of turn.items || []) {
        const type = String(item.type || '').toLowerCase();
        const text = extractText(item);
        if (!text) continue;
        if (type.includes('user')) addMessage('user', text);
        else if (type.includes('agent') || type.includes('assistant') || type === 'message') addMessage('assistant', text);
      }
    }
    if (!conversation.children.length) addEvent('Thread opened', 'Earlier command details may not be retained by Codex');
  }

  async function openThread(id) {
    try {
      const result = await request(`/api/threads/${encodeURIComponent(id)}`);
      const thread = result.thread || result;
      state.threadId = thread.id || id;
      localStorage.setItem('codex-webui-active-thread', state.threadId);
      state.cwd = thread.cwd || state.cwd;
      $('#thread-title').textContent = threadTitle(thread);
      $('#thread-path').textContent = state.cwd || 'Local workspace';
      $('#active-workspace').textContent = state.cwd || '';
      renderHistory(thread);
      syncThreadStatus(thread);
      const activeTurn = [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
      state.turnId = activeTurn?.id || null;
      setRunning(thread.status?.type === 'active' || Boolean(activeTurn));
      renderThreads();
      $('#sidebar').classList.remove('open');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function newThread() {
    state.threadId = null;
    localStorage.removeItem('codex-webui-active-thread');
    state.turnId = null;
    state.streamingNode = null;
    setRunning(false);
    $('#conversation').replaceChildren();
    $('#conversation').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#thread-title').textContent = 'New thread';
    state.cwd = $('#workspace-select').value || state.cwd;
    $('#thread-path').textContent = state.cwd || 'Choose a workspace to begin';
    $('#active-workspace').textContent = state.cwd || '';
    renderThreads();
    $('#message').focus();
    $('#sidebar').classList.remove('open');
  }

  async function ensureThread() {
    if (state.threadId) return state.threadId;
    const result = await request('/api/threads', {
      method: 'POST',
      body: JSON.stringify({ cwd: state.cwd || $('#workspace-select').value }),
    });
    const thread = result.thread || result;
    state.threadId = thread.id;
    if (!state.threadId) throw new Error('Codex did not return a thread ID');
    localStorage.setItem('codex-webui-active-thread', state.threadId);
    $('#thread-path').textContent = state.cwd;
    return state.threadId;
  }

  async function sendMessage(text) {
    const cleaned = text.trim();
    if (!cleaned || state.running) return;
    try {
      const threadId = await ensureThread();
      addMessage('user', cleaned);
      if ($('#thread-title').textContent === 'New thread') $('#thread-title').textContent = cleaned.slice(0, 70);
      setRunning(true);
      state.streamingNode = null;
      const result = await request(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: cleaned, cwd: state.cwd, effort: $('#effort').value || null }),
      });
      state.turnId = result.turn?.id || result.id || state.turnId;
      setTimeout(loadThreads, 1200);
    } catch (error) {
      setRunning(false);
      toast(error.message, 'error');
    }
  }

  function summarizeApproval(requestMessage) {
    const params = requestMessage.params || {};
    if (requestMessage.method.includes('commandExecution')) {
      const command = params.command || params.commandLine || params.cmd || params.reason || 'Codex wants to execute a command.';
      return { title: 'Allow command execution?', summary: Array.isArray(command) ? command.join(' ') : String(command) };
    }
    if (requestMessage.method.includes('fileChange')) {
      return { title: 'Allow file changes?', summary: params.reason || params.grantRoot || 'Codex wants to modify files in this workspace.' };
    }
    return { title: 'Codex needs your input', summary: requestMessage.method };
  }

  function showApproval(requestMessage) {
    state.pendingApproval = requestMessage;
    const summary = summarizeApproval(requestMessage);
    $('#approval-title').textContent = summary.title;
    $('#approval-summary').textContent = summary.summary;
    $('#approval-details').textContent = JSON.stringify(requestMessage.params, null, 2);
    $('#approval-drawer').classList.remove('hidden');
  }

  async function decideApproval(decision) {
    if (!state.pendingApproval) return;
    const pending = state.pendingApproval;
    try {
      await request(`/api/requests/${encodeURIComponent(pending.id)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      state.pendingApproval = null;
      $('#approval-drawer').classList.add('hidden');
      addEvent(decision.startsWith('accept') ? 'Action approved' : 'Action denied');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function handleCodexEvent(message) {
    const method = message.method || '';
    const params = message.params || {};
    const eventThreadId = params.threadId || params.thread?.id || params.turn?.threadId;
    if (method === 'thread/status/changed' && params.threadId) {
      if (params.status?.type === 'active') state.activeThreadIds.add(params.threadId);
      else state.activeThreadIds.delete(params.threadId);
      const listed = state.threads.find((thread) => thread.id === params.threadId);
      if (listed) listed.status = params.status;
      renderThreads();
      updateRunStatus();
      if (params.threadId === state.threadId) {
        const running = params.status?.type === 'active';
        state.running = running;
        $('#interrupt').classList.toggle('hidden', !running);
        $('.send-button').disabled = running;
      }
    }
    if (method === 'turn/started' && eventThreadId) {
      state.activeThreadIds.add(eventThreadId);
      renderThreads();
      updateRunStatus();
    }
    if (method === 'turn/completed' && eventThreadId) {
      state.activeThreadIds.delete(eventThreadId);
      renderThreads();
      updateRunStatus();
    }
    if (eventThreadId && state.threadId && eventThreadId !== state.threadId) return;
    if (method === 'turn/started') {
      state.turnId = params.turn?.id || params.turnId;
      setRunning(true);
    } else if (method === 'item/agentMessage/delta') {
      if (!state.streamingNode) addMessage('assistant', '', true);
      state.streamingNode.textContent += params.delta || '';
      $('#conversation').scrollTop = $('#conversation').scrollHeight;
    } else if (method === 'item/started') {
      const item = params.item || {};
      const type = String(item.type || 'work').replace(/([a-z])([A-Z])/g, '$1 $2');
      if (!String(item.type || '').toLowerCase().includes('agentmessage')) addEvent(`Started ${type}`);
    } else if (method === 'item/completed') {
      const item = params.item || {};
      const type = String(item.type || '').toLowerCase();
      if ((type.includes('agentmessage') || type.includes('assistant')) && !state.streamingNode) {
        const text = extractText(item);
        if (text) addMessage('assistant', text);
      }
      if (type.includes('command')) addEvent('Command completed', item.exitCode === undefined ? '' : `exit ${item.exitCode}`);
    } else if (method === 'turn/completed') {
      setRunning(false);
      state.streamingNode = null;
      state.turnId = null;
      loadThreads();
    } else if (method === 'error') {
      toast(params.error?.message || params.message || 'Codex reported an error', 'error');
    }
  }

  function connectEvents() {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = ({ data }) => {
      const payload = JSON.parse(data);
      if (payload.type === 'connected') {
        state.activeThreadIds = new Set((payload.activeThreads || []).map((active) => active.threadId));
        renderThreads();
        updateRunStatus();
        for (const pending of payload.pendingRequests || []) showApproval(pending);
      } else if (payload.type === 'server_request') showApproval(payload.request);
      else if (payload.type === 'codex_event') handleCodexEvent(payload.event);
      else if (payload.type === 'bridge_error') toast(payload.message, 'error');
    };
  }

  async function initialize() {
    try {
      const [session, workspaces] = await Promise.all([request('/api/session'), request('/api/workspaces')]);
      const select = $('#workspace-select');
      for (const workspace of workspaces.workspaces) {
        const option = document.createElement('option');
        option.value = workspace.path;
        option.textContent = workspace.name;
        select.append(option);
      }
      const preferred = workspaces.workspaces.find((workspace) => workspace.name === 'media-tool') || workspaces.workspaces[0];
      select.value = preferred.path;
      state.cwd = preferred.path;
      $('#active-workspace').textContent = state.cwd;
      $('#thread-path').textContent = state.cwd;
      await request('/api/status');
      setConnected(true);
      connectEvents();
      await loadThreads();
      const savedThread = localStorage.getItem('codex-webui-active-thread');
      const resumable = state.threads.find((thread) => thread.id === savedThread)
        || state.threads.find((thread) => state.activeThreadIds.has(thread.id));
      if (resumable) await openThread(resumable.id);
    } catch (error) {
      setConnected(false, 'Connection failed');
      toast(error.message, 'error');
    }
  }

  $('#composer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#message');
    const text = input.value;
    input.value = '';
    input.style.height = '';
    sendMessage(text);
  });
  $('#message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer-form').requestSubmit();
    }
  });
  $('#message').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 190)}px`;
  });
  $('#workspace-select').addEventListener('change', (event) => {
    state.cwd = event.target.value;
    $('#thread-path').textContent = state.cwd;
    $('#active-workspace').textContent = state.cwd;
  });
  $('#new-thread').addEventListener('click', newThread);
  $('#refresh-threads').addEventListener('click', loadThreads);
  $('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
  $('#close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#logout').addEventListener('click', async () => {
    await request('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/login.html';
  });
  $('#interrupt').addEventListener('click', async () => {
    if (!state.threadId || !state.turnId) return;
    try {
      await request(`/api/threads/${encodeURIComponent(state.threadId)}/turns/${encodeURIComponent(state.turnId)}/interrupt`, { method: 'POST', body: '{}' });
      setRunning(false);
      addEvent('Turn interrupted');
    } catch (error) { toast(error.message, 'error'); }
  });
  $$('.suggestions button').forEach((button) => button.addEventListener('click', () => sendMessage(button.dataset.prompt)));
  $$('.approval-actions button').forEach((button) => button.addEventListener('click', () => decideApproval(button.dataset.decision)));
  initialize();
}
