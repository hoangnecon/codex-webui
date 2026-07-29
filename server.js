'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = __dirname;
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const UPLOAD_ROOT = path.join(PROJECT_ROOT, 'data', 'uploads');
const AMT_STORE = path.join(PROJECT_ROOT, 'data', 'amt.json');
const AMT_BASE = process.env.AMT_BASE_URL || 'https://agentmediatools.com';

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
const EXECUTION_MODE = 'full-access';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_GALLERY_FILES = 200;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const sessions = new Map();
const loginAttempts = new Map();
const sseClients = new Set();

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

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

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
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

const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const GALLERY_TYPES = new Map([
  ...IMAGE_TYPES,
  ['.svg', 'image/svg+xml'], ['.pdf', 'application/pdf'], ['.txt', 'text/plain'],
  ['.md', 'text/markdown'], ['.csv', 'text/csv'], ['.json', 'application/json'],
  ['.zip', 'application/zip'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

function permissionPreset(value, cwd) {
  if (value === 'restrictive') {
    return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  }
  if (value === 'moderate') {
    return {
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false },
    };
  }
  return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
}

function allowedGalleryFile(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  let resolved;
  try { resolved = fs.realpathSync(input); } catch { throw Object.assign(new Error('File does not exist'), { status: 404 }); }
  const roots = [WORKSPACE_ROOT, UPLOAD_ROOT].map((root) => fs.realpathSync(root));
  if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) throw Object.assign(new Error('File is outside the allowed workspace'), { status: 403 });
  const stat = fs.statSync(resolved);
  const contentType = GALLERY_TYPES.get(path.extname(resolved).toLowerCase());
  if (!stat.isFile() || !contentType) throw Object.assign(new Error('Unsupported file'), { status: 415 });
  if (stat.size > MAX_DOWNLOAD_BYTES) throw Object.assign(new Error('File is too large'), { status: 413 });
  return { resolved, stat, contentType };
}

function galleryFiles(cwd) {
  const roots = [{ root: UPLOAD_ROOT, source: 'upload' }, { root: cwd, source: 'workspace' }];
  const found = [];
  const ignored = new Set(['.git', '.cache', '.next', 'node_modules', 'vendor', 'data', 'uploads', 'downloads']);
  for (const item of roots) {
    const queue = [{ dir: item.root, depth: 0 }];
    while (queue.length && found.length < MAX_GALLERY_FILES * 3) {
      const { dir, depth } = queue.shift();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 5) queue.push({ dir: target, depth: depth + 1 });
        if (!entry.isFile()) continue;
        const contentType = GALLERY_TYPES.get(path.extname(entry.name).toLowerCase());
        if (!contentType) continue;
        try {
          const stat = fs.statSync(target);
          if (stat.size > MAX_DOWNLOAD_BYTES) continue;
          found.push({
            name: entry.name, path: target, size: stat.size, modifiedAt: stat.mtimeMs,
            mimeType: contentType, isImage: contentType.startsWith('image/'), source: item.source,
          });
        } catch { /* file changed while scanning */ }
      }
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_GALLERY_FILES);
}

function allowedImage(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw Object.assign(new Error('Invalid image path'), { status: 400 });
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch { throw Object.assign(new Error('Image does not exist'), { status: 404 }); }
  const allowedRoots = [WORKSPACE_ROOT, UPLOAD_ROOT].map((root) => fs.realpathSync(root));
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw Object.assign(new Error('Image is outside the allowed workspace'), { status: 403 });
  }
  const stat = fs.statSync(resolved);
  const contentType = IMAGE_TYPES.get(path.extname(resolved).toLowerCase());
  if (!stat.isFile() || !contentType) throw Object.assign(new Error('Unsupported image'), { status: 415 });
  if (stat.size > 25 * 1024 * 1024) throw Object.assign(new Error('Image is too large'), { status: 413 });
  return { resolved, stat, contentType };
}

function mimeFor(filePath) {
  const imageType = IMAGE_TYPES.get(path.extname(filePath).toLowerCase());
  return imageType || 'application/octet-stream';
}

function allowedUpload(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw Object.assign(new Error('Invalid attachment path'), { status: 400 });
  }
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch { throw Object.assign(new Error('Attachment does not exist'), { status: 404 }); }
  const root = fs.realpathSync(UPLOAD_ROOT);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('Attachment is outside the upload area'), { status: 403 });
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw Object.assign(new Error('Attachment is not a file'), { status: 400 });
  if (stat.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Attachment is too large'), { status: 413 });
  return resolved;
}

async function saveUpload({ name, dataBase64, mimeType }) {
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    throw Object.assign(new Error('Missing file data'), { status: 400 });
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('File too large (25MB max)'), { status: 413 });
  }
  const safeName = String(name || 'upload.bin')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'upload.bin';
  const id = crypto.randomUUID();
  const dir = path.join(UPLOAD_ROOT, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const destination = path.join(dir, safeName);
  await fs.promises.writeFile(destination, buffer, { mode: 0o600 });
  return {
    id,
    name: safeName,
    path: destination,
    size: buffer.length,
    mimeType: mimeType || mimeFor(destination),
    isImage: IMAGE_TYPES.has(path.extname(destination).toLowerCase()),
  };
}

class CodexBridge {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.activeThreads = new Map();
    this.recentEvents = [];
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
    const eventParams = message.params || {};
    const eventThreadId = eventParams.threadId || eventParams.thread?.id || eventParams.turn?.threadId;
    if (eventThreadId && [
      'turn/plan/updated', 'item/started',
      'item/completed', 'turn/started', 'turn/completed',
    ].includes(message.method)) {
      this.recentEvents.push({ threadId: eventThreadId, event: message, at: Date.now() });
      if (this.recentEvents.length > 300) this.recentEvents.splice(0, this.recentEvents.length - 300);
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
  for (const client of sseClients) {
    try {
      client.write(frame);
      if (typeof client.flush === 'function') client.flush();
    } catch {
      sseClients.delete(client);
    }
  }
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

  if (pathname === '/api/image' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('path');
    const image = allowedImage(requested);
    res.writeHead(200, secureHeaders({
      'Content-Type': image.contentType,
      'Content-Length': image.stat.size,
      'Content-Disposition': 'inline',
    }));
    fs.createReadStream(image.resolved).pipe(res);
    return;
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('path');
    const file = allowedGalleryFile(requested);
    res.writeHead(200, secureHeaders({
      'Content-Type': file.contentType, 'Content-Length': file.stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(file.resolved).replace(/["\r\n]/g, '_')}"`,
    }));
    fs.createReadStream(file.resolved).pipe(res);
    return;
  }
  if (pathname === '/api/gallery' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('cwd');
    const cwd = allowedWorkspace(requested || WORKSPACE_ROOT);
    return json(res, 200, { files: galleryFiles(cwd) });
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    const body = await readJson(req, MAX_UPLOAD_BYTES * 1.4 + 64 * 1024);
    const saved = await saveUpload(body);
    return json(res, 201, { file: saved });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).codex_webui_session;
    sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'codex_webui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: true, workspaceRoot: WORKSPACE_ROOT });
  if (pathname === '/api/workspaces' && req.method === 'GET') return json(res, 200, { workspaces: listWorkspaces() });
  if (pathname === '/api/status' && req.method === 'GET') {
    await bridge.ready;
    return json(res, 200, { ok: true, codex: 'connected', host: HOST, workspaceRoot: WORKSPACE_ROOT, executionMode: EXECUTION_MODE });
  }
  if (pathname === '/api/activity' && req.method === 'GET') {
    return json(res, 200, { activeThreads: [...bridge.activeThreads.values()] });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, secureHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
    try { res.socket?.setNoDelay?.(true); } catch { /* ignore */ }
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      pendingRequests: [...bridge.serverRequests.values()],
      activeThreads: [...bridge.activeThreads.values()],
      recentEvents: bridge.recentEvents.filter((entry) => entry.at > Date.now() - 10 * 60 * 1000),
    })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); }
      catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }
  if (pathname === '/api/threads' && req.method === 'GET') {
    const result = await bridge.request('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc' });
    return json(res, 200, result);
  }
  if (pathname === '/api/threads' && req.method === 'POST') {
    const body = await readJson(req);
    const cwd = allowedWorkspace(body.cwd || WORKSPACE_ROOT);
    const permissions = permissionPreset(body.permissionMode, cwd);
    const result = await bridge.request('thread/start', {
      cwd,
      model: body.model || null,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: permissions.sandboxPolicy.type === 'dangerFullAccess'
        ? 'danger-full-access'
        : permissions.sandboxPolicy.type === 'workspaceWrite' ? 'workspace-write' : 'read-only',
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
    const body = await readJson(req, 2 * 1024 * 1024);
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : [];
    if (typeof body.text !== 'string' || body.text.length > 50000) {
      return json(res, 400, { error: 'Message must be 0–50,000 characters' });
    }
    if (!body.text.trim() && !attachments.length) {
      return json(res, 400, { error: 'Message or attachment required' });
    }
    if (body.cwd) allowedWorkspace(body.cwd);
    try { await bridge.request('thread/resume', { threadId }); } catch (error) {
      // A newly created thread has no rollout to resume until its first turn is stored.
      if (!/already|active|loaded|no rollout found/i.test(error.message)) throw error;
    }
    const input = [];
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
    if (systemPrompt) {
      input.push({
        type: 'text',
        text: `[System instructions for this session — follow unless the user overrides]\n${systemPrompt.slice(0, 8000)}`,
      });
    }
    if (body.amtToolsEnabled) {
      try {
        const tools = await amtFetchTools();
        const free = tools.filter((t) => String(t.tier || '').toLowerCase() === 'free').slice(0, 30);
        const paid = tools.filter((t) => String(t.tier || '').toLowerCase() !== 'free').slice(0, 20);
        const planLines = [
          '[Agent Media Tools — optional cloud tools]',
          'User has AMT tools enabled. Prefer free tier tools first. Paid/agent-tier tools require their linked AMT key and may spend credits.',
          `Base URL: ${AMT_BASE}`,
          free.length ? `Free tools: ${free.map((t) => t.id).join(', ')}` : 'Free tools: (catalog unavailable)',
          paid.length ? `Other tiers (gated): ${paid.map((t) => `${t.id}[${t.tier}]`).join(', ')}` : '',
          'Call tools via HTTPS REST with Authorization: Bearer <their AMT key> when appropriate; do not invent credentials.',
        ].filter(Boolean);
        input.push({ type: 'text', text: planLines.join('\n').slice(0, 6000) });
      } catch (error) {
        console.warn('AMT tools hint failed:', error.message);
      }
    }
    if (body.text.trim()) input.push({ type: 'text', text: body.text.trim() });
    for (const attachment of attachments) {
      const resolved = allowedUpload(attachment?.path);
      const name = String(attachment?.name || path.basename(resolved)).slice(0, 180);
      const mimeType = String(attachment?.mimeType || mimeFor(resolved)).slice(0, 200);
      const isImage = IMAGE_TYPES.has(path.extname(resolved).toLowerCase());
      if (isImage) {
        input.push({ type: 'localImage', path: resolved });
      } else {
        input.push({
          type: 'text',
          text: `[User attached file: ${name}]\nAbsolute path: ${resolved}\nMIME: ${mimeType}\nUse tools to inspect this path as needed.`,
        });
      }
    }
    const cwd = allowedWorkspace(body.cwd || WORKSPACE_ROOT);
    const permissions = permissionPreset(body.permissionMode, cwd);
    const result = await bridge.request('turn/start', {
      threadId,
      input,
      cwd,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: 'user',
      sandboxPolicy: permissions.sandboxPolicy,
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

  // Codex account rate limits (weekly / rolling windows from ChatGPT account)
  if (pathname === '/api/account/rate-limits' && req.method === 'GET') {
    try {
      const result = await bridge.request('account/rateLimits/read', {});
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 502, {
        ok: false,
        error: error.message || 'Could not read Codex account rate limits',
      });
    }
  }

  // Optional Agent Media Tools bridge (key stored only on this laptop)
  if (pathname === '/api/amt/connect' && req.method === 'POST') {
    const body = await readJson(req);
    const key = String(body.key || '').trim();
    if (!key || key.length < 12 || key.length > 200) {
      return json(res, 400, { error: 'Valid AMT agent key required' });
    }
    const status = await amtFetchStatus(key);
    if (!status.ok) return json(res, status.status || 400, { error: status.error || 'AMT key rejected' });
    writeAmtStore({ key, savedAt: new Date().toISOString(), key_prefix: status.data?.key_prefix || key.slice(0, 8) });
    return json(res, 200, { ok: true, connected: true, key_prefix: status.data?.key_prefix || key.slice(0, 8) });
  }
  if (pathname === '/api/amt/connect' && req.method === 'DELETE') {
    writeAmtStore({});
    return json(res, 200, { ok: true, connected: false });
  }
  if (pathname === '/api/amt/status' && req.method === 'GET') {
    const store = readAmtStore();
    if (!store.key) {
      return json(res, 200, { connected: false, message: 'Not connected — paste an mt_ agent key in Preferences' });
    }
    const status = await amtFetchStatus(store.key);
    if (!status.ok) {
      return json(res, 200, {
        connected: false,
        message: status.error || 'Could not reach AMT',
        key_prefix: store.key_prefix || null,
      });
    }
    let tools = [];
    try { tools = await amtFetchTools(); } catch { tools = []; }
    const plan = String(status.data?.plan || 'free').toLowerCase();
    const paidOk = plan === 'pro' || plan === 'premium' || plan === 'builder';
    const visibleTools = tools.filter((t) => {
      const tier = String(t.tier || 'free').toLowerCase();
      if (tier === 'free') return true;
      return paidOk;
    });
    return json(res, 200, {
      connected: true,
      ...status.data,
      tools: visibleTools,
      tools_total: tools.length,
      paid_tools_unlocked: paidOk,
    });
  }

  return json(res, 404, { error: 'Not found' });
}

function readAmtStore() {
  try {
    if (!fs.existsSync(AMT_STORE)) return {};
    return JSON.parse(fs.readFileSync(AMT_STORE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAmtStore(data) {
  fs.mkdirSync(path.dirname(AMT_STORE), { recursive: true });
  fs.writeFileSync(AMT_STORE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(AMT_STORE, 0o600); } catch { /* ignore */ }
}

async function amtFetchStatus(key) {
  try {
    const response = await fetch(`${AMT_BASE}/api/agent/status`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'codex-webui-amt-bridge/1.0',
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || `AMT status ${response.status}` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 502, error: error.message || 'AMT unreachable' };
  }
}

async function amtFetchTools() {
  const response = await fetch(`${AMT_BASE}/api/tools`, {
    headers: { Accept: 'application/json', 'User-Agent': 'codex-webui-amt-bridge/1.0' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AMT tools ${response.status}`);
  return Array.isArray(data.tools) ? data.tools : [];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origin rejected' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    const publicAssets = new Set(['/login.html', '/app.css', '/app.js', '/viewport.js']);
    if (!authenticated(req) && !publicAssets.has(url.pathname)) {
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
