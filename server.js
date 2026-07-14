'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = __dirname;
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadEnv(path.join(PROJECT_ROOT, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4545);
const WORKSPACE_ROOT = fs.realpathSync(process.env.WORKSPACE_ROOT || '/home/eric/workspace');
const PASSWORD_SALT = process.env.PASSWORD_SALT || '';
const PASSWORD_HASH = process.env.PASSWORD_HASH || '';
const SESSION_HOURS = Math.min(168, Math.max(1, Number(process.env.SESSION_HOURS || 24)));
const sessions = new Map();
const loginAttempts = new Map();
const sseClients = new Set();

if (!PASSWORD_SALT || !PASSWORD_HASH) {
  console.error('Missing PASSWORD_SALT or PASSWORD_HASH. Run ./scripts/setup.sh first.');
  process.exit(1);
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function verifyPassword(password) {
  const actual = crypto.scryptSync(String(password), PASSWORD_SALT, 64).toString('hex');
  return timingSafeEqualHex(actual, PASSWORD_HASH);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

function authenticated(req) {
  const token = parseCookies(req).codex_webui_session;
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function secureHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, secureHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }));
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function sameOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  return origin === `http://${HOST}:${PORT}` || origin === `https://${HOST}:${PORT}`;
}

function allowedWorkspace(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw Object.assign(new Error('Invalid workspace'), { status: 400 });
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch { throw Object.assign(new Error('Workspace does not exist'), { status: 400 }); }
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    throw Object.assign(new Error('Workspace is outside the allowed root'), { status: 403 });
  }
  if (!fs.statSync(resolved).isDirectory()) throw Object.assign(new Error('Workspace is not a directory'), { status: 400 });
  return resolved;
}

class CodexBridge {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.activeThreads = new Map();
    this.ready = this.start();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('codex', ['app-server'], {
        cwd: WORKSPACE_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.proc.stderr.on('data', (chunk) => console.error(`[codex] ${chunk.toString().trim()}`));
      this.proc.once('error', reject);
      this.proc.once('exit', (code, signal) => {
        const error = new Error(`Codex App Server exited (${code ?? signal})`);
        for (const { reject: fail } of this.pending.values()) fail(error);
        this.pending.clear();
        broadcast({ type: 'bridge_error', message: error.message });
      });
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
      this.rawRequest('initialize', {
        clientInfo: { name: 'eric_codex_webui', title: 'Eric Codex WebUI', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      }).then(() => {
        this.send({ method: 'initialized', params: {} });
        resolve();
      }, reject);
    });
  }

  send(message) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('Codex App Server is unavailable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return console.error('Ignored malformed Codex App Server output'); }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.serverRequests.set(String(message.id), message);
      broadcast({ type: 'server_request', request: message });
      return;
    }
    const threadId = message.params?.threadId || message.params?.turn?.threadId;
    if (message.method === 'thread/status/changed' && threadId) {
      if (message.params.status?.type === 'active') {
        this.activeThreads.set(threadId, {
          threadId,
          turnId: this.activeThreads.get(threadId)?.turnId || null,
          activeFlags: message.params.status.activeFlags || [],
          updatedAt: Date.now(),
        });
      } else {
        this.activeThreads.delete(threadId);
      }
    } else if (message.method === 'turn/started' && threadId) {
      this.activeThreads.set(threadId, {
        threadId,
        turnId: message.params.turn?.id || message.params.turnId || null,
        activeFlags: [],
        updatedAt: Date.now(),
      });
    } else if (message.method === 'turn/completed' && threadId) {
      this.activeThreads.delete(threadId);
    }
    broadcast({ type: 'codex_event', event: message });
  }

  rawRequest(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex request timed out: ${method}`));
      }, 120000);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.send({ id, method, params });
    });
  }

  async request(method, params = {}) {
    await this.ready;
    return this.rawRequest(method, params);
  }

  respond(id, result) {
    const key = String(id);
    if (!this.serverRequests.has(key)) throw Object.assign(new Error('Approval request is no longer pending'), { status: 404 });
    this.serverRequests.delete(key);
    this.send({ id, result });
  }
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

const bridge = new CodexBridge();

function listWorkspaces() {
  const entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: path.join(WORKSPACE_ROOT, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: 'workspace', path: WORKSPACE_ROOT }, ...entries];
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_ROOT, relative);
  if (!file.startsWith(`${PUBLIC_ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, secureHeaders({ 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }));
  fs.createReadStream(file).pipe(res);
  return true;
}

async function api(req, res, pathname) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const key = req.socket.remoteAddress || 'unknown';
    const attempts = loginAttempts.get(key) || { count: 0, reset: Date.now() + 60000 };
    if (attempts.reset < Date.now()) Object.assign(attempts, { count: 0, reset: Date.now() + 60000 });
    if (attempts.count >= 6) return json(res, 429, { error: 'Too many attempts. Try again shortly.' });
    const body = await readJson(req);
    if (!verifyPassword(body.password)) {
      attempts.count += 1;
      loginAttempts.set(key, attempts);
      return json(res, 401, { error: 'Incorrect password' });
    }
    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_HOURS * 3600000);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': `codex_webui_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    });
  }

  if (!authenticated(req)) return json(res, 401, { error: 'Authentication required' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).codex_webui_session;
    sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'codex_webui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: true, workspaceRoot: WORKSPACE_ROOT });
  if (pathname === '/api/workspaces' && req.method === 'GET') return json(res, 200, { workspaces: listWorkspaces() });
  if (pathname === '/api/status' && req.method === 'GET') {
    await bridge.ready;
    return json(res, 200, { ok: true, codex: 'connected', host: HOST, workspaceRoot: WORKSPACE_ROOT });
  }
  if (pathname === '/api/activity' && req.method === 'GET') {
    return json(res, 200, { activeThreads: [...bridge.activeThreads.values()] });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, secureHeaders({
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      pendingRequests: [...bridge.serverRequests.values()],
      activeThreads: [...bridge.activeThreads.values()],
    })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (pathname === '/api/threads' && req.method === 'GET') {
    const result = await bridge.request('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc' });
    return json(res, 200, result);
  }
  if (pathname === '/api/threads' && req.method === 'POST') {
    const body = await readJson(req);
    const cwd = allowedWorkspace(body.cwd || WORKSPACE_ROOT);
    const result = await bridge.request('thread/start', {
      cwd,
      model: body.model || null,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      personality: body.personality || null,
    });
    return json(res, 201, result);
  }
  const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && req.method === 'GET') {
    const params = { threadId: decodeURIComponent(threadMatch[1]), includeTurns: true };
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        result = await bridge.request('thread/read', params);
        break;
      } catch (error) {
        if (!/rollout.*empty|failed to load thread history/i.test(error.message) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    return json(res, 200, result);
  }
  const messageMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (messageMatch && req.method === 'POST') {
    const threadId = decodeURIComponent(messageMatch[1]);
    const body = await readJson(req);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 50000) return json(res, 400, { error: 'Message must be 1–50,000 characters' });
    if (body.cwd) allowedWorkspace(body.cwd);
    try { await bridge.request('thread/resume', { threadId }); } catch (error) {
      // A newly created thread has no rollout to resume until its first turn is stored.
      if (!/already|active|loaded|no rollout found/i.test(error.message)) throw error;
    }
    const result = await bridge.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: body.text }],
      cwd: body.cwd || null,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      effort: body.effort || null,
    });
    bridge.activeThreads.set(threadId, {
      threadId,
      turnId: result.turn?.id || result.id || null,
      activeFlags: [],
      updatedAt: Date.now(),
    });
    return json(res, 202, result);
  }
  const interruptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === 'POST') {
    const result = await bridge.request('turn/interrupt', {
      threadId: decodeURIComponent(interruptMatch[1]),
      turnId: decodeURIComponent(interruptMatch[2]),
    });
    return json(res, 200, result);
  }
  const approvalMatch = pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (approvalMatch && req.method === 'POST') {
    const body = await readJson(req);
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(body.decision)) return json(res, 400, { error: 'Invalid decision' });
    bridge.respond(decodeURIComponent(approvalMatch[1]), { decision: body.decision });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origin rejected' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    if (!authenticated(req) && url.pathname !== '/login.html' && url.pathname !== '/app.css' && url.pathname !== '/app.js') {
      res.writeHead(302, secureHeaders({ Location: '/login.html' }));
      return res.end();
    }
    if (!serveStatic(req, res, url.pathname)) json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex WebUI listening on http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});

function shutdown() {
  server.close();
  if (bridge.proc && !bridge.proc.killed) bridge.proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
