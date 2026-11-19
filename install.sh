#!/usr/bin/env bash
set -euo pipefail

# Guided local installation. Set CHAT_INSTALL_UNATTENDED=1 only for automation.
repo_url="${CHAT_REPO_URL:-https://github.com/MasterAkbariDev/chat-app.git}"
destination="${CHAT_INSTALL_DIR:-./chat-app}"
web_port="${CHAT_WEB_PORT:-3000}"
api_port="${CHAT_API_PORT:-3001}"

for command in git docker openssl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose is required." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Start Docker and ensure your user can access it." >&2; exit 1; }

if [ "${CHAT_INSTALL_UNATTENDED:-0}" != 1 ]; then
  [ -r /dev/tty ] || { echo "An interactive terminal is required." >&2; exit 1; }
  echo "Chat local installer"
  echo "This clones the repository and starts Docker containers for the web app, API, MongoDB and Redis."
  read -r -p "Install directory [$destination]: " answer </dev/tty
  destination="${answer:-$destination}"
  read -r -p "Web port [$web_port]: " answer </dev/tty
  web_port="${answer:-$web_port}"
  read -r -p "API port [$api_port]: " answer </dev/tty
  api_port="${answer:-$api_port}"
fi

for port in "$web_port" "$api_port"; do
  case "$port" in ''|*[!0-9]*) echo "Ports must be whole numbers from 1024 to 65535." >&2; exit 1;; esac
  [ "${#port}" -le 5 ] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || { echo "Ports must be from 1024 to 65535." >&2; exit 1; }
done
[ "$web_port" != "$api_port" ] || { echo "Choose different web and API ports." >&2; exit 1; }
[ ! -e "$destination" ] || { echo "Install directory already exists: $destination" >&2; exit 1; }

echo "Cloning into $destination..."
git clone -- "$repo_url" "$destination"
cd "$destination/backend"
umask 077
secret="$(openssl rand -hex 32)"
cat > .env <<EOF
JWT_SECRET=$secret
BIND_ADDRESS=127.0.0.1
CORS_ORIGIN=http://localhost:$web_port
NEXT_PUBLIC_API_URL=http://localhost:$api_port
PORT=$api_port
FRONTEND_PORT=$web_port
EOF

echo "Building the local stack. This can take several minutes..."
docker compose up -d --build app frontend
echo
echo "Web:  http://localhost:$web_port"
echo "API:  http://localhost:$api_port/docs"
echo "Logs: cd \"$destination/backend\" && docker compose logs -f app frontend"
echo "Stop: cd \"$destination/backend\" && docker compose down"
echo "Calling and push notifications require additional configuration."
