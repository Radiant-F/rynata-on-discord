# Running Rynata on a home server (Ubuntu)

## 1. Get the files there
Copy the project folder to the laptop (without `node_modules`; `package-lock.json` isn't needed either, it's rebuilt on the laptop). To keep what you set up on your main computer
(messages, alerts, logs, images), copy its `data/` folder too.
**Stop Rynata on your main computer before starting it on the laptop**, otherwise both answer every button click
and write every log twice.

Create `.env` from `.env.example` and fill in the token, password and API keys.
Then lock it down: `chmod 600 .env`

For the panel to be reachable from your main computer, set `HOST=0.0.0.0` in `.env`
(the Docker setup below already does this for you).

## 2a. With Docker (recommended)
```bash
# install Docker first (see https://docs.docker.com/engine/install/ubuntu/), then:
sudo usermod -aG docker $USER      # then log out and back in
docker compose up -d --build
docker compose logs -f             # watch it start (Ctrl+C leaves it running)
```
Update later: copy the new files over, then `docker compose up -d --build`.

## 2b. Without Docker
Install Node 22 (e.g. via https://github.com/nodesource/distributions) and, for music, ffmpeg and yt-dlp (see `deploy/MUSIC.md`), then:
```bash
bash deploy/install-service.sh
```
Update later: copy the new files over, then `rm -rf node_modules package-lock.json && npm install && npm run build && sudo systemctl restart rynata`.

## 3. Open the panel
On the laptop run `hostname -I`. On your main computer open `http://THAT-ADDRESS:3000`.
Give the laptop a fixed address in your router (a "DHCP reservation") so it never changes.

## Keep the laptop awake with the lid closed
```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo reboot
```

## Never expose the panel to the internet
No port forwarding. The panel speaks plain HTTP, so keep it on your home network (or reach it from outside
with a VPN like Tailscale).

## Want it closed to the network entirely?
Keep it on `127.0.0.1` (Docker: use the `127.0.0.1:3000:3000` line in `docker-compose.yml`), install
`openssh-server` on the laptop, and from your main computer run
`ssh -L 3000:localhost:3000 YOURUSER@LAPTOP-ADDRESS`, then open `http://localhost:3000`.
