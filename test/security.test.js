'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

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

test('UI keeps approval controls visible and does not load third-party scripts', () => {
  assert.match(html, /id="approval-drawer"/);
  assert.match(html, /data-decision="decline"/);
  assert.doesNotMatch(html, /<script[^>]+https?:/);
});
