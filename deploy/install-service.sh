#!/usr/bin/env bash
# Runs Rynata as a background service that starts on boot and restarts if it crashes.
# Run it from the project folder:  bash deploy/install-service.sh
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
NODE_BIN="$(command -v node || true)"
RUN_USER="${SUDO_USER:-$(id -un)}"

[ -n "$NODE_BIN" ] || { echo "Node.js isn't installed. Install Node 22 first (see deploy/DEPLOY.md)."; exit 1; }
[ -f .env ] || { echo "There's no .env file here. Copy .env.example to .env and fill it in first."; exit 1; }

for tool in ffmpeg yt-dlp; do
  command -v "$tool" > /dev/null || echo "Note: $tool isn't installed, so the music commands won't work yet (see deploy/MUSIC.md)."
done

echo "Installing packages and building..."
# A package-lock.json made on another OS (Windows/macOS) can lack the Linux build of TypeScript,
# so start from a clean slate. The versions in package.json are exact.
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund
npm run build

UNIT="[Unit]
Description=Rynata Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "$UNIT"
  exit 0
fi

echo "$UNIT" | sudo tee /etc/systemd/system/rynata.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now rynata
echo
echo "Done. Rynata is running."
echo "  See its log:   journalctl -u rynata -f"
echo "  Restart it:    sudo systemctl restart rynata"
echo "  Stop it:       sudo systemctl stop rynata"
