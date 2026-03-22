#!/usr/bin/env bash
set -euo pipefail

# --- Uninstall ---
if [ "${1:-}" = "uninstall" ]; then
  echo "🍰 CakeAgent Uninstall"
  echo "======================"
  echo ""
  echo "This will:"
  echo "  - Stop and remove the systemd service"
  echo "  - Delete data/ (database, settings, memory)"
  echo "  - Delete .env (credentials)"
  echo "  - Delete .mcp.json (installed tools)"
  echo "  - Delete node_modules/ and dist/"
  echo ""
  echo "  It will NOT delete source code, groups/main/CLAUDE.md, or credentials/"
  echo ""
  read -rp "   Proceed? [y/N]: " CONFIRM
  CONFIRM_LOWER=$(echo "$CONFIRM" | tr '[:upper:]' '[:lower:]')
  if [ "$CONFIRM_LOWER" != "y" ]; then
    echo "   Cancelled."
    exit 0
  fi

  echo ""
  if sudo systemctl is-active cakeagent &>/dev/null; then
    sudo systemctl stop cakeagent
    echo "   ✅ Service stopped"
  fi
  if sudo systemctl is-enabled cakeagent &>/dev/null 2>&1; then
    sudo systemctl disable cakeagent
    echo "   ✅ Service disabled"
  fi
  if [ -f /etc/systemd/system/cakeagent.service ]; then
    sudo rm /etc/systemd/system/cakeagent.service
    sudo systemctl daemon-reload
    echo "   ✅ Service file removed"
  fi

  rm -rf data/ node_modules/ dist/ .env .mcp.json
  echo "   ✅ Data, deps, and config removed"

  echo ""
  echo "🧹 Uninstalled. Source code preserved in $(pwd)"
  echo "   To fully remove: rm -rf $(pwd)"
  exit 0
fi

# --- Install ---

echo "🍰 CakeAgent Setup"
echo "==================="
echo ""

if ! command -v node &>/dev/null; then
  echo "❌ Node.js 18+ is required. Install: https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found $(node -v))"
  exit 1
fi

echo "1️⃣  Create a Telegram bot:"
echo "   → Open https://t.me/BotFather"
echo "   → Send /newbot and follow the prompts"
echo ""
read -rp "   Paste your bot token: " BOT_TOKEN

if [ -z "$BOT_TOKEN" ]; then
  echo "❌ Bot token required"
  exit 1
fi

echo "   Validating..."
RESULT=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
if echo "$RESULT" | grep -q '"ok":true'; then
  BOT_NAME=$(echo "$RESULT" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
  echo "   ✅ Bot found: $BOT_NAME"
else
  echo "   ❌ Invalid token. Check and try again."
  exit 1
fi

echo ""
echo "2️⃣  Get your Telegram user ID:"
echo "   → Message https://t.me/userinfobot on Telegram"
echo ""
read -rp "   Your Telegram user ID: " CHAT_ID

if [ -z "$CHAT_ID" ]; then
  echo "❌ Chat ID required"
  exit 1
fi

echo ""
echo "3️⃣  Claude authentication:"
echo ""
echo "   [1] Subscription token (recommended — uses your Claude Pro/Team plan)"
echo "   [2] API key (pay-per-use via console.anthropic.com)"
echo ""
read -rp "   Choose [1/2]: " AUTH_CHOICE

API_KEY=""
OAUTH_TOKEN=""
if [ "$AUTH_CHOICE" = "2" ]; then
  echo ""
  echo "   → Go to https://console.anthropic.com/settings/keys"
  echo "   → Create a key (starts with sk-ant-api)"
  echo ""
  read -rp "   Paste your API key: " API_KEY

  if [ -z "$API_KEY" ]; then
    echo "   ⚠️  No key provided. Add ANTHROPIC_API_KEY to .env before starting."
  else
    echo "   ✅ Key: ${API_KEY:0:10}$( printf '*%.0s' $(seq 1 $((${#API_KEY} - 14))) )${API_KEY: -4}"
  fi
else
  echo ""
  echo "   Run this in a separate terminal:"
  echo ""
  echo "     claude setup-token"
  echo ""
  echo "   It will display a token starting with sk-ant-oat..."
  echo "   Copy that token and paste it below."
  echo ""
  read -rp "   Paste your subscription token: " OAUTH_TOKEN

  if [ -z "$OAUTH_TOKEN" ]; then
    echo "   ⚠️  No token provided. Run 'claude setup-token' later and add"
    echo "      CLAUDE_CODE_OAUTH_TOKEN to .env before starting."
  else
    echo "   ✅ Token: ${OAUTH_TOKEN:0:10}$( printf '*%.0s' $(seq 1 $((${#OAUTH_TOKEN} - 14))) )${OAUTH_TOKEN: -4}"
  fi
fi

cat > .env <<EOF
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_CHAT_ID=${CHAT_ID}
EOF

if [ -n "$OAUTH_TOKEN" ]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN}" >> .env
elif [ -n "$API_KEY" ]; then
  echo "ANTHROPIC_API_KEY=${API_KEY}" >> .env
fi

chmod 600 .env
echo "   ✅ .env written (chmod 600)"

echo ""
echo "4️⃣  Installing dependencies..."
npm install
npm i edge-tts 2>/dev/null || true
npm run build
echo "   ✅ Built successfully"

mkdir -p data groups/main

echo ""
echo "5️⃣  Voice dependencies (optional)..."
if command -v ffmpeg &>/dev/null; then
  echo "   ✅ ffmpeg found"
else
  echo "   ffmpeg is needed for voice messages."
  read -rp "   Install ffmpeg? [Y/n]: " INSTALL_FFMPEG
  INSTALL_FFMPEG_LOWER=$(echo "$INSTALL_FFMPEG" | tr '[:upper:]' '[:lower:]')
  if [ "$INSTALL_FFMPEG_LOWER" != "n" ]; then
    sudo apt-get install -y ffmpeg 2>/dev/null || sudo dnf install -y ffmpeg 2>/dev/null || echo "   ⚠️  Could not install ffmpeg. Install manually."
  fi
fi

echo ""
echo "6️⃣  Install as systemd service?"
read -rp "   Install service? [Y/n]: " INSTALL_SERVICE
INSTALL_SERVICE_LOWER=$(echo "$INSTALL_SERVICE" | tr '[:upper:]' '[:lower:]')

if [ "$INSTALL_SERVICE_LOWER" != "n" ]; then
  INSTALL_DIR=$(pwd)
  CURRENT_USER=$(whoami)

  sed -e "s|/opt/cakeagent|${INSTALL_DIR}|g" \
      -e "s|User=cakeagent|User=${CURRENT_USER}|g" \
      -e "s|Group=cakeagent|Group=${CURRENT_USER}|g" \
      cakeagent.service > /tmp/cakeagent.service

  sudo cp /tmp/cakeagent.service /etc/systemd/system/cakeagent.service
  sudo systemctl daemon-reload
  sudo systemctl enable cakeagent
  sudo systemctl start cakeagent

  echo "   ✅ Service installed and started"
  echo ""
  echo "🎉 Done! Send a message to your bot on Telegram."
  echo ""
  echo "   sudo systemctl status cakeagent"
  echo "   sudo journalctl -u cakeagent -f"
  echo ""
  echo "   To uninstall: bash setup.sh uninstall"
else
  echo ""
  echo "🎉 Done! Start with: npm start"
  echo "   To uninstall: bash setup.sh uninstall"
fi
