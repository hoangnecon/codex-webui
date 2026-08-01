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

test('workspace-local tools and GitHub CLI auth propagate to Codex sessions', () => {
  assert.match(server, /LOCAL_TOOL_BIN/);
  assert.match(server, /LOCAL_GH_CONFIG/);
  assert.match(server, /LOCAL_GIT_CONFIG/);
  assert.match(server, /bridgeEnv\.PATH/);
  assert.match(server, /bridgeEnv\.GH_CONFIG_DIR/);
  assert.match(server, /bridgeEnv\.GIT_CONFIG_GLOBAL/);
  assert.match(server, /env: bridgeEnv/);
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

test('validated permission presets map to native Codex approval and sandbox policies', () => {
  assert.match(server, /function permissionPreset/);
  assert.match(server, /approvalPolicy: 'untrusted'/);
  assert.match(server, /approvalPolicy: 'on-request'/);
  assert.match(server, /approvalPolicy: 'never'/);
  assert.match(server, /type: 'readOnly'/);
  assert.match(server, /type: 'workspaceWrite'/);
  assert.match(server, /type: 'dangerFullAccess'/);
});

test('optimistic user messages survive history resync until disk catches up', () => {
  assert.match(app, /optimisticUsers/);
  assert.match(app, /function pruneOptimisticUsers/);
  assert.match(app, /function reapplyOptimisticUsers/);
  assert.match(app, /Never rebuild conversation mid-turn/);
  assert.match(app, /const turnInFlight = state\.running \|\| state\.awaitingTurn/);
});

test('completed streamed replies survive delayed thread-history persistence', () => {
  assert.match(app, /pendingAssistantText/);
  assert.match(app, /turn\/completed can arrive before thread\/read exposes the final assistant item/);
  assert.match(app, /const preserveLive = pendingText && !diskHasPendingAssistant/);
  assert.match(app, /30000/);
  assert.match(app, /scheduleCatchupResync\(\);/);
});

test('refresh reconnects SSE immediately and restores active plan events', () => {
  assert.match(server, /this\.recentEvents = \[\]/);
  assert.match(server, /recentEvents: bridge\.recentEvents/);
  assert.match(app, /reconnectEvents/);
  assert.match(app, /connectEvents\(\);\s*request\('\/api\/status'\)/);
  assert.match(app, /for \(const entry of replay\) handleCodexEvent\(entry\.event\)/);
  assert.match(app, /Fresh thread history is authoritative/);
  assert.doesNotMatch(app, /Boolean\(activeTurn\) \|\| state\.activeThreadIds\.has/);
  assert.match(app, /window\.addEventListener\('pageshow'/);
});

test('chat messages render lightweight markdown into safe DOM', () => {
  assert.match(app, /function renderMessageContent/);
  assert.match(app, /function appendInlineMarkdown/);
  assert.match(app, /function renderMarkdownBlocks/);
  assert.match(app, /md-code-block/);
  assert.match(app, /safeHref/);
  assert.doesNotMatch(app, /body\.innerHTML\s*=/);
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(css, /\.message-body\.streaming/);
  assert.match(css, /\.md-code-block/);
});

test('ship-quality thread board, export, draft, and mobile approvals exist', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(html, /id="fleet-strip"/);
  assert.match(html, /id="session-search"/);
  assert.match(html, /id="export-thread"/);
  assert.match(html, /id="copy-last"/);
  assert.match(app, /function updateFleetStrip/);
  assert.match(app, /function exportThreadMarkdown/);
  assert.match(app, /function notifyTurnComplete/);
  assert.match(css, /\.approval-actions button/);
  assert.match(css, /min-height: 48px/);
});

test('preferences, usage strip, and AMT bridge surfaces exist', () => {
  assert.match(html, /id="prefs-modal"/);
  assert.match(html, /id="session-tokens"/);
  assert.match(html, /id="provider-usage"/);
  assert.match(html, /id="amt-usage"/);
  assert.match(html, /id="pref-system-prompt"/);
  assert.match(html, /id="pref-theme"/);
  assert.match(app, /function loadPrefs/);
  assert.match(app, /function noteTokenUsage/);
  assert.match(app, /function workspaceSystemPrompt/);
  assert.match(app, /\/api\/amt\/status/);
  assert.match(server, /pathname === '\/api\/amt\/status'/);
  assert.match(server, /pathname === '\/api\/amt\/connect'/);
  assert.match(server, /systemPrompt/);
  assert.match(server, /amtToolsEnabled/);
});

test('Codex account weekly/rolling rate limits are exposed and rendered', () => {
  assert.match(server, /account\/rateLimits\/read/);
  assert.match(server, /pathname === '\/api\/account\/rate-limits'/);
  assert.match(app, /function refreshAccountRateLimits/);
  assert.match(app, /function applyAccountRateLimits/);
  assert.match(app, /account\/rateLimits\/updated/);
  assert.match(app, /% .* left/);
});

test('optional tip modal is free framing and opens AMT tip page externally', () => {
  assert.match(html, /id="tip-modal"/);
  assert.match(html, /Free forever — optional tip/);
  assert.match(html, /Nothing unlocks; no account required/);
  assert.match(html, /data-tip-amount="3"/);
  assert.match(html, /data-tip-amount="7"/);
  assert.match(html, /data-tip-amount="15"/);
  assert.match(app, /agentmediatools\.com\/tip/);
  assert.match(app, /from', 'codex-webui'/);
  assert.doesNotMatch(html, /premium tier|pro plan|paywall/i);
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

test('generated images render through an authenticated workspace-confined endpoint', () => {
  assert.match(server, /function allowedImage/);
  assert.match(server, /Image is outside the allowed workspace/);
  assert.match(server, /pathname === '\/api\/image'/);
  assert.match(app, /function extractImages/);
  assert.match(app, /function renderMessageContent/);
  assert.match(app, /\/api\/image\?path=/);
  assert.doesNotMatch(app, /innerHTML\s*=/);
});

test('authenticated uploads are bounded, confined, and passed to Codex safely', () => {
  assert.match(server, /pathname === '\/api\/upload'/);
  assert.match(server, /const MAX_UPLOAD_BYTES = 25 \* 1024 \* 1024/);
  assert.match(server, /const MAX_ATTACHMENTS = 10/);
  assert.match(server, /function allowedUpload/);
  assert.match(server, /Attachment is outside the upload area/);
  assert.match(server, /type: 'localImage', path: resolved/);
  assert.match(html, /id="attach-button"/);
  assert.match(html, /id="file-input"/);
  assert.match(app, /async function queueFiles/);
  assert.match(app, /dataTransfer\?\.files/);
  assert.match(app, /clipboardData\?\.items/);
});

test('authenticated gallery lists only allowlisted safe files from confined roots', () => {
  assert.match(server, /const GALLERY_TYPES/);
  assert.match(server, /function allowedGalleryFile/);
  assert.match(server, /function galleryFiles/);
  assert.match(server, /pathname === '\/api\/gallery'/);
  assert.match(server, /pathname === '\/api\/file'/);
  assert.match(html, /id="gallery-modal"/);
  assert.match(html, /id="pref-permission-mode"/);
  assert.match(app, /function renderGallery/);
});

test('long conversations remain scrollable and provide a jump-to-latest control', () => {
  assert.match(html, /id="jump-latest"/);
  assert.match(app, /function scrollToLatest/);
  assert.match(app, /nearConversationBottom/);
  assert.match(app, /followOutput/);
});

test('messages can be queued or interrupt the active turn without being lost on refresh', () => {
  assert.match(html, /id="message-queue"/);
  assert.match(html, /id="interrupt-send"/);
  assert.match(app, /QUEUE_KEY/);
  assert.match(app, /function enqueueStaged/);
  assert.match(app, /function flushMessageQueue/);
  assert.match(app, /localStorage\.setItem\(QUEUE_KEY/);
});

test('slash command menu covers the CLI catalog and supports keyboard selection', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(html, /id="command-menu"/);
  assert.match(html, /\/ for commands/);
  assert.match(app, /const WEBUI_COMMANDS/);
  assert.match(app, /name: 'compact'/);
  assert.match(app, /name: 'review'/);
  assert.match(app, /name: 'model'/);
  assert.match(app, /name: 'plugins'/);
  assert.match(app, /CLI_ONLY/);
  assert.match(app, /function showCommands/);
  assert.match(app, /function runCommand/);
  assert.match(server, /thread\/compact\/start/);
  assert.match(server, /review\/start/);
  assert.match(server, /thread\/name\/set/);
  assert.match(server, /thread\/fork/);
  assert.match(server, /thread\/archive/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /command\.action\(\)/);
  assert.match(css, /\.command-menu/);
});

test('live activity panel renders supported progress without private reasoning text', () => {
  assert.match(html, /id="activity-rail"/);
  assert.match(app, /item\/reasoning\/summaryTextDelta/);
  assert.match(app, /turn\/plan\/updated/);
  assert.match(app, /item\/commandExecution\/outputDelta/);
  assert.match(app, /item\/fileChange\/patchUpdated/);
  assert.doesNotMatch(app, /method === 'item\/reasoning\/textDelta'/);
});

test('routine command, reasoning, and file activity never spam the chat transcript', () => {
  assert.match(app, /renderActivityItem\(item, false\)/);
  assert.match(app, /renderActivityItem\(item, true\)/);
  assert.doesNotMatch(app, /addEvent\(`Started \$\{type\}`\)/);
  assert.doesNotMatch(app, /addEvent\('Command completed'/);
  assert.match(app, /item\/agentMessage\/delta/);
  assert.match(app, /addMessage\('assistant'/);
});

test('live assistant items keep the same message boundaries as refreshed history', () => {
  assert.match(app, /streamingItemId/);
  assert.match(app, /itemId !== state\.streamingItemId/);
  assert.match(app, /finalizeStreamingMessage\(\)/);
  assert.match(app, /item\.id === state\.streamingItemId/);
});

test('commentary is grouped into one progress card instead of normal chat bubbles', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(app, /phase === 'commentary'/);
  assert.match(app, /function addProgressUpdate/);
  assert.match(app, /Progress · \$\{state\.progressCount\}/);
  assert.match(app, /state\.streamingPhase !== 'commentary'/);
  assert.match(css, /\.progress-card/);
});

test('execution plans remain legible and survive history resyncs for the full turn', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(html, /Execution plan/);
  assert.match(app, /currentPlan/);
  assert.match(app, /normalizePlanStatus/);
  assert.match(app, /resetActivity\(\{ preservePlan: true \}\)/);
  assert.match(app, /aria-current/);
  assert.match(css, /\.plan-step\.in-progress/);
  assert.match(css, /\.plan-step\.completed/);
  assert.doesNotMatch(css, /\.plan-step\.completed[^}]*text-decoration:\s*line-through/s);
});

test('mobile layout supports iPhone safe areas, dynamic viewport, and keyboard-safe controls', () => {
  const login = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  const viewport = fs.readFileSync(path.join(root, 'public/viewport.js'), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.match(login, /viewport-fit=cover/);
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /-webkit-overflow-scrolling: touch/);
  assert.match(css, /\.composer textarea \{[^}]*font-size: 16px/);
  assert.match(css, /top: var\(--app-top, 0px\)/);
  assert.match(css, /overflow-anchor: none/);
  assert.match(viewport, /visualViewport/);
  assert.match(viewport, /offsetTop/);
  assert.match(app, /function keepLatestVisibleWhileTyping/);
  assert.match(app, /visualViewport\?\.addEventListener\('resize', restoreLatest\)/);
});
