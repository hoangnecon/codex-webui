#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/codex-webui.service"

if [[ -f "$ENV_FILE" ]]; then
  echo "Configuration already exists at $ENV_FILE"
  echo "Remove it manually only if you intentionally want to replace the WebUI password."
  exit 1
fi

TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n 1)"
if [[ -z "$TAILSCALE_IP" ]]; then
  echo "No Tailscale IPv4 address was found. Falling back to 127.0.0.1 for local-only use." >&2
  TAILSCALE_IP="127.0.0.1"
fi

if [[ -t 0 ]]; then
  read -r -s -p "Choose a WebUI password (12+ characters): " PASSWORD
  echo
  read -r -s -p "Confirm password: " CONFIRM
  echo
else
  echo "Run this setup script from an interactive terminal." >&2
  exit 1
fi

if [[ ${#PASSWORD} -lt 12 ]]; then
  echo "Password must contain at least 12 characters." >&2
  exit 1
fi
if [[ "$PASSWORD" != "$CONFIRM" ]]; then
  echo "Passwords did not match." >&2
  exit 1
fi

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME}"

umask 077
PASSWORD="$PASSWORD" HOST="$TAILSCALE_IP" ROOT="$ROOT" \
WORKSPACE_ROOT="$WORKSPACE_ROOT" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const salt = crypto.randomBytes(24).toString('hex');
const hash = crypto.scryptSync(process.env.PASSWORD, salt, 64).toString('hex');
const contents = [
  `HOST=${process.env.HOST}`,
  'PORT=4545',
  `WORKSPACE_ROOT=${process.env.WORKSPACE_ROOT}`,
  'SESSION_HOURS=24',
  `PASSWORD_SALT=${salt}`,
  `PASSWORD_HASH=${hash}`,
  '',
].join('\n');
fs.writeFileSync(path.join(process.env.ROOT, '.env'), contents, { mode: 0o600 });
NODE

mkdir -p "$ROOT/data/uploads"
unset PASSWORD CONFIRM

mkdir -p "$SERVICE_DIR"
sed -e "s|__PROJECT_ROOT__|$ROOT|g" \
  -e "s|__WORKSPACE_ROOT__|$WORKSPACE_ROOT|g" \
  "$ROOT/systemd/codex-webui.service" > "$SERVICE_FILE"
systemctl --user daemon-reload
systemctl --user enable --now codex-webui.service

echo
echo "Codex WebUI is starting at http://$TAILSCALE_IP:4545"
echo "Check it with: systemctl --user status codex-webui"
