'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('server binds to an explicitly configured host and never exposes App Server directly', () => {
  assert.match(server, /server\.listen\(PORT, HOST/);
  assert.match(server, /spawn\('codex', \['app-server'\]/);
  assert.doesNotMatch(server, /app-server', '--listen'/);
});

test('authentication uses a timing-safe password hash and HttpOnly strict cookies', () => {
  assert.match(server, /crypto\.scryptSync/);
  assert.match(server, /crypto\.timingSafeEqual/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
});

test('state-changing requests enforce same-origin checks', () => {
  assert.match(server, /function sameOrigin/);
  assert.match(server, /Origin rejected/);
});

test('workspaces are constrained to the configured workspace root', () => {
  assert.match(server, /startsWith\(`\$\{WORKSPACE_ROOT\}\$\{path\.sep\}`\)/);
  assert.match(server, /Workspace is outside the allowed root/);
});

test('auto-approval remains limited to the writable workspace sandbox', () => {
  assert.match(server, /approvalPolicy: 'never'/);
  assert.match(server, /type: 'workspaceWrite'/);
  assert.match(server, /writableRoots: \[WORKSPACE_ROOT\]/);
  assert.match(server, /networkAccess: true/);
  assert.doesNotMatch(server, /sandbox: 'danger-full-access'/);
});

test('UI keeps approval controls visible and does not load third-party scripts', () => {
  assert.match(html, /id="approval-drawer"/);
  assert.match(html, /data-decision="decline"/);
  assert.doesNotMatch(html, /<script[^>]+https?:/);
});

test('UI restores the selected thread and derives activity from durable thread status', () => {
  assert.match(app, /localStorage\.setItem\('codex-webui-active-thread'/);
  assert.match(app, /thread\/status\/changed/);
  assert.match(app, /status\?\.type === 'active'/);
  assert.match(app, /running in background/);
  assert.match(app, /\/api\/activity/);
  assert.match(server, /activeThreads = new Map/);
  assert.match(server, /rollout\.\*empty/);
});

test('history renderer recursively extracts structured user-message content', () => {
  assert.match(app, /return extractText\(value\.content\)/);
  assert.doesNotMatch(app, /value\.text \|\| value\.content/);
});

test('long conversations remain scrollable and provide a jump-to-latest control', () => {
  assert.match(html, /id="jump-latest"/);
  assert.match(app, /function scrollToLatest/);
  assert.match(app, /nearConversationBottom/);
  assert.match(app, /followOutput/);
});

test('live activity panel renders supported progress without private reasoning text', () => {
  assert.match(html, /id="activity-rail"/);
  assert.match(app, /item\/reasoning\/summaryTextDelta/);
  assert.match(app, /turn\/plan\/updated/);
  assert.match(app, /item\/commandExecution\/outputDelta/);
  assert.match(app, /item\/fileChange\/patchUpdated/);
  assert.doesNotMatch(app, /method === 'item\/reasoning\/textDelta'/);
});

test('mobile layout supports iPhone safe areas, dynamic viewport, and keyboard-safe controls', () => {
  const login = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.match(login, /viewport-fit=cover/);
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /-webkit-overflow-scrolling: touch/);
  assert.match(css, /\.composer textarea \{[^}]*font-size: 16px/);
});
