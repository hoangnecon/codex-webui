'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Keep the app shell sized to the *visible* viewport (not layout 100vh). */
function syncAppHeight() {
  const viewport = window.visualViewport;
  const height = Math.round((viewport && viewport.height) || window.innerHeight || 0);
  const width = Math.round((viewport && viewport.width) || window.innerWidth || 0);
  const style = document.documentElement.style;
  if (height > 0) {
    style.setProperty('--app-height', `${height}px`);
  }
  if (width > 0) style.setProperty('--app-width', `${width}px`);
  style.setProperty('--app-top', `${Math.round((viewport && viewport.offsetTop) || 0)}px`);
  style.setProperty('--app-left', `${Math.round((viewport && viewport.offsetLeft) || 0)}px`);
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', syncAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight);
  window.visualViewport.addEventListener('scroll', syncAppHeight);
}

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
    streamingItemId: null,
    pendingAssistantText: '',
    pendingApproval: null,
    threads: [],
    activeThreadIds: new Set(),
    attachments: [],
    followOutput: true,
    activityEntries: new Map(),
    currentPlan: [],
    currentPlanExplanation: '',
    eventSource: null,
    historyFingerprint: '',
    resyncTimer: null,
    resyncInFlight: false,
    resyncPending: null,
    catchupTimers: [],
    lastEventAt: 0,
    awaitingTurn: false,
    optimisticUsers: [],
    sessionTokens: 0,
    lastTurnTokens: 0,
    providerUsageLabel: '',
    accountRateLimits: null,
    prefs: null,
    amtStatus: null,
    reconnectEvents: [],
    messageQueue: [],
    stagedMessage: null,
    commandIndex: 0,
  };

  const PREFS_KEY = 'codex-webui-prefs-v1';
  const QUEUE_KEY = 'codex-webui-message-queue-v1';
  const DEFAULT_PREFS = {
    defaultEffort: '',
    systemPrompt: '',
    systemPromptByWorkspace: {},
    autoScroll: true,
    autoActivity: true,
    density: 'comfortable',
    theme: 'dark',
    accent: 'green',
    amtToolsEnabled: false,
    notifyOnComplete: false,
    permissionMode: 'moderate',
  };
  const CLI_ONLY = 'Available in the terminal CLI; its TUI flow is not exposed by app-server.';
  const WEBUI_COMMANDS = [
    { name: 'new', description: 'Start a new thread', action: () => newThread() },
    { name: 'clear', description: 'Start a fresh thread (WebUI equivalent)', action: () => newThread() },
    { name: 'compact', description: 'Compact this thread to free context', threadAction: 'compact' },
    { name: 'review', description: 'Review uncommitted working-tree changes', threadAction: 'review' },
    { name: 'rename', description: 'Rename the current thread', action: renameCurrentThread },
    { name: 'fork', description: 'Fork the current thread', action: forkCurrentThread },
    { name: 'archive', description: 'Archive the current thread', action: archiveCurrentThread },
    { name: 'copy', description: 'Copy the latest Codex reply', action: () => copyLastAssistant() },
    { name: 'mention', description: 'Open files and images to attach', action: () => openGallery() },
    { name: 'permissions', description: 'Change approval and sandbox permissions', action: () => openPrefsModal() },
    { name: 'status', description: 'Show session status and usage', action: showSessionStatus },
    { name: 'usage', description: 'Refresh and show account usage', action: showAccountUsage },
    { name: 'stop', description: 'Stop the active WebUI turn', action: () => $('#interrupt').click() },
    { name: 'clean', description: 'Alias for /stop in the terminal CLI', action: () => $('#interrupt').click() },
    { name: 'files', description: 'Open WebUI files and images', action: () => openGallery(), webui: true },
    { name: 'prefs', description: 'Open WebUI preferences', action: () => openPrefsModal(), webui: true },
    { name: 'export', description: 'Export this chat as Markdown', action: () => exportThreadMarkdown(), webui: true },
    { name: 'model', description: 'Choose the active model and reasoning effort', unavailable: CLI_ONLY },
    { name: 'fast', description: 'Toggle the Fast service tier', unavailable: CLI_ONLY },
    { name: 'personality', description: 'Choose a response personality', unavailable: CLI_ONLY },
    { name: 'plan', description: 'Switch the composer to plan mode', unavailable: CLI_ONLY },
    { name: 'goal', description: 'Set or manage a persistent task goal', unavailable: CLI_ONLY },
    { name: 'diff', description: 'Open the interactive Git diff viewer', unavailable: CLI_ONLY },
    { name: 'init', description: 'Generate an AGENTS.md scaffold', unavailable: CLI_ONLY },
    { name: 'mcp', description: 'Inspect configured MCP tools', unavailable: CLI_ONLY },
    { name: 'apps', description: 'Browse apps and insert an app mention', unavailable: CLI_ONLY },
    { name: 'plugins', description: 'Browse and manage plugins', unavailable: CLI_ONLY },
    { name: 'skills', description: 'Browse and select skills', unavailable: CLI_ONLY },
    { name: 'hooks', description: 'Inspect and manage lifecycle hooks', unavailable: CLI_ONLY },
    { name: 'memories', description: 'Configure memory behavior', unavailable: CLI_ONLY },
    { name: 'approve', description: 'Retry an auto-review denial', unavailable: CLI_ONLY },
    { name: 'agent', description: 'Switch active agent threads', unavailable: CLI_ONLY },
    { name: 'subagents', description: 'Alias for /agent', unavailable: CLI_ONLY },
    { name: 'side', description: 'Start an ephemeral side chat', unavailable: CLI_ONLY },
    { name: 'btw', description: 'Alias for /side', unavailable: CLI_ONLY },
    { name: 'resume', description: 'Resume a saved chat', unavailable: 'Use the WebUI thread list instead.' },
    { name: 'ide', description: 'Include current IDE context', unavailable: CLI_ONLY },
    { name: 'ps', description: 'Inspect background terminals', unavailable: CLI_ONLY },
    { name: 'experimental', description: 'Toggle experimental features', unavailable: CLI_ONLY },
    { name: 'import', description: 'Import Claude Code configuration', unavailable: CLI_ONLY },
    { name: 'feedback', description: 'Send diagnostics and feedback', unavailable: CLI_ONLY },
    { name: 'debug-config', description: 'Inspect effective configuration layers', unavailable: CLI_ONLY },
    { name: 'logout', description: 'Sign out of Codex credentials', unavailable: 'Use the terminal CLI; WebUI Sign out only closes this browser session.' },
    { name: 'delete', description: 'Permanently delete the current session', unavailable: 'Not exposed in WebUI because deletion is permanent.' },
    { name: 'quit', description: 'Exit the terminal CLI', unavailable: 'Not applicable to a browser tab.' },
    { name: 'exit', description: 'Alias for /quit', unavailable: 'Not applicable to a browser tab.' },
    { name: 'app', description: 'Continue in the desktop app', unavailable: CLI_ONLY },
    { name: 'raw', description: 'Toggle raw terminal scrollback', unavailable: CLI_ONLY },
    { name: 'vim', description: 'Toggle terminal composer Vim mode', unavailable: CLI_ONLY },
    { name: 'keymap', description: 'Remap terminal shortcuts', unavailable: CLI_ONLY },
    { name: 'statusline', description: 'Configure terminal status-line fields', unavailable: CLI_ONLY },
    { name: 'title', description: 'Configure the terminal title', unavailable: CLI_ONLY },
    { name: 'theme', description: 'Choose a terminal syntax theme', unavailable: CLI_ONLY },
    { name: 'pets', description: 'Choose a terminal pet', unavailable: CLI_ONLY },
    { name: 'pet', description: 'Alias for /pets', unavailable: CLI_ONLY },
    { name: 'setup-default-sandbox', description: 'Set up the Windows elevated sandbox', unavailable: CLI_ONLY },
    { name: 'sandbox-add-read-dir', description: 'Grant Windows sandbox read access', unavailable: CLI_ONLY },
  ];

  async function runThreadAction(action, body = {}) {
    if (!state.threadId) throw new Error('Open or start a thread first');
    return request(`/api/threads/${encodeURIComponent(state.threadId)}/commands/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async function renameCurrentThread() {
    if (!state.threadId) throw new Error('Open or start a thread first');
    const current = $('#thread-title').textContent === 'New thread' ? '' : $('#thread-title').textContent;
    const name = window.prompt('Rename this thread', current);
    if (name == null) return;
    await runThreadAction('rename', { name });
    $('#thread-title').textContent = name.trim();
    await loadThreads();
  }

  async function forkCurrentThread() {
    const result = await runThreadAction('fork');
    const id = result.thread?.id || result.threadId;
    await loadThreads();
    if (id) await openThread(id);
    toast('Thread forked');
  }

  async function archiveCurrentThread() {
    if (!window.confirm('Archive this thread? You can restore it with the Codex CLI.')) return;
    await runThreadAction('archive');
    newThread();
    await loadThreads();
    toast('Thread archived');
  }

  function showSessionStatus() {
    const mode = $('#permission-pill')?.textContent || '—';
    const tokens = $('#session-tokens')?.textContent || 'Chat · —';
    const provider = $('#provider-usage')?.textContent || 'Model · —';
    toast(`${state.running ? 'Working' : 'Ready'} · ${mode} · ${tokens} · ${provider}`);
  }

  async function showAccountUsage() {
    await refreshAccountRateLimits();
    showSessionStatus();
  }

  function hideCommands() {
    $('#command-menu').classList.add('hidden');
    $('#command-menu').replaceChildren();
    state.commandIndex = 0;
  }

  async function runCommand(command) {
    const input = $('#message');
    input.value = '';
    input.style.height = '';
    saveDraft();
    hideCommands();
    if (command.unavailable) {
      toast(command.unavailable, 'error');
      return;
    }
    try {
      if (command.threadAction) {
        await runThreadAction(command.threadAction);
        toast(command.threadAction === 'compact' ? 'Compaction started' : 'Review started');
      } else {
        await command.action();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function showCommands(filter = '') {
    const needle = filter.replace(/^\//, '').toLowerCase();
    const matches = WEBUI_COMMANDS
      .filter((command) => (!command.available || command.available())
        && (!needle || command.name.includes(needle) || command.description.toLowerCase().includes(needle)));
    const menu = $('#command-menu');
    menu.replaceChildren();
    if (!matches.length) return menu.classList.add('hidden');
    menu.classList.remove('hidden');
    state.commandIndex = 0;
    matches.forEach((command, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-item${index === 0 ? ' active' : ''}${command.unavailable ? ' unavailable' : ''}`;
      button.dataset.name = command.name;
      const name = document.createElement('strong');
      name.textContent = `/${command.name}`;
      const description = document.createElement('span');
      description.textContent = `${command.description}${command.unavailable ? ' · CLI only' : ''}`;
      button.append(name, description);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        runCommand(command);
      });
      menu.append(button);
    });
  }

  function loadPrefs() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; }
    catch { stored = {}; }
    state.prefs = {
      ...DEFAULT_PREFS,
      ...stored,
      systemPromptByWorkspace: {
        ...DEFAULT_PREFS.systemPromptByWorkspace,
        ...(stored.systemPromptByWorkspace || {}),
      },
    };
    return state.prefs;
  }

  function savePrefs(partial = {}) {
    state.prefs = { ...loadPrefs(), ...partial };
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    applyPrefsToUi();
    return state.prefs;
  }

  function saveMessageQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(state.messageQueue));
    renderMessageQueue();
  }
  function loadMessageQueue() {
    try { state.messageQueue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; }
    catch { state.messageQueue = []; }
    renderMessageQueue();
  }
  function renderMessageQueue() {
    const wrap = $('#message-queue');
    if (!wrap) return;
    const current = state.messageQueue.filter((item) => !item.threadId || item.threadId === state.threadId);
    wrap.replaceChildren();
    wrap.classList.toggle('hidden', !current.length);
    for (const item of current) {
      const row = document.createElement('div'); row.className = 'queued-message';
      const label = document.createElement('span'); label.textContent = item.text || item.attachments?.map((file) => file.name).join(', ') || 'Attachment';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Remove queued message';
      remove.addEventListener('click', () => { state.messageQueue = state.messageQueue.filter((queued) => queued.id !== item.id); saveMessageQueue(); });
      row.append(label, remove); wrap.append(row);
    }
  }
  function enqueueStaged({ interrupt = false } = {}) {
    if (!state.stagedMessage) return;
    state.messageQueue.push({ ...state.stagedMessage, id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, threadId: state.threadId });
    state.stagedMessage = null;
    clearAttachments();
    $('#queue-choice').classList.add('hidden');
    saveMessageQueue();
    if (interrupt) $('#interrupt').click();
  }
  function flushMessageQueue() {
    if (state.running) return;
    const index = state.messageQueue.findIndex((item) => !item.threadId || item.threadId === state.threadId);
    if (index < 0) return;
    const [next] = state.messageQueue.splice(index, 1);
    saveMessageQueue();
    state.attachments = next.attachments || [];
    renderAttachments();
    setTimeout(() => sendMessage(next.text || ''), 250);
  }

  function workspaceSystemPrompt() {
    const prefs = state.prefs || loadPrefs();
    const cwd = state.cwd || '';
    if (cwd && prefs.systemPromptByWorkspace && prefs.systemPromptByWorkspace[cwd] != null) {
      return prefs.systemPromptByWorkspace[cwd];
    }
    return prefs.systemPrompt || '';
  }

  function setWorkspaceSystemPrompt(text) {
    const prefs = loadPrefs();
    const cwd = state.cwd || '';
    const map = { ...(prefs.systemPromptByWorkspace || {}) };
    if (cwd) map[cwd] = text;
    savePrefs({ systemPrompt: text, systemPromptByWorkspace: map });
  }

  function applyPrefsToUi() {
    const prefs = state.prefs || loadPrefs();
    document.body.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    document.body.dataset.accent = ['green', 'blue', 'purple', 'gold'].includes(prefs.accent) ? prefs.accent : 'green';
    document.body.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
    state.followOutput = prefs.autoScroll !== false;
    if ($('#effort') && prefs.defaultEffort && !$('#effort').value) {
      $('#effort').value = prefs.defaultEffort;
    }
    if ($('#pref-default-effort')) $('#pref-default-effort').value = prefs.defaultEffort || '';
    if ($('#pref-system-prompt')) $('#pref-system-prompt').value = workspaceSystemPrompt();
    if ($('#pref-auto-scroll')) $('#pref-auto-scroll').checked = prefs.autoScroll !== false;
    if ($('#pref-auto-activity')) $('#pref-auto-activity').checked = prefs.autoActivity !== false;
    if ($('#pref-density')) $('#pref-density').value = prefs.density || 'comfortable';
    if ($('#pref-theme')) $('#pref-theme').value = prefs.theme || 'dark';
    if ($('#pref-accent')) $('#pref-accent').value = prefs.accent || 'green';
    if ($('#pref-amt-tools-enabled')) $('#pref-amt-tools-enabled').checked = Boolean(prefs.amtToolsEnabled);
    if ($('#pref-notify-complete')) $('#pref-notify-complete').checked = Boolean(prefs.notifyOnComplete);
    if ($('#pref-permission-mode')) $('#pref-permission-mode').value = prefs.permissionMode || 'moderate';
    const labels = { restrictive: 'Restrictive', moderate: 'Moderate', yolo: 'YOLO' };
    if ($('#permission-pill')) $('#permission-pill').textContent = labels[prefs.permissionMode] || labels.moderate;
    if ($('#permission-note')) $('#permission-note').textContent = `${labels[prefs.permissionMode] || labels.moderate} permissions`;
  }

  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${Math.round(num / 1000)}k`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  function windowLabel(window) {
    const mins = Number(window?.windowDurationMins);
    if (!Number.isFinite(mins) || mins <= 0) return 'limit';
    if (mins >= 10080 - 120) return 'week';
    if (mins >= 1440 - 30) return 'day';
    if (mins >= 300 - 15) return '5h';
    if (mins >= 60) return `${Math.round(mins / 60)}h`;
    return `${mins}m`;
  }

  function formatResetAt(resetsAt) {
    if (resetsAt == null) return '';
    let ms = Number(resetsAt);
    if (!Number.isFinite(ms)) return '';
    // Unix seconds vs milliseconds
    if (ms < 1e12) ms *= 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatRateWindow(window) {
    if (!window || window.usedPercent == null) return null;
    const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
    const left = Math.max(0, 100 - used);
    const label = windowLabel(window);
    return `${left}% ${label} left`;
  }

  function applyAccountRateLimits(payload) {
    if (!payload || typeof payload !== 'object') return;
    // Full read response or sparse update with rateLimits / primary/secondary
    const snap = payload.rateLimits || payload;
    state.accountRateLimits = {
      ...(state.accountRateLimits || {}),
      ...snap,
      primary: snap.primary ?? state.accountRateLimits?.primary ?? null,
      secondary: snap.secondary ?? state.accountRateLimits?.secondary ?? null,
      credits: snap.credits ?? state.accountRateLimits?.credits ?? null,
      planType: snap.planType ?? state.accountRateLimits?.planType ?? null,
      limitName: snap.limitName ?? state.accountRateLimits?.limitName ?? null,
    };
    const bits = [];
    const primary = formatRateWindow(state.accountRateLimits.primary);
    const secondary = formatRateWindow(state.accountRateLimits.secondary);
    if (primary) bits.push(primary);
    if (secondary) bits.push(secondary);
    const credits = state.accountRateLimits.credits;
    if (credits?.unlimited) bits.push('unlimited credits');
    else if (credits?.balance != null && credits.balance !== '') bits.push(`${credits.balance} cr`);
    if (bits.length) {
      state.providerUsageLabel = bits.join(' · ');
    }
    updateUsageStrip();
  }

  async function refreshAccountRateLimits() {
    try {
      const result = await request('/api/account/rate-limits');
      if (result?.ok === false) return null;
      applyAccountRateLimits(result);
      return result;
    } catch (error) {
      // Not always available (logged out of ChatGPT, older codex, etc.)
      console.warn('rate limits', error.message);
      return null;
    }
  }

  function updateUsageStrip() {
    const sessionEl = $('#session-tokens');
    const providerEl = $('#provider-usage');
    const amtEl = $('#amt-usage');
    if (sessionEl) {
      sessionEl.textContent = state.sessionTokens
        ? `Chat · ${formatTokens(state.sessionTokens)} tokens`
        : 'Chat · —';
    }
    if (providerEl) {
      const hasLimits = Boolean(state.providerUsageLabel);
      providerEl.textContent = hasLimits
        ? `Model · ${state.providerUsageLabel}`
        : 'Model · session only';
      providerEl.classList.toggle('ok', hasLimits);
      providerEl.classList.toggle('warn', hasLimits && /\b([0-9]|1[0-4])%\b/.test(state.providerUsageLabel));
      const rl = state.accountRateLimits;
      const tips = [];
      if (rl?.primary) {
        const reset = formatResetAt(rl.primary.resetsAt);
        tips.push(`${windowLabel(rl.primary)}: ${Math.max(0, 100 - (rl.primary.usedPercent || 0))}% left${reset ? ` (resets ${reset})` : ''}`);
      }
      if (rl?.secondary) {
        const reset = formatResetAt(rl.secondary.resetsAt);
        tips.push(`${windowLabel(rl.secondary)}: ${Math.max(0, 100 - (rl.secondary.usedPercent || 0))}% left${reset ? ` (resets ${reset})` : ''}`);
      }
      providerEl.title = tips.length
        ? tips.join(' · ')
        : 'Codex account weekly/rolling limits when available from account/rateLimits';
    }
    if (amtEl) {
      const s = state.amtStatus;
      if (s && s.connected) {
        amtEl.classList.remove('hidden');
        const rem = s.usage?.remaining != null ? s.usage.remaining : '—';
        const lim = s.usage?.limit != null ? s.usage.limit : '—';
        const credits = s.credit_balance?.total ?? s.usage_credits ?? '—';
        amtEl.textContent = `AMT · ${rem}/${lim} today · ${credits} cr`;
        amtEl.classList.toggle('warn', Number(s.usage?.remaining) === 0);
        amtEl.classList.toggle('ok', Number(s.usage?.remaining) > 0);
      } else {
        amtEl.classList.add('hidden');
      }
    }
  }

  function noteTokenUsage(usage, { cumulative = false } = {}) {
    if (!usage || typeof usage !== 'object') return;
    const nested = usage.total || usage;
    const total = Number(
      nested.totalTokens || nested.total_tokens || usage.totalTokens || usage.total_tokens || usage.used || 0
    );
    const input = Number(nested.inputTokens || nested.input_tokens || 0);
    const output = Number(nested.outputTokens || nested.output_tokens || 0);
    let amount = total;
    if (!amount && (input || output)) amount = input + output;
    if (amount) {
      if (cumulative) state.sessionTokens = Math.max(state.sessionTokens, amount);
      else if (amount !== state.lastTurnTokens || state.sessionTokens === 0) {
        state.lastTurnTokens = amount;
        state.sessionTokens += amount;
      }
    }
    // Don't overwrite account weekly limits with sparse token fields.
    updateUsageStrip();
    if ($('#token-usage')) $('#token-usage').textContent = `${formatTokens(state.sessionTokens)} this chat`;
  }

  function resetSessionUsage() {
    state.sessionTokens = 0;
    state.lastTurnTokens = 0;
    // Keep accountRateLimits / providerUsageLabel — those are account-level.
    updateUsageStrip();
    if ($('#token-usage')) $('#token-usage').textContent = '';
  }

  function activityTime() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function resetPlan() {
    state.currentPlan = [];
    state.currentPlanExplanation = '';
    $('#plan-panel').classList.add('hidden');
    $('#plan-list').replaceChildren();
    $('#plan-explanation').textContent = '';
  }

  function resetActivity({ preservePlan = true } = {}) {
    state.activityEntries.clear();
    $('#activity-feed').replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Activity will appear here as Codex reasons, uses tools, edits files, and runs checks.';
    $('#activity-feed').append(empty);
    if (!preservePlan) resetPlan();
    $('#token-usage').textContent = '';
  }

  function ensureActivityEntry(id, title, kind = '') {
    const key = id || `${kind}-${Date.now()}-${Math.random()}`;
    let entry = state.activityEntries.get(key);
    if (entry) return entry;
    $('#activity-feed .activity-empty')?.remove();
    const node = document.createElement('article');
    node.className = `activity-entry ${kind} running`;
    const header = document.createElement('header');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const time = document.createElement('time');
    time.textContent = activityTime();
    const detail = document.createElement(kind === 'reasoning' ? 'p' : 'pre');
    header.append(heading, time);
    node.append(header, detail);
    $('#activity-feed').append(node);
    entry = { node, heading, detail };
    state.activityEntries.set(key, entry);
    $('#activity-feed').scrollTop = $('#activity-feed').scrollHeight;
    return entry;
  }

  function updateActivity(id, { title, detail, append, kind = '', status = 'running' }) {
    const entry = ensureActivityEntry(id, title || 'Working', kind);
    if (title) entry.heading.textContent = title;
    if (detail !== undefined) entry.detail.textContent = String(detail).slice(-12000);
    if (append) entry.detail.textContent = `${entry.detail.textContent}${append}`.slice(-12000);
    entry.node.classList.remove('running', 'done', 'error');
    entry.node.classList.add(status);
    $('#activity-feed').scrollTop = $('#activity-feed').scrollHeight;
  }

  function normalizePlanStatus(status) {
    const value = String(status || 'pending').toLowerCase().replace(/[_\s-]/g, '');
    if (['completed', 'complete', 'done'].includes(value)) return 'completed';
    if (['inprogress', 'active', 'current', 'running'].includes(value)) return 'in-progress';
    return 'pending';
  }

  function renderPlan(plan = [], explanation = '') {
    if (!plan.length) return;
    state.currentPlan = plan.map((item) => ({ ...item }));
    state.currentPlanExplanation = explanation || state.currentPlanExplanation || '';
    $('#plan-panel').classList.remove('hidden');
    const normalized = plan.map((item) => normalizePlanStatus(item.status));
    const complete = normalized.filter((status) => status === 'completed').length;
    const currentIndex = normalized.indexOf('in-progress');
    $('#plan-explanation').textContent = explanation || (currentIndex >= 0
      ? `${complete} of ${plan.length} complete · Step ${currentIndex + 1} is active`
      : `${complete} of ${plan.length} complete`);
    const list = $('#plan-list');
    list.replaceChildren();
    for (const [index, item] of plan.entries()) {
      const status = normalized[index];
      const row = document.createElement('li');
      row.className = `plan-step ${status}`;
      row.setAttribute('aria-current', status === 'in-progress' ? 'step' : 'false');
      const marker = document.createElement('span');
      marker.className = 'plan-marker';
      marker.textContent = status === 'completed' ? '✓' : status === 'in-progress' ? '→' : '○';
      const copy = document.createElement('span');
      copy.className = 'plan-copy';
      const text = document.createElement('strong');
      text.textContent = item.step || item.content || item.title || `Step ${index + 1}`;
      const label = document.createElement('small');
      label.textContent = status === 'completed' ? 'Done' : status === 'in-progress' ? 'Now' : 'Next';
      copy.append(text, label);
      row.append(marker, copy);
      list.append(row);
    }
  }

  function describeChanges(changes = []) {
    return changes.map((change) => {
      const file = change.path || change.filePath || change.file || 'file';
      const action = change.type || change.kind || 'updated';
      return `${action}: ${file}`;
    }).join('\n');
  }

  function renderActivityItem(item, completed = false) {
    if (!item?.id) return;
    const status = completed ? (item.status === 'failed' ? 'error' : 'done') : 'running';
    if (item.type === 'reasoning') {
      updateActivity(item.id, { title: 'Reasoning summary', detail: (item.summary || []).join('\n'), kind: 'reasoning', status });
    } else if (item.type === 'plan') {
      updateActivity(item.id, { title: 'Planning work', detail: item.text || '', kind: 'reasoning', status });
    } else if (item.type === 'commandExecution') {
      updateActivity(item.id, { title: item.command || 'Running command', detail: item.aggregatedOutput || '', status });
    } else if (item.type === 'fileChange') {
      updateActivity(item.id, { title: 'Editing files', detail: describeChanges(item.changes), status });
    } else if (item.type === 'mcpToolCall') {
      updateActivity(item.id, { title: `${item.server || 'MCP'} · ${item.tool || 'tool'}`, detail: JSON.stringify(item.arguments || {}, null, 2), status });
    } else if (item.type === 'webSearch') {
      updateActivity(item.id, { title: 'Searching the web', detail: item.query || '', status });
    } else if (!['agentMessage', 'userMessage'].includes(item.type)) {
      updateActivity(item.id, { title: String(item.type || 'Working').replace(/([a-z])([A-Z])/g, '$1 $2'), detail: '', status });
    }
  }

  function renderActivityHistory(thread) {
    resetActivity({ preservePlan: true });
    const latestTurn = (thread.turns || []).at(-1);
    if (!latestTurn) return;
    for (const item of latestTurn.items || []) renderActivityItem(item, item.status !== 'inProgress');
  }

  function nearConversationBottom() {
    const conversation = $('#conversation');
    return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  }

  function updateJumpButton() {
    $('#jump-latest').classList.toggle('hidden', nearConversationBottom() || $('#conversation').classList.contains('hidden'));
  }

  function scrollToLatest(behavior = 'auto') {
    state.followOutput = true;
    requestAnimationFrame(() => {
      const conversation = $('#conversation');
      conversation.scrollTo({ top: conversation.scrollHeight, behavior });
      requestAnimationFrame(updateJumpButton);
    });
  }

  function keepLatestVisibleWhileTyping() {
    const input = $('#message');
    let followDuringKeyboard = false;
    const restoreLatest = () => {
      if (document.activeElement === input && followDuringKeyboard) scrollToLatest();
    };
    input.addEventListener('pointerdown', () => {
      followDuringKeyboard = state.followOutput || nearConversationBottom();
    }, { passive: true });
    input.addEventListener('focus', () => {
      followDuringKeyboard = followDuringKeyboard || state.followOutput || nearConversationBottom();
      restoreLatest();
      setTimeout(restoreLatest, 150);
      setTimeout(restoreLatest, 350);
    });
    input.addEventListener('blur', () => {
      followDuringKeyboard = false;
    });
    window.visualViewport?.addEventListener('resize', restoreLatest);
    window.visualViewport?.addEventListener('scroll', restoreLatest);
  }

  keepLatestVisibleWhileTyping();

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
    $('.workspace').classList.toggle('has-activity', state.activeThreadIds.size > 0);
  }

  function setActivityOpen(open) {
    $('.workspace').classList.toggle('activity-open', open);
    $('#activity-toggle').classList.toggle('active', open);
    localStorage.setItem('codex-webui-activity-panel', open ? 'open' : 'closed');
  }

  function setRunning(running) {
    state.running = running;
    if (state.threadId) {
      if (running) state.activeThreadIds.add(state.threadId);
      else state.activeThreadIds.delete(state.threadId);
    }
    updateRunStatus();
    $('#interrupt').classList.toggle('hidden', !running);
    $('.send-button').disabled = false;
    $('.workspace').classList.toggle('has-activity', state.activeThreadIds.size > 0);
    $('#activity-state-label').textContent = running ? 'Working now' : 'Waiting for work';
  }

  function syncThreadStatus(thread) {
    const type = thread?.status?.type || thread?.status;
    const id = thread?.id || state.threadId;
    if (!id) return;
    if (type === 'active') state.activeThreadIds.add(id);
    else state.activeThreadIds.delete(id);
  }

  function threadTitle(thread) {
    return thread.title || thread.name || thread.preview || thread.firstUserMessage || 'Untitled thread';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function loadPinnedIds() {
    try { return new Set(JSON.parse(localStorage.getItem('codex-webui-pinned') || '[]')); }
    catch { return new Set(); }
  }
  function savePinnedIds(set) {
    localStorage.setItem('codex-webui-pinned', JSON.stringify([...set]));
  }
  function togglePin(id, event) {
    event.stopPropagation();
    const set = loadPinnedIds();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    savePinnedIds(set);
    renderThreads();
  }

  function updateFleetStrip() {
    const working = state.threads.filter((t) => state.activeThreadIds.has(t.id)).length;
    const needs = state.pendingApproval ? 1 : 0;
    const idle = Math.max(0, state.threads.length - working);
    if ($('#fleet-working')) $('#fleet-working').textContent = `${working} working`;
    if ($('#fleet-needs')) $('#fleet-needs').textContent = `${needs} need input`;
    if ($('#fleet-idle')) $('#fleet-idle').textContent = `${idle} idle`;
  }

  function renderThreads() {
    const list = $('#thread-list');
    list.replaceChildren();
    const query = ($('#session-search')?.value || '').trim().toLowerCase();
    let threads = [...state.threads];
    if (query) {
      threads = threads.filter((t) => {
        const hay = `${threadTitle(t)} ${t.cwd || ''} ${t.id || ''}`.toLowerCase();
        return hay.includes(query);
      });
    }
    const pinned = loadPinnedIds();
    threads.sort((a, b) => {
      const ap = pinned.has(a.id) ? 0 : 1;
      const bp = pinned.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const aw = state.activeThreadIds.has(a.id) ? 0 : 1;
      const bw = state.activeThreadIds.has(b.id) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return 0;
    });
    updateFleetStrip();
    if (!threads.length) {
      const empty = document.createElement('p');
      empty.className = 'thread-item';
      empty.textContent = query ? 'No matching threads' : 'No threads yet';
      list.append(empty);
      return;
    }
    for (const thread of threads) {
      const button = document.createElement('button');
      button.className = `thread-item${thread.id === state.threadId ? ' active' : ''}`;
      const row = document.createElement('div');
      row.className = 'item-row';
      const title = document.createElement('strong');
      title.textContent = threadTitle(thread);
      if (state.activeThreadIds.has(thread.id)) {
        const activity = document.createElement('i');
        activity.className = 'thread-activity';
        activity.title = 'Codex is working in this chat';
        title.append(activity);
      }
      const pin = document.createElement('span');
      pin.className = `pin-btn${pinned.has(thread.id) ? ' pinned' : ''}`;
      pin.textContent = pinned.has(thread.id) ? '★' : '☆';
      pin.title = pinned.has(thread.id) ? 'Unpin' : 'Pin';
      pin.addEventListener('click', (e) => togglePin(thread.id, e));
      row.append(title, pin);
      const meta = document.createElement('span');
      const status = state.activeThreadIds.has(thread.id) ? 'working' : 'idle';
      meta.textContent = [
        status,
        formatDate(thread.updatedAt || thread.updated_at || thread.createdAt || thread.created_at),
        thread.cwd ? String(thread.cwd).split('/').pop() : '',
      ].filter(Boolean).join(' · ');
      button.append(row, meta);
      button.addEventListener('click', () => openThread(thread.id));
      list.append(button);
    }
  }

  function draftKey() {
    return `codex-webui-draft:${state.threadId || 'new'}`;
  }
  function saveDraft() {
    const text = $('#message')?.value || '';
    try {
      if (text.trim()) localStorage.setItem(draftKey(), text);
      else localStorage.removeItem(draftKey());
    } catch { /* ignore */ }
  }
  function restoreDraft() {
    try {
      const text = localStorage.getItem(draftKey()) || '';
      if ($('#message') && text) {
        $('#message').value = text;
        $('#message').dispatchEvent(new Event('input'));
      }
    } catch { /* ignore */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
  }

  function notifyTurnComplete(title = 'Codex finished') {
    const prefs = state.prefs || loadPrefs();
    if (!prefs.notifyOnComplete) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body: $('#thread-title')?.textContent || 'Your turn is complete',
        });
      } catch { /* ignore */ }
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  function copyLastAssistant() {
    const nodes = $$('#conversation .message.assistant .message-body');
    const last = nodes[nodes.length - 1];
    const text = last?.innerText || last?.textContent || '';
    if (!text.trim()) {
      toast('No assistant message to copy', 'error');
      return;
    }
    navigator.clipboard.writeText(text).then(() => toast('Copied last reply')).catch(() => toast('Copy failed', 'error'));
  }

  function exportThreadMarkdown() {
    const parts = [`# ${$('#thread-title')?.textContent || 'Codex chat'}\n`];
    $$('#conversation .message').forEach((m) => {
      const role = m.classList.contains('user') ? 'You' : 'Codex';
      const body = m.querySelector('.message-body');
      const text = body?.innerText || body?.textContent || '';
      if (text.trim()) parts.push(`## ${role}\n\n${text.trim()}\n`);
    });
    if (parts.length < 2) {
      toast('Nothing to export', 'error');
      return;
    }
    const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `codex-chat-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported Markdown');
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

  const IMAGE_MARKDOWN = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
  const CODE_FENCE = /```([\w+-]*)\n([\s\S]*?)```/g;

  function localImageUrl(value) {
    if (typeof value !== 'string') return null;
    if (value.startsWith('data:image/')) return value;
    if (!value.startsWith('/')) return null;
    return `/api/image?path=${encodeURIComponent(value)}`;
  }

  function appendImage(container, source, alt = 'Generated image') {
    const url = localImageUrl(source);
    if (!url) return false;
    const link = document.createElement('a');
    link.className = 'message-image-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = url;
    image.alt = alt || 'Generated image';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      link.replaceWith(document.createTextNode(`[Image unavailable: ${alt || 'image'}]`));
    }, { once: true });
    link.append(image);
    container.append(link);
    return true;
  }

  function safeHref(href) {
    if (typeof href !== 'string') return null;
    const value = href.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
    return null;
  }

  function appendCodeBlock(container, lang, code) {
    const wrap = document.createElement('div');
    wrap.className = 'md-code-block';
    if (lang) {
      const label = document.createElement('div');
      label.className = 'md-code-lang';
      label.textContent = lang;
      wrap.append(label);
    }
    const pre = document.createElement('pre');
    pre.textContent = String(code || '').replace(/\n$/, '');
    wrap.append(pre);
    container.append(wrap);
  }

  function appendInlineMarkdown(parent, text) {
    if (!text) return;
    const re = /(!\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`\n]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;
    let cursor = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[1]) {
        const alt = match[2] || '';
        const src = match[3] || match[4];
        if (!appendImage(parent, src, alt)) parent.append(document.createTextNode(match[0]));
      } else if (match[5]) {
        const href = safeHref(match[7]);
        if (href) {
          const a = document.createElement('a');
          a.className = 'md-link';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = match[6];
          parent.append(a);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      } else if (match[8]) {
        const code = document.createElement('code');
        code.className = 'md-inline';
        code.textContent = match[9];
        parent.append(code);
      } else if (match[10] || match[12]) {
        const strong = document.createElement('strong');
        strong.textContent = match[11] || match[13];
        parent.append(strong);
      } else if (match[14] || match[16]) {
        const em = document.createElement('em');
        em.textContent = match[15] || match[17];
        parent.append(em);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function isBlockStart(line) {
    return /^(#{1,3}\s|```|~~~|[-*+]\s+|\d+\.\s+|>\s?|---+\s*$|\*\*\*+\s*$)/.test(line);
  }

  function renderMarkdownBlocks(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i += 1; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        container.append(document.createElement('hr'));
        i += 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (heading) {
        const level = Math.min(3, heading[1].length);
        const h = document.createElement(`h${level}`);
        h.className = `md-h md-h${level}`;
        appendInlineMarkdown(h, heading[2]);
        container.append(h);
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = document.createElement('blockquote');
        const chunks = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          chunks.push(lines[i].replace(/^>\s?/, ''));
          i += 1;
        }
        chunks.join('\n').split(/\n{2,}/).forEach((chunk) => {
          const p = document.createElement('p');
          chunk.split('\n').forEach((row, idx) => {
            if (idx) p.append(document.createElement('br'));
            appendInlineMarkdown(p, row);
          });
          quote.append(p);
        });
        container.append(quote);
        continue;
      }
      if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        const ordered = /^\d+\.\s+/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'md-list';
        const itemRe = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
        while (i < lines.length && itemRe.test(lines[i])) {
          const li = document.createElement('li');
          appendInlineMarkdown(li, lines[i].replace(itemRe, ''));
          list.append(li);
          i += 1;
        }
        container.append(list);
        continue;
      }
      const paraLines = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        paraLines.push(lines[i]);
        i += 1;
      }
      if (!paraLines.length) { i += 1; continue; }
      const p = document.createElement('p');
      paraLines.forEach((row, idx) => {
        if (idx) p.append(document.createElement('br'));
        appendInlineMarkdown(p, row);
      });
      container.append(p);
    }
  }

  function renderMessageContent(body, text, images = []) {
    body.classList.remove('streaming');
    body.replaceChildren();
    const value = text || '';
    let cursor = 0;
    const fenceRe = new RegExp(CODE_FENCE.source, 'g');
    let match;
    const segments = [];
    while ((match = fenceRe.exec(value))) {
      if (match.index > cursor) segments.push({ type: 'text', value: value.slice(cursor, match.index) });
      segments.push({ type: 'code', lang: match[1], value: match[2] });
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) segments.push({ type: 'text', value: value.slice(cursor) });
    if (!segments.length) segments.push({ type: 'text', value });

    for (const segment of segments) {
      if (segment.type === 'code') {
        appendCodeBlock(body, segment.lang, segment.value);
        continue;
      }
      renderMarkdownBlocks(body, segment.value);
    }
    if (!body.childNodes.length && value) {
      const p = document.createElement('p');
      appendInlineMarkdown(p, value);
      body.append(p);
    }
    for (const image of images) appendImage(body, image.source, image.alt);
  }

  function addMessage(role, text, streaming = false, images = []) {
    $('#empty-state').classList.add('hidden');
    $('#conversation').classList.remove('hidden');
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'Y' : 'C';
    const wrapper = document.createElement('div');
    wrapper.className = 'message-main';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'YOU' : 'CODEX';
    const body = document.createElement('div');
    body.className = 'message-body';
    if (streaming) {
      body.classList.add('streaming');
      body.textContent = text || '';
    } else {
      renderMessageContent(body, text, images);
    }
    wrapper.append(label, body);
    article.append(avatar, wrapper);
    $('#conversation').append(article);
    if (state.followOutput) scrollToLatest();
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
    if (state.followOutput) scrollToLatest();
  }

  function extractText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (value.type === 'image' || value.type === 'localImage') return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.outputText === 'string') return value.outputText;
    if (typeof value.output_text === 'string') return value.output_text;
    if (value.content !== undefined) return extractText(value.content);
    if (value.input !== undefined) return extractText(value.input);
    if (value.type === 'skill') return `[Skill: ${value.name || 'attached'}]`;
    if (value.type === 'mention') return `@${value.name || 'mention'}`;
    return '';
  }

  function extractImages(value, results = []) {
    if (Array.isArray(value)) {
      for (const item of value) extractImages(item, results);
      return results;
    }
    if (!value || typeof value !== 'object') return results;
    if (value.type === 'localImage' && typeof value.path === 'string') {
      results.push({ source: value.path, alt: value.name || 'Local image' });
      return results;
    }
    if (value.type === 'image') {
      const source = value.path || value.image_url || value.url || value.source;
      if (typeof source === 'string') results.push({ source, alt: value.alt || value.name || 'Generated image' });
      return results;
    }
    if (value.content !== undefined) extractImages(value.content, results);
    if (value.input !== undefined) extractImages(value.input, results);
    return results;
  }

  function historyFingerprint(thread) {
    const turns = thread?.turns || [];
    let sig = `t${turns.length}`;
    for (const turn of turns) {
      const items = turn.items || [];
      sig += `|${turn.id || ''}:${turn.status || ''}:${items.length}`;
      for (const item of items) {
        const text = extractText(item);
        sig += `:${item.type || ''}:${text.length}`;
      }
    }
    return sig;
  }

  function normalizeMsgText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
  }

  function diskHasUserMessage(thread, opt) {
    const want = normalizeMsgText(opt.text);
    if (!want) return false;
    for (const turn of thread.turns || []) {
      for (const item of turn.items || []) {
        const type = String(item.type || '').toLowerCase();
        if (!type.includes('user')) continue;
        if (normalizeMsgText(extractText(item)) === want) return true;
      }
    }
    return false;
  }

  function pruneOptimisticUsers(thread) {
    state.optimisticUsers = (state.optimisticUsers || []).filter((opt) => !diskHasUserMessage(thread, opt));
  }

  function reapplyOptimisticUsers() {
    for (const opt of state.optimisticUsers || []) {
      addMessage('user', opt.text, false);
    }
  }

  function renderHistory(thread) {
    const conversation = $('#conversation');
    conversation.replaceChildren();
    state.streamingNode = null;
    state.streamingItemId = null;
    const turns = thread.turns || [];
    for (const turn of turns) {
      for (const item of turn.items || []) {
        const type = String(item.type || '').toLowerCase();
        const text = extractText(item);
        const images = extractImages(item);
        if (!text && !images.length) continue;
        if (type.includes('user')) addMessage('user', text, false, images);
        else if (type.includes('agent') || type.includes('assistant') || type === 'message') addMessage('assistant', text, false, images);
      }
    }
    reapplyOptimisticUsers();
    state.historyFingerprint = historyFingerprint(thread);
    if (!conversation.children.length) addEvent('Thread opened', 'Earlier command details may not be retained by Codex');
    if (state.followOutput) scrollToLatest();
    else updateJumpButton();
  }

  function finalizeStreamingMessage() {
    if (!state.streamingNode) return;
    const live = state.streamingNode.textContent || '';
    renderMessageContent(state.streamingNode, live);
    if (live.trim()) state.pendingAssistantText = live;
    state.streamingNode = null;
    state.streamingItemId = null;
  }

  async function resyncThread({ force = false } = {}) {
    if (!state.threadId) return;
    if (state.resyncInFlight) {
      state.resyncPending = { force: Boolean(force || state.resyncPending?.force) };
      return;
    }
    state.resyncInFlight = true;
    try {
      const result = await request(`/api/threads/${encodeURIComponent(state.threadId)}`);
      const thread = result.thread || result;
      const nextFp = historyFingerprint(thread);
      const liveText = state.streamingNode ? state.streamingNode.textContent : '';
      const diskAheadOfUi = nextFp !== state.historyFingerprint;
      const turnInFlight = state.running || state.awaitingTurn;
      pruneOptimisticUsers(thread);

      let currentTurnAssistantLen = 0;
      let currentTurnAssistantText = '';
      const turns = thread.turns || [];
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        for (const item of lastTurn.items || []) {
          const type = String(item.type || '').toLowerCase();
          if (type.includes('agent') || type.includes('assistant') || type === 'message') {
            const text = extractText(item);
            if (text.length >= currentTurnAssistantLen) {
              currentTurnAssistantLen = text.length;
              currentTurnAssistantText = text;
            }
          }
        }
      }
      const pendingText = state.pendingAssistantText || liveText;
      const diskHasPendingAssistant = pendingText
        && normalizeMsgText(currentTurnAssistantText) === normalizeMsgText(pendingText);
      if (diskHasPendingAssistant) state.pendingAssistantText = '';

      if (turnInFlight) {
        // Never rebuild conversation mid-turn — disk lag wiped the optimistic user bubble.
        if (state.streamingNode && currentTurnAssistantLen > (liveText || '').length + 8) {
          state.streamingNode.classList.add('streaming');
          // Prefer live SSE text when longer; only pull forward if disk is ahead.
          // (length check above ensures disk is ahead)
          let diskText = '';
          for (const item of lastTurn?.items || []) {
            const type = String(item.type || '').toLowerCase();
            if (type.includes('agent') || type.includes('assistant') || type === 'message') {
              const t = extractText(item);
              if (t.length >= diskText.length) diskText = t;
            }
          }
          if (diskText) state.streamingNode.textContent = diskText;
          if (state.followOutput) scrollToLatest();
        }
        renderActivityHistory(thread);
      } else if (diskAheadOfUi || force) {
        const keepFollow = state.followOutput || nearConversationBottom();
        state.followOutput = keepFollow;
        // turn/completed can arrive before thread/read exposes the final assistant item.
        // Preserve the completed SSE text until durable history contains the same reply.
        const preserveLive = pendingText && !diskHasPendingAssistant;

        renderHistory(thread);
        renderActivityHistory(thread);
        if (preserveLive) addMessage('assistant', pendingText);
      }
      syncThreadStatus(thread);
      const activeTurn = [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
      state.turnId = activeTurn?.id || (state.running ? state.turnId : null);
      // Fresh thread history is authoritative. A mobile browser can silently
      // miss the SSE completion event and leave activeThreadIds stale.
      const active = thread.status?.type === 'active' || Boolean(activeTurn);
      setRunning(active);
      if (!active && state.awaitingTurn) {
        state.awaitingTurn = false;
        stopResyncLoop();
        pruneOptimisticUsers(thread);
        renderHistory(thread);
        renderActivityHistory(thread);
        if (state.pendingAssistantText && !diskHasPendingAssistant) {
          addMessage('assistant', state.pendingAssistantText);
        }
        scheduleCatchupResync();
      }
    } catch (error) {
      console.warn('resyncThread', error.message);
    } finally {
      state.resyncInFlight = false;
      if (state.resyncPending) {
        const pending = state.resyncPending;
        state.resyncPending = null;
        resyncThread(pending);
      }
    }
  }

  function noteLiveEvent() {
    state.lastEventAt = Date.now();
  }

  function clearCatchupTimers() {
    for (const id of state.catchupTimers) clearTimeout(id);
    state.catchupTimers = [];
  }

  function scheduleCatchupResync() {
    clearCatchupTimers();
    // App Server can publish completion before the final assistant item is durable,
    // especially after a long tool-heavy turn or while a mobile tab is backgrounded.
    for (const delay of [250, 750, 1500, 3000, 6000, 12000, 20000, 30000]) {
      state.catchupTimers.push(setTimeout(() => resyncThread({ force: true }), delay));
    }
  }

  function startResyncLoop() {
    stopResyncLoop();
    state.lastEventAt = Date.now();
    state.resyncTimer = setInterval(() => {
      if (!state.threadId) return;
      if (!state.running && !state.awaitingTurn) return;
      resyncThread({ force: true });
    }, 2000);
  }

  function stopResyncLoop() {
    if (state.resyncTimer) {
      clearInterval(state.resyncTimer);
      state.resyncTimer = null;
    }
  }

  function markTurnComplete(params = {}) {
    updateActivity(`turn-${state.turnId || params.turn?.id || params.turnId}`, {
      title: 'Turn completed',
      detail: '',
      status: 'done',
    });
    finalizeStreamingMessage();
    setRunning(false);
    state.awaitingTurn = false;
    state.turnId = null;
    stopResyncLoop();
    notifyTurnComplete('Codex finished');
    resyncThread({ force: true });
    scheduleCatchupResync();
    loadThreads();
    flushMessageQueue();
  }

  async function openThread(id) {
    try {
      resetPlan();
      const result = await request(`/api/threads/${encodeURIComponent(id)}`);
      const thread = result.thread || result;
      state.threadId = thread.id || id;
      renderMessageQueue();
      localStorage.setItem('codex-webui-active-thread', state.threadId);
      state.optimisticUsers = [];
      state.pendingAssistantText = '';
      resetSessionUsage();
      state.cwd = thread.cwd || state.cwd;
      $('#thread-title').textContent = threadTitle(thread);
      $('#thread-path').textContent = state.cwd || 'Local workspace';
      $('#active-workspace').textContent = state.cwd || '';
      if ($('#pref-system-prompt')) $('#pref-system-prompt').value = workspaceSystemPrompt();
      renderHistory(thread);
      renderActivityHistory(thread);
      syncThreadStatus(thread);
      const activeTurn = [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
      state.turnId = activeTurn?.id || null;
      setRunning(thread.status?.type === 'active' || Boolean(activeTurn));
      renderThreads();
      restoreDraft();
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
    state.streamingItemId = null;
    state.pendingAssistantText = '';
    state.awaitingTurn = false;
    state.historyFingerprint = '';
    state.optimisticUsers = [];
    resetSessionUsage();
    stopResyncLoop();
    clearCatchupTimers();
    setRunning(false);
    $('#conversation').replaceChildren();
    resetActivity({ preservePlan: false });
    $('#conversation').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#thread-title').textContent = 'New thread';
    state.cwd = $('#workspace-select').value || state.cwd;
    $('#thread-path').textContent = state.cwd || 'Choose a workspace to begin';
    $('#active-workspace').textContent = state.cwd || '';
    renderThreads();
    if ($('#message')) $('#message').value = '';
    restoreDraft();
    $('#message').focus();
    $('#sidebar').classList.remove('open');
  }

  async function ensureThread() {
    if (state.threadId) return state.threadId;
    const result = await request('/api/threads', {
      method: 'POST',
      body: JSON.stringify({ cwd: state.cwd || $('#workspace-select').value, permissionMode: (state.prefs || loadPrefs()).permissionMode }),
    });
    const thread = result.thread || result;
    state.threadId = thread.id;
    if (!state.threadId) throw new Error('Codex did not return a thread ID');
    localStorage.setItem('codex-webui-active-thread', state.threadId);
    $('#thread-path').textContent = state.cwd;
    return state.threadId;
  }

  function renderAttachments() {
    const preview = $('#attach-preview');
    preview.replaceChildren();
    if (!state.attachments.length) {
      preview.classList.add('hidden');
      return;
    }
    preview.classList.remove('hidden');
    for (const [index, file] of state.attachments.entries()) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (file.preview) {
        const image = document.createElement('img');
        image.src = file.preview;
        image.alt = file.name;
        chip.append(image);
      }
      const label = document.createElement('span');
      label.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (file.preview) URL.revokeObjectURL(file.preview);
        state.attachments.splice(index, 1);
        renderAttachments();
      });
      chip.append(label, remove);
      preview.append(chip);
    }
  }

  function clearAttachments() {
    for (const file of state.attachments) {
      if (file.preview) URL.revokeObjectURL(file.preview);
    }
    state.attachments = [];
    renderAttachments();
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',')[1] : result);
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function queueFiles(fileList) {
    const remaining = Math.max(0, 10 - state.attachments.length);
    const files = [...fileList].slice(0, remaining);
    if (!remaining) return toast('You can attach up to 10 files per message', 'error');
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name} is larger than 25MB`, 'error');
        continue;
      }
      try {
        const uploaded = await request('/api/upload', {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64: await readFileAsBase64(file),
          }),
        });
        const saved = uploaded.file;
        state.attachments.push({
          name: saved.name,
          path: saved.path,
          mimeType: saved.mimeType,
          isImage: saved.isImage,
          preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        });
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    renderAttachments();
  }

  async function sendMessage(text) {
    const cleaned = text.trim();
    if ((!cleaned && !state.attachments.length) || state.running) return;
    const attachments = state.attachments.map((file) => ({
      name: file.name,
      path: file.path,
      mimeType: file.mimeType,
      isImage: file.isImage,
      preview: file.preview,
    }));
    const optimistic = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: cleaned,
      attachments,
    };
    try {
      const threadId = await ensureThread();
      state.pendingAssistantText = '';
      state.optimisticUsers.push(optimistic);
      addMessage('user', cleaned || `Attached ${attachments.map((file) => file.name).join(', ')}`);
      const prefs = state.prefs || loadPrefs();
      state.followOutput = prefs.autoScroll !== false;
      scrollToLatest();
      if ($('#thread-title').textContent === 'New thread') {
        $('#thread-title').textContent = (cleaned || attachments[0]?.name || 'New thread').slice(0, 70);
      }
      setRunning(true);
      state.awaitingTurn = true;
      state.streamingNode = null;
      state.streamingItemId = null;
      clearCatchupTimers();
      startResyncLoop();
      setTimeout(() => resyncThread({ force: false }), 1200);
      const effort = $('#effort').value || prefs.defaultEffort || null;
      if (effort) {
        try { localStorage.setItem('codex-webui-last-effort', effort); } catch { /* ignore */ }
      }
      const result = await request(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: cleaned,
          cwd: state.cwd,
          effort,
          systemPrompt: workspaceSystemPrompt(),
          amtToolsEnabled: Boolean(prefs.amtToolsEnabled),
          permissionMode: prefs.permissionMode,
          attachments: attachments.map(({ name, path, mimeType }) => ({ name, path, mimeType })),
        }),
      });
      state.turnId = result.turn?.id || result.id || state.turnId;
      clearAttachments();
      clearDraft();
      setTimeout(loadThreads, 1200);
    } catch (error) {
      state.optimisticUsers = (state.optimisticUsers || []).filter((item) => item.id !== optimistic.id);
      setRunning(false);
      state.awaitingTurn = false;
      stopResyncLoop();
      clearCatchupTimers();
      toast(error.message, 'error');
      if (state.threadId) resyncThread({ force: true });
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
    updateFleetStrip();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('Codex needs input', { body: summary.title }); } catch { /* ignore */ }
    }
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
      updateFleetStrip();
      addEvent(decision.startsWith('accept') ? 'Action approved' : 'Action denied');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function handleCodexEvent(message) {
    noteLiveEvent();
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
        state.awaitingTurn = running || state.awaitingTurn;
        $('#interrupt').classList.toggle('hidden', !running);
        $('.send-button').disabled = false;
        if (running) startResyncLoop();
        else {
          scheduleCatchupResync();
        }
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
      state.awaitingTurn = true;
      resetActivity({ preservePlan: false });
      startResyncLoop();
      updateActivity(`turn-${state.turnId}`, { title: 'Turn started', detail: 'Codex is analyzing your request.', kind: 'reasoning', status: 'running' });
    } else if (method === 'item/agentMessage/delta') {
      setRunning(true);
      state.awaitingTurn = true;
      const itemId = params.itemId || params.item?.id || null;
      if (state.streamingNode && itemId && state.streamingItemId && itemId !== state.streamingItemId) {
        finalizeStreamingMessage();
      }
      if (!state.streamingNode) addMessage('assistant', '', true);
      if (itemId) state.streamingItemId = itemId;
      state.streamingNode.textContent += params.delta || '';
      state.pendingAssistantText = state.streamingNode.textContent;
      if (state.followOutput) scrollToLatest();
    } else if (method === 'item/started') {
      setRunning(true);
      const item = params.item || {};
      const type = String(item.type || '').toLowerCase();
      if ((type.includes('agentmessage') || type.includes('assistant'))
          && state.streamingNode && item.id && state.streamingItemId && item.id !== state.streamingItemId) {
        finalizeStreamingMessage();
      }
      renderActivityItem(item, false);
    } else if (method === 'item/completed') {
      const item = params.item || {};
      renderActivityItem(item, true);
      const type = String(item.type || '').toLowerCase();
      if ((type.includes('agentmessage') || type.includes('assistant')) && state.streamingNode
          && (!item.id || !state.streamingItemId || item.id === state.streamingItemId)) {
        const text = extractText(item);
        if (text && text.length > state.streamingNode.textContent.length) state.streamingNode.textContent = text;
        finalizeStreamingMessage();
      } else if ((type.includes('agentmessage') || type.includes('assistant')) && !state.streamingNode) {
        const text = extractText(item);
        if (text) addMessage('assistant', text);
      }
    } else if (method === 'turn/completed') {
      markTurnComplete(params);
    } else if (method === 'error') {
      toast(params.error?.message || params.message || 'Codex reported an error', 'error');
      scheduleCatchupResync();
    } else if (method === 'item/reasoning/summaryTextDelta') {
      updateActivity(params.itemId, { title: 'Reasoning summary', append: params.delta || '', kind: 'reasoning', status: 'running' });
    } else if (method === 'item/plan/delta') {
      updateActivity(params.itemId, { title: 'Building a plan', append: params.delta || '', kind: 'reasoning', status: 'running' });
    } else if (method === 'turn/plan/updated') {
      renderPlan(params.plan || [], params.explanation || '');
    } else if (method === 'item/commandExecution/outputDelta') {
      updateActivity(params.itemId, { title: 'Command output', append: params.delta || '', status: 'running' });
    } else if (method === 'item/fileChange/patchUpdated') {
      updateActivity(params.itemId, { title: 'Editing files', detail: describeChanges(params.changes || []), status: 'running' });
    } else if (method === 'turn/diff/updated') {
      updateActivity(`diff-${params.turnId}`, { title: 'Workspace diff updated', detail: params.diff || '', status: 'running' });
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage || {};
      noteTokenUsage(usage, { cumulative: true });
    } else if (method === 'account/rateLimits/updated') {
      // Sparse rolling update — merge into last snapshot.
      applyAccountRateLimits(params?.rateLimits || params);
    }
  }

  function connectEvents() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch { /* ignore */ }
      state.eventSource = null;
    }
    const source = new EventSource('/api/events');
    state.eventSource = source;
    source.onopen = () => {
      setConnected(true);
      if (state.threadId) resyncThread({ force: true });
    };
    source.onerror = () => {
      setConnected(false, 'Reconnecting…');
      if (state.threadId) resyncThread();
    };
    source.onmessage = ({ data }) => {
      let payload;
      try { payload = JSON.parse(data); }
      catch { return; }
      noteLiveEvent();
      if (payload.type === 'connected') {
        state.activeThreadIds = new Set((payload.activeThreads || []).map((active) => active.threadId));
        renderThreads();
        updateRunStatus();
        for (const pending of payload.pendingRequests || []) showApproval(pending);
        state.reconnectEvents = payload.recentEvents || [];
        if (state.threadId) {
          const replay = state.reconnectEvents.filter((entry) => entry.threadId === state.threadId);
          state.reconnectEvents = [];
          for (const entry of replay) handleCodexEvent(entry.event);
        }
        if (state.threadId) resyncThread();
      } else if (payload.type === 'server_request') showApproval(payload.request);
      else if (payload.type === 'codex_event') handleCodexEvent(payload.event);
      else if (payload.type === 'bridge_error') {
        toast(payload.message, 'error');
        setConnected(false, 'Agent offline');
      }
    };
  }

  async function initialize() {
    try {
      loadPrefs();
      applyPrefsToUi();
      updateUsageStrip();
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
      connectEvents();
      request('/api/status').then(() => setConnected(true)).catch(() => {});
      await loadThreads();
      const prefs = state.prefs || loadPrefs();
      if (prefs.autoActivity === false) setActivityOpen(false);
      else setActivityOpen(localStorage.getItem('codex-webui-activity-panel') !== 'closed');
      const savedThread = localStorage.getItem('codex-webui-active-thread');
      const resumable = state.threads.find((thread) => thread.id === savedThread)
        || state.threads.find((thread) => state.activeThreadIds.has(thread.id));
      if (resumable) {
        await openThread(resumable.id);
        const replay = state.reconnectEvents.filter((entry) => entry.threadId === resumable.id);
        state.reconnectEvents = [];
        for (const entry of replay) handleCodexEvent(entry.event);
      }
      refreshAmtStatus().catch(() => {});
      refreshAccountRateLimits().catch(() => {});

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.threadId) {
          resyncThread({ force: true });
          refreshAccountRateLimits().catch(() => {});
          if (state.eventSource?.readyState === EventSource.CLOSED) connectEvents();
        }
      });
      window.addEventListener('focus', () => {
        if (state.threadId) resyncThread();
        refreshAccountRateLimits().catch(() => {});
      });
      window.addEventListener('pageshow', () => {
        if (state.threadId) resyncThread({ force: true });
        connectEvents();
      });
      window.addEventListener('online', () => {
        setConnected(true);
        if (state.eventSource?.readyState === EventSource.CLOSED) connectEvents();
        else if (state.threadId) resyncThread({ force: true });
        refreshAccountRateLimits().catch(() => {});
      });
    } catch (error) {
      setConnected(false, 'Connection failed');
      toast(error.message, 'error');
    }
  }

  $('#composer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    hideCommands();
    const input = $('#message');
    const text = input.value;
    if (state.running) {
      if (!text.trim() && !state.attachments.length) return;
      state.stagedMessage = { text, attachments: state.attachments.map((file) => ({ ...file })) };
      input.value = '';
      input.style.height = '';
      $('#queue-choice').classList.remove('hidden');
      return;
    }
    input.value = '';
    input.style.height = '';
    sendMessage(text);
  });
  $('#queue-later')?.addEventListener('click', () => enqueueStaged());
  $('#interrupt-send')?.addEventListener('click', () => enqueueStaged({ interrupt: true }));
  $('#cancel-queue-choice')?.addEventListener('click', () => {
    if (state.stagedMessage) $('#message').value = state.stagedMessage.text || '';
    state.stagedMessage = null;
    $('#queue-choice').classList.add('hidden');
  });
  $('#message').addEventListener('keydown', (event) => {
    const menu = $('#command-menu');
    if (!menu.classList.contains('hidden') && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      const items = [...menu.querySelectorAll('.command-item')];
      if (event.key === 'Escape') {
        event.preventDefault();
        hideCommands();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        state.commandIndex = Math.max(0, Math.min(items.length - 1, state.commandIndex + offset));
        items.forEach((item, index) => item.classList.toggle('active', index === state.commandIndex));
        return;
      }
      event.preventDefault();
      const selected = WEBUI_COMMANDS.find((command) => command.name === items[state.commandIndex]?.dataset.name);
      if (selected) runCommand(selected);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer-form').requestSubmit();
    }
  });
  $('#message').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
    const cursor = event.target.selectionStart || event.target.value.length;
    const slash = event.target.value.slice(0, cursor).match(/(?:^|\s)(\/[^\s]*)$/);
    if (slash) showCommands(slash[1]);
    else hideCommands();
  });

  $('#attach-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    await queueFiles(event.target.files || []);
    event.target.value = '';
  });
  const composer = $('#composer-form');
  composer.addEventListener('dragover', (event) => {
    event.preventDefault();
    composer.classList.add('drag');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drag'));
  composer.addEventListener('drop', async (event) => {
    event.preventDefault();
    composer.classList.remove('drag');
    if (event.dataTransfer?.files?.length) await queueFiles(event.dataTransfer.files);
  });
  $('#message').addEventListener('paste', async (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      await queueFiles(files);
    }
  });
  $('#conversation').addEventListener('scroll', () => {
    state.followOutput = nearConversationBottom();
    updateJumpButton();
  }, { passive: true });
  $('#jump-latest').addEventListener('click', () => scrollToLatest('smooth'));
  $('#activity-toggle').addEventListener('click', () => {
    setActivityOpen(!$('.workspace').classList.contains('activity-open'));
  });
  $('#close-activity').addEventListener('click', () => setActivityOpen(false));
  $('#workspace-select').addEventListener('change', (event) => {
    state.cwd = event.target.value;
    $('#thread-path').textContent = state.cwd;
    $('#active-workspace').textContent = state.cwd;
  });
  $('#new-thread').addEventListener('click', newThread);
  $('#refresh-threads').addEventListener('click', loadThreads);
  $('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
  $('#close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#session-search')?.addEventListener('input', () => renderThreads());
  $('#copy-last')?.addEventListener('click', copyLastAssistant);
  $('#export-thread')?.addEventListener('click', exportThreadMarkdown);
  $('#message')?.addEventListener('input', () => saveDraft());
  const TIP_BASE = 'https://agentmediatools.com/tip';
  const tipModal = $('#tip-modal');
  const prefsModal = $('#prefs-modal');
  const galleryModal = $('#gallery-modal');
  let galleryItems = [];

  function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  function renderGallery() {
    const grid = $('#gallery-grid');
    if (!grid) return;
    const filter = $('#gallery-filter')?.value || 'all';
    const files = galleryItems.filter((file) => filter === 'all' || (filter === 'images' ? file.isImage : !file.isImage));
    grid.replaceChildren();
    if (!files.length) {
      const empty = document.createElement('p'); empty.className = 'prefs-hint'; empty.textContent = 'No matching files yet.'; grid.append(empty); return;
    }
    for (const file of files) {
      const card = document.createElement('article'); card.className = 'gallery-card';
      const preview = document.createElement('a'); preview.className = 'gallery-preview';
      preview.href = file.isImage ? `/api/image?path=${encodeURIComponent(file.path)}` : `/api/file?path=${encodeURIComponent(file.path)}`;
      preview.target = '_blank'; preview.rel = 'noopener';
      if (file.isImage && file.mimeType !== 'image/svg+xml') {
        const img = document.createElement('img'); img.src = preview.href; img.alt = file.name; img.loading = 'lazy'; preview.append(img);
      } else preview.textContent = file.isImage ? '▧' : '▤';
      const meta = document.createElement('div'); meta.className = 'gallery-meta';
      const name = document.createElement('div'); name.className = 'gallery-name'; name.title = file.name; name.textContent = file.name;
      const detail = document.createElement('div'); detail.className = 'gallery-detail'; detail.textContent = `${file.source} · ${humanSize(file.size)}`;
      const actions = document.createElement('div'); actions.className = 'gallery-actions';
      const open = document.createElement('a'); open.href = preview.href; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open';
      const download = document.createElement('a'); download.href = `/api/file?path=${encodeURIComponent(file.path)}`; download.textContent = 'Download';
      actions.append(open, download); meta.append(name, detail, actions); card.append(preview, meta); grid.append(card);
    }
  }
  async function loadGallery() {
    const result = await request(`/api/gallery?cwd=${encodeURIComponent(state.cwd || $('#workspace-select')?.value || '')}`);
    galleryItems = result.files || []; renderGallery();
  }
  function openGallery() {
    galleryModal?.classList.remove('hidden');
    loadGallery().catch((error) => toast(error.message, 'error'));
  }

  function openTipModal() {
    if (!tipModal) return;
    tipModal.classList.remove('hidden');
    $('#close-tip')?.focus();
  }
  function closeTipModal() {
    tipModal?.classList.add('hidden');
  }
  function openTipCheckout(amountDollars) {
    const url = new URL(TIP_BASE);
    url.searchParams.set('from', 'codex-webui');
    if (amountDollars) url.searchParams.set('amount', String(amountDollars));
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
    closeTipModal();
  }

  function openPrefsModal() {
    if (!prefsModal) return;
    applyPrefsToUi();
    refreshAmtStatus().catch(() => {});
    prefsModal.classList.remove('hidden');
    $('#close-prefs')?.focus();
  }
  function closePrefsModal() {
    prefsModal?.classList.add('hidden');
  }

  function savePrefsFromForm() {
    const partial = {
      defaultEffort: $('#pref-default-effort')?.value || '',
      autoScroll: Boolean($('#pref-auto-scroll')?.checked),
      autoActivity: Boolean($('#pref-auto-activity')?.checked),
      density: $('#pref-density')?.value || 'comfortable',
      theme: $('#pref-theme')?.value || 'dark',
      accent: $('#pref-accent')?.value || 'green',
      amtToolsEnabled: Boolean($('#pref-amt-tools-enabled')?.checked),
      notifyOnComplete: Boolean($('#pref-notify-complete')?.checked),
      permissionMode: $('#pref-permission-mode')?.value || 'moderate',
    };
    setWorkspaceSystemPrompt($('#pref-system-prompt')?.value || '');
    savePrefs(partial);
    if (partial.defaultEffort && $('#effort')) $('#effort').value = partial.defaultEffort;
    if (partial.notifyOnComplete && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    toast('Preferences saved');
  }

  async function refreshAmtStatus() {
    const statusEl = $('#pref-amt-status');
    const toolsWrap = $('#pref-amt-tools');
    const toolsList = $('#pref-amt-tools-list');
    try {
      const result = await request('/api/amt/status');
      if (!result.connected) {
        state.amtStatus = { connected: false };
        if (statusEl) {
          statusEl.className = 'prefs-amt-status';
          statusEl.textContent = result.message || 'Not connected';
        }
        toolsWrap?.classList.add('hidden');
        updateUsageStrip();
        return result;
      }
      state.amtStatus = { connected: true, ...result };
      if (statusEl) {
        statusEl.className = 'prefs-amt-status ok';
        const rem = result.usage?.remaining ?? '—';
        const lim = result.usage?.limit ?? '—';
        const used = result.usage?.used_today ?? '—';
        const cr = result.credit_balance?.total ?? result.usage_credits ?? '—';
        statusEl.textContent = `Connected (${result.key_prefix || 'key'}) · plan ${result.plan || 'free'} · ${used}/${lim} today (${rem} left) · ${cr} credits`;
      }
      if (toolsWrap && toolsList && Array.isArray(result.tools)) {
        toolsWrap.classList.remove('hidden');
        toolsList.replaceChildren();
        for (const tool of result.tools.slice(0, 40)) {
          const row = document.createElement('div');
          row.className = 'prefs-tool';
          const left = document.createElement('div');
          const name = document.createElement('b');
          name.textContent = tool.id || tool.name || 'tool';
          const desc = document.createElement('div');
          desc.style.color = 'var(--muted)';
          desc.style.fontSize = '.72rem';
          desc.textContent = tool.description || '';
          left.append(name, desc);
          const tier = document.createElement('span');
          const t = String(tool.tier || 'free').toLowerCase();
          tier.className = `tier ${t === 'free' ? 'free' : 'paid'}`;
          tier.textContent = t;
          row.append(left, tier);
          toolsList.append(row);
        }
      }
      updateUsageStrip();
      return result;
    } catch (error) {
      state.amtStatus = { connected: false };
      if (statusEl) {
        statusEl.className = 'prefs-amt-status err';
        statusEl.textContent = error.message || 'Could not load AMT status (restart WebUI if routes are new)';
      }
      updateUsageStrip();
      throw error;
    }
  }

  async function saveAmtKey() {
    const key = ($('#pref-amt-key')?.value || '').trim();
    if (!key) {
      toast('Paste an mt_ agent key first', 'error');
      return;
    }
    await request('/api/amt/connect', { method: 'POST', body: JSON.stringify({ key }) });
    if ($('#pref-amt-key')) $('#pref-amt-key').value = '';
    toast('AMT key saved on this machine');
    await refreshAmtStatus();
  }

  async function clearAmtKey() {
    await request('/api/amt/connect', { method: 'DELETE', body: '{}' });
    state.amtStatus = { connected: false };
    $('#pref-amt-tools')?.classList.add('hidden');
    const statusEl = $('#pref-amt-status');
    if (statusEl) {
      statusEl.className = 'prefs-amt-status';
      statusEl.textContent = 'Disconnected';
    }
    updateUsageStrip();
    toast('AMT disconnected');
  }

  $('#open-tip')?.addEventListener('click', openTipModal);
  $('#close-tip')?.addEventListener('click', closeTipModal);
  tipModal?.addEventListener('click', (event) => {
    if (event.target === tipModal) closeTipModal();
  });
  $('#open-prefs')?.addEventListener('click', openPrefsModal);
  $('#open-gallery')?.addEventListener('click', openGallery);
  $('#close-gallery')?.addEventListener('click', () => galleryModal?.classList.add('hidden'));
  $('#refresh-gallery')?.addEventListener('click', () => loadGallery().catch((e) => toast(e.message, 'error')));
  $('#gallery-filter')?.addEventListener('change', renderGallery);
  galleryModal?.addEventListener('click', (event) => { if (event.target === galleryModal) galleryModal.classList.add('hidden'); });
  $('#close-prefs')?.addEventListener('click', closePrefsModal);
  prefsModal?.addEventListener('click', (event) => {
    if (event.target === prefsModal) closePrefsModal();
  });
  $('#pref-save')?.addEventListener('click', () => {
    savePrefsFromForm();
    closePrefsModal();
  });
  $('#pref-amt-save')?.addEventListener('click', () => {
    saveAmtKey().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-amt-clear')?.addEventListener('click', () => {
    clearAmtKey().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-amt-refresh')?.addEventListener('click', () => {
    refreshAmtStatus().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-theme')?.addEventListener('change', () => {
    document.body.dataset.theme = $('#pref-theme').value === 'light' ? 'light' : 'dark';
  });
  $('#pref-accent')?.addEventListener('change', () => {
    document.body.dataset.accent = $('#pref-accent').value || 'green';
  });
  $('#effort')?.addEventListener('change', () => {
    const value = $('#effort').value || '';
    if (value) savePrefs({ defaultEffort: value });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (tipModal && !tipModal.classList.contains('hidden')) closeTipModal();
    if (prefsModal && !prefsModal.classList.contains('hidden')) closePrefsModal();
    if (galleryModal && !galleryModal.classList.contains('hidden')) galleryModal.classList.add('hidden');
  });
  $$('[data-tip-amount]').forEach((button) => {
    button.addEventListener('click', () => openTipCheckout(button.dataset.tipAmount));
  });
  $('#tip-custom')?.addEventListener('click', () => openTipCheckout());

  $('#logout').addEventListener('click', async () => {
    await request('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/login.html';
  });
  $('#interrupt').addEventListener('click', async () => {
    if (!state.threadId || !state.turnId) return;
    try {
      await request(`/api/threads/${encodeURIComponent(state.threadId)}/turns/${encodeURIComponent(state.turnId)}/interrupt`, { method: 'POST', body: '{}' });
      setRunning(false);
      state.awaitingTurn = false;
      stopResyncLoop();
      clearCatchupTimers();
      finalizeStreamingMessage();
      resyncThread({ force: true });
      addEvent('Turn interrupted');
      flushMessageQueue();
    } catch (error) { toast(error.message, 'error'); }
  });
  $$('.suggestions button').forEach((button) => button.addEventListener('click', () => sendMessage(button.dataset.prompt)));
  $$('.approval-actions button').forEach((button) => button.addEventListener('click', () => decideApproval(button.dataset.decision)));
  loadMessageQueue();
  initialize();
}
