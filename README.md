# Codex WebUI

A private browser interface for the Codex instance on this laptop. It uses the official `codex app-server` protocol and is intended to be reached only through Tailscale.

## Security model

- The HTTP server binds to the laptop's Tailscale IPv4 address, not `0.0.0.0`.
- Codex App Server uses its local `stdio` transport and is never exposed on a network port.
- A scrypt-hashed password protects the UI; the raw password is not stored.
- Sessions use random, `HttpOnly`, `SameSite=Strict` cookies and expire after 24 hours by default.
- State-changing requests require the exact WebUI origin.
- Login attempts are rate limited in memory.
- New thread working directories are restricted to `/home/eric/workspace` and its real child directories.
- Threads run with full filesystem and network access and no approval prompts. This permits Git branch/commit operations, but commands can also affect files outside the selected workspace.
- The browser never receives the ChatGPT session or API credentials used by Codex.

This is a trusted personal tool, not a multi-user or public internet service. Do not bind it to `0.0.0.0`, expose it through router port forwarding, or place it behind a public tunnel. Because Codex has full access, avoid untrusted prompts and treat instructions embedded in websites as potentially malicious.

## Setup

From an interactive terminal on the laptop:

```bash
cd /home/eric/workspace/codex-webui
./scripts/setup.sh
```

Choose a unique password of at least 12 characters. Setup writes a mode-`600` `.env` containing only the password hash and local service settings, then installs a systemd user service.

Open the printed `http://100.x.x.x:4545` URL from a device connected to the same Tailscale network.

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

After upgrading the Codex CLI, regenerate the schema and test thread creation, history, streaming, interruption, sandbox enforcement, and automatic workspace execution before relying on the WebUI.

## Current scope

- Browse and resume Codex threads
- Create a thread for any folder under `/home/eric/workspace`
- Stream agent messages and tool activity
- Automatically run commands, file changes, and Git operations without approval prompts
- Interrupt active turns
- Select reasoning effort
- Responsive desktop and mobile layout

Interactive structured questionnaires are not yet presented as custom forms. Full-access mode means commands are not sandboxed or sent for approval.
