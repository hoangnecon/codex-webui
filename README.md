# Codex WebUI

Free, self-hosted browser UI for Codex on **your** machine. Uses the official `codex app-server` protocol. Designed for private access (Tailscale or localhost) — not the public internet.

**Free forever.** No paid tier, no feature unlocks. Optional one-time tips via [agentmediatools.com/tip](https://agentmediatools.com/tip) if it helps.

**Downloads & setup guide:** [agentmediatools.com/webui](https://agentmediatools.com/webui)

## Features

- Browse and resume Codex threads
- Create a thread for any folder under `WORKSPACE_ROOT`
- Stream agent messages and tool activity
- Attach files and images with the picker, drag-and-drop, or clipboard paste (up to 10 files, 25 MB each)
- Browse recent uploads and generated workspace files in an authenticated file/image gallery
- Choose Restrictive, Moderate, or YOLO permissions backed by Codex approval and sandbox policies
- Queue follow-up messages while Codex works, or interrupt and send one immediately
- Keep the active execution plan and live chat updates across page refreshes
- Reasoning effort picker
- Interrupt active turns
- Approval controls when the agent requests them
- Responsive desktop and mobile layout
- Optional tip link (does not unlock features)

## Security model

- Binds to an explicit host (setup uses Tailscale IPv4, or `127.0.0.1`) — not `0.0.0.0` by default
- Codex App Server uses local `stdio` only; never exposed as a network port
- Scrypt-hashed password; raw password is not stored
- Sessions: random `HttpOnly`, `SameSite=Strict` cookies (default 24h)
- State-changing requests require the exact WebUI origin
- Login attempts rate limited in memory
- Working directories restricted to `WORKSPACE_ROOT` and real children
- Permission presets are validated on the server: Restrictive is read-only, Moderate confines writes to the workspace, and YOLO enables automatic full-machine access
- Browser never receives ChatGPT session or API credentials used by Codex

This is a **trusted personal tool**, not a multi-user or public SaaS. Do not bind it to `0.0.0.0`, expose it through router port forwarding, or place it behind a public tunnel.

## Setup

Prerequisites:

- Node.js 20+
- Working `codex` CLI / app-server
- Tailscale optional (recommended for phone / other devices)

```bash
cd /path/to/codex-webui
chmod +x ./scripts/setup.sh
./scripts/setup.sh
```

Optional before setup:

```bash
export WORKSPACE_ROOT="$HOME/projects"   # default: $HOME
```

Setup writes a mode-`600` `.env`, installs a systemd user service, and starts it. Open the printed URL (e.g. `http://100.x.x.x:4545`).

## Service commands

```bash
systemctl --user status codex-webui
systemctl --user restart codex-webui
journalctl --user -u codex-webui -f
```

## Development

```bash
npm run check
npm test
```

The `protocol/` directory can be regenerated for the installed Codex version and is intentionally ignored by Git:

```bash
rm -rf protocol
mkdir protocol
codex app-server generate-json-schema --out protocol
```

After upgrading the Codex CLI, regenerate the schema and test thread creation, history, streaming, interruption, and workspace execution before relying on the WebUI.

## Usage

| Action | How |
| --- | --- |
| New thread | **＋ New thread**, pick a workspace, type a message |
| Stop a run | **Stop** in the top bar |
| Activity | **Activity** rail for tools + plan |
| Approvals | Drawer when Codex requests permission |
| Files | Sidebar **▦ Files** for the authenticated gallery |
| Permissions | **Prefs → Agent permissions** |
| Follow-up | Send while working, then choose **Queue** or **Interrupt & send** |
| Tip | Sidebar **♡ Tip** (optional) |

## Optional tip

If this saved you time: [agentmediatools.com/tip](https://agentmediatools.com/tip?from=codex-webui) — never required, never unlocks features.

## Relation to Grok WebUI

Grok WebUI (`:4546`) talks to `grok agent stdio`. Codex WebUI (`:4545`) talks to `codex app-server`. Separate services; can run side by side.
