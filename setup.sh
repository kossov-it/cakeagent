#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/cakeagent"
SERVICE_USER="cakeagent"
SERVICE_NAME="cakeagent"

# --- Uninstall ---
if [ "${1:-}" = "uninstall" ]; then
  echo "🍰 CakeAgent — Uninstall"
  echo ""
  echo "   This will completely remove CakeAgent and revert the system:"
  echo "   - Stop and remove systemd service"
  echo "   - Delete $INSTALL_DIR (code, data, config, everything)"
  echo "   - Delete system user '$SERVICE_USER' and its home"
  echo "   - Remove sudoers entry"
  echo "   - Remove any packages the agent installed (ffmpeg, edge-tts)"
  echo ""
  read -rp "   Type 'yes' to confirm: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "   Cancelled."
    exit 0
  fi

  echo ""

  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo systemctl daemon-reload 2>/dev/null || true
  echo "   ✅ Service removed"

  sudo rm -f "/etc/sudoers.d/$SERVICE_NAME"
  echo "   ✅ Sudoers entry removed"

  sudo rm -rf "$INSTALL_DIR"
  echo "   ✅ $INSTALL_DIR removed"

  if id "$SERVICE_USER" &>/dev/null; then
    sudo userdel -r "$SERVICE_USER" 2>/dev/null || true
    echo "   ✅ User '$SERVICE_USER' removed"
  fi

  sudo rm -rf "/home/$SERVICE_USER" 2>/dev/null || true

  echo ""
  echo "🧹 Fully uninstalled. System reverted to pre-install state."
  exit 0
fi

# --- Install ---

echo "🍰 CakeAgent Setup"
echo "==================="
echo ""

echo "1️⃣  Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "   ❌ Node.js 18+ required. Install: https://nodejs.org"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "   ❌ Node.js 18+ required (found $(node -v))"
  exit 1
fi
echo "   ✅ Node.js $(node -v)"

echo ""
echo "2️⃣  Creating system user..."

if id "$SERVICE_USER" &>/dev/null; then
  echo "   ✅ User '$SERVICE_USER' exists"
else
  sudo useradd -r -m -d "$INSTALL_DIR" -s /usr/sbin/nologin "$SERVICE_USER"
  echo "   ✅ Created user '$SERVICE_USER'"
fi

echo ""
echo "3️⃣  Installing to $INSTALL_DIR..."

sudo mkdir -p "$INSTALL_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  sudo cp -r "$SCRIPT_DIR"/{src,channels,groups,package.json,package-lock.json,tsconfig.json,cakeagent.service,.env.example,.gitignore} "$INSTALL_DIR/" 2>/dev/null || true
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
fi

echo ""
echo "4️⃣  Installing dependencies..."

sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && npm install 2>&1" | tail -1
sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && npm i edge-tts 2>/dev/null" || true
sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && npm run build 2>&1" | tail -1
echo "   ✅ Built"

echo ""
echo "5️⃣  Configuring agent permissions..."

SUDOERS_FILE="/etc/sudoers.d/$SERVICE_NAME"
echo "$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt" | sudo tee "$SUDOERS_FILE" > /dev/null
sudo chmod 440 "$SUDOERS_FILE"
echo "   ✅ Agent can install system packages"

sudo -u "$SERVICE_USER" mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/groups/main" "$INSTALL_DIR/credentials"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "6️⃣  Telegram bot setup:"
echo ""
echo "   → Create a bot: https://t.me/BotFather (send /newbot)"
echo ""
read -rp "   Bot token: " BOT_TOKEN

if [ -z "$BOT_TOKEN" ]; then
  echo "   ❌ Required"
  exit 1
fi

echo "   Validating..."
RESULT=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
if echo "$RESULT" | grep -q '"ok":true'; then
  BOT_NAME=$(echo "$RESULT" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
  echo "   ✅ $BOT_NAME"
else
  echo "   ❌ Invalid token"
  exit 1
fi

echo ""
echo "   → Get your user ID: https://t.me/userinfobot"
echo ""
read -rp "   Your Telegram user ID: " CHAT_ID

if [ -z "$CHAT_ID" ]; then
  echo "   ❌ Required"
  exit 1
fi

echo ""
echo "7️⃣  Claude authentication:"
echo ""
echo "   [1] Subscription token (recommended)"
echo "       Run 'claude setup-token' in another terminal → paste the token"
echo ""
echo "   [2] API key (pay-per-use)"
echo "       Get from https://console.anthropic.com/settings/keys"
echo ""
read -rp "   Choose [1/2]: " AUTH_CHOICE

AUTH_KEY=""
AUTH_VAR=""
if [ "$AUTH_CHOICE" = "2" ]; then
  read -rp "   API key: " AUTH_KEY
  AUTH_VAR="ANTHROPIC_API_KEY"
else
  echo ""
  echo "   Run 'claude setup-token' in another terminal now."
  echo "   It gives you a token starting with sk-ant-oat..."
  echo ""
  read -rp "   Subscription token: " AUTH_KEY
  AUTH_VAR="CLAUDE_CODE_OAUTH_TOKEN"
fi

if [ -z "$AUTH_KEY" ]; then
  echo "   ⚠️  No auth provided. Add it to $INSTALL_DIR/.env before starting."
else
  MASKED="${AUTH_KEY:0:10}$(printf '*%.0s' $(seq 1 $((${#AUTH_KEY} - 14))))${AUTH_KEY: -4}"
  echo "   ✅ $MASKED"
fi

ENV_FILE="$INSTALL_DIR/.env"
sudo bash -c "cat > $ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_CHAT_ID=${CHAT_ID}
EOF

if [ -n "$AUTH_KEY" ]; then
  sudo bash -c "echo '${AUTH_VAR}=${AUTH_KEY}' >> $ENV_FILE"
fi

sudo chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"
echo ""
echo "   ✅ Configuration saved"

echo ""
echo "8️⃣  Starting service..."

sed -e "s|/opt/cakeagent|${INSTALL_DIR}|g" \
    -e "s|User=cakeagent|User=${SERVICE_USER}|g" \
    -e "s|Group=cakeagent|Group=${SERVICE_USER}|g" \
    "$INSTALL_DIR/cakeagent.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

echo "   ✅ Running"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎉 CakeAgent is running!"
echo ""
echo "   Send a message to your bot on Telegram."
echo "   On first message, it guides you through personalization."
echo ""
echo "   Logs:      sudo journalctl -u $SERVICE_NAME -f"
echo "   Restart:   /restart (via Telegram)"
echo "   Uninstall: sudo bash setup.sh uninstall"
