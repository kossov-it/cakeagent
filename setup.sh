#!/usr/bin/env bash
set -euo pipefail

# For interactive install (curl | bash), redirect stdin from tty
# Skip for non-interactive modes (update, uninstall, install-config, remove-config, certbot, harden-sshd)
if [ "${1:-}" != "update" ] && [ "${1:-}" != "uninstall" ] && \
   [ "${1:-}" != "install-config" ] && [ "${1:-}" != "remove-config" ] && \
   [ "${1:-}" != "certbot" ] && [ "${1:-}" != "harden-sshd" ] && \
   [ ! -t 0 ] && [ -e /dev/tty ]; then
  exec </dev/tty
fi

INSTALL_DIR="/opt/cakeagent"
SERVICE_USER="cakeagent"
SERVICE_NAME="cakeagent"

# --- Shared: validate a target path for install-config / remove-config ---
# Writes error to stderr and returns 1 on failure, 0 on success.
validate_config_path() {
  local target="$1"

  # Reject empty, relative, and paths containing traversal components
  case "$target" in
    ''|*' '*) echo "Denied: invalid path" >&2; return 1 ;;
    /*) ;;
    *) echo "Denied: path must be absolute" >&2; return 1 ;;
  esac
  case "$target" in
    *..*|*/./*|*//*) echo "Denied: path traversal or normalization issue in: $target" >&2; return 1 ;;
  esac

  # Hard-deny on the most critical files — even if a prefix allowlists them
  case "$target" in
    /etc/sudoers|/etc/sudoers.d|/etc/sudoers.d/*|\
    /etc/shadow|/etc/shadow-|/etc/gshadow|/etc/gshadow-|\
    /etc/passwd|/etc/passwd-|/etc/group|/etc/group-|\
    /etc/ssh|/etc/ssh/*|\
    /etc/pam.d|/etc/pam.d/*|/etc/security|/etc/security/*|\
    /etc/ld.so.preload|/etc/ld.so.conf|/etc/ld.so.conf.d/*|\
    /etc/profile|/etc/profile.d/*|/etc/bash.bashrc|/etc/environment|\
    /etc/cron.d/*|/etc/cron.daily/*|/etc/cron.hourly/*|/etc/cron.monthly/*|/etc/cron.weekly/*|/etc/crontab|\
    /etc/hosts|/etc/hostname|/etc/resolv.conf|/etc/fstab|/etc/nsswitch.conf|\
    /etc/apt/sources.list|/etc/apt/trusted.gpg*|\
    /etc/systemd/system/cakeagent*|\
    /etc/sysctl.conf)
      echo "Denied: critical file: $target" >&2
      return 1
      ;;
  esac

  # Allowlist of directories where writes are permitted
  case "$target" in
    /etc/nginx/sites-available/*|/etc/nginx/sites-enabled/*|\
    /etc/nginx/conf.d/*|/etc/nginx/snippets/*|/etc/nginx/modules-available/*|\
    /etc/apache2/sites-available/*|/etc/apache2/sites-enabled/*|/etc/apache2/conf-available/*|\
    /etc/caddy/*|/etc/caddy/Caddyfile|\
    /etc/systemd/system/*.service|/etc/systemd/system/*.timer|/etc/systemd/system/*.socket|\
    /etc/systemd/system/*.path|/etc/systemd/system/*.mount|/etc/systemd/system/*.target|\
    /etc/systemd/system/*.conf.d/*.conf|\
    /etc/systemd/resolved.conf.d/*.conf|/etc/systemd/network/*|\
    /etc/letsencrypt/cli.ini|/etc/letsencrypt/renewal-hooks/*/*|\
    /etc/sysctl.d/*.conf|\
    /etc/apt/sources.list.d/*.list|/etc/apt/sources.list.d/*.sources|\
    /etc/apt/preferences.d/*|/etc/apt/keyrings/*|/etc/apt/apt.conf.d/*|\
    /etc/prometheus/*|/etc/grafana/*|/etc/alertmanager/*|\
    /etc/logrotate.d/*|\
    /etc/default/*|\
    /etc/mysql/conf.d/*|/etc/mysql/mariadb.conf.d/*|\
    /etc/postgresql/*/main/conf.d/*|\
    /etc/redis/*.conf|\
    /etc/fail2ban/jail.d/*|/etc/fail2ban/filter.d/*|/etc/fail2ban/action.d/*|\
    /etc/ufw/applications.d/*|\
    /etc/nftables.d/*|/etc/nftables.conf)
      ;;
    *)
      echo "Denied: path not in allowlist: $target" >&2
      echo "Allowed prefixes include: /etc/nginx/, /etc/systemd/system/*.service, /etc/sysctl.d/, /etc/apt/sources.list.d/, /etc/logrotate.d/, etc. See setup.sh validate_config_path." >&2
      return 1
      ;;
  esac

  return 0
}

# --- install-config: write a config file to /etc/ with path validation ---
# Usage:
#   sudo bash setup.sh install-config <target>                  # content from stdin
#   sudo bash setup.sh install-config <target> <source-file>    # copy from source
# The file-input form lets agents avoid embedding nginx-style `{...;...}` in
# shell commands (the bash hook treats those as brace groups). Write the
# content with the Write tool first, then install it.
if [ "${1:-}" = "install-config" ]; then
  TARGET="${2:-}"
  SOURCE="${3:-}"
  if ! validate_config_path "$TARGET"; then
    exit 1
  fi
  # Reject directory-shaped targets (trailing slash, no filename).
  case "$TARGET" in */) echo "Denied: target must be a file, not a directory: $TARGET" >&2; exit 1 ;; esac
  if [ -n "$SOURCE" ]; then
    case "$SOURCE" in
      /opt/cakeagent/data/*|/tmp/*) ;;
      *) echo "Denied: source must be under /opt/cakeagent/data/ or /tmp/: $SOURCE" >&2; exit 1 ;;
    esac
    case "$SOURCE" in *..*) echo "Denied: path traversal in source: $SOURCE" >&2; exit 1 ;; esac
    if [ ! -f "$SOURCE" ]; then
      echo "Source file not found: $SOURCE" >&2
      exit 1
    fi
  fi
  PARENT="$(dirname "$TARGET")"
  mkdir -p "$PARENT"
  TMP="$(mktemp "${TARGET}.XXXXXX.tmp")"
  trap 'rm -f "$TMP"' EXIT
  if [ -n "$SOURCE" ]; then
    head -c $((1024 * 1024)) < "$SOURCE" > "$TMP"
  else
    head -c $((1024 * 1024)) > "$TMP"
  fi
  chmod 0644 "$TMP"
  mv "$TMP" "$TARGET"
  trap - EXIT
  echo "Wrote $TARGET ($(wc -c < "$TARGET") bytes)"
  exit 0
fi

# --- remove-config: delete a file in /etc/ with the same path validation ---
# Usage: sudo bash setup.sh remove-config <absolute-path>
if [ "${1:-}" = "remove-config" ]; then
  TARGET="${2:-}"
  if ! validate_config_path "$TARGET"; then
    exit 1
  fi
  if [ ! -e "$TARGET" ]; then
    echo "Not found: $TARGET" >&2
    exit 1
  fi
  if [ ! -f "$TARGET" ]; then
    echo "Denied: only regular files may be removed: $TARGET" >&2
    exit 1
  fi
  rm -f "$TARGET"
  echo "Removed $TARGET"
  exit 0
fi

# --- certbot: wrap certbot with dangerous flags stripped ---
# Sudoers already allows `bash setup.sh *`, inheriting root.
# Hook flags (--pre-hook, --post-hook, --deploy-hook, --renew-hook,
# --manual-auth-hook, --manual-cleanup-hook) are denied because they exec
# arbitrary commands as root. Instead, drop scripts into
# /etc/letsencrypt/renewal-hooks/{pre,deploy,post}/ via install-config —
# that path is allowlisted and atomically written.
# Path-redirection flags (--config, --config-dir, --work-dir, --logs-dir)
# are denied too — they could redirect certbot writes outside /etc/letsencrypt.
if [ "${1:-}" = "certbot" ]; then
  shift
  for arg in "$@"; do
    case "$arg" in
      --pre-hook|--post-hook|--deploy-hook|--renew-hook|--manual-auth-hook|--manual-cleanup-hook)
        echo "Denied: $arg — use /etc/letsencrypt/renewal-hooks/{pre,deploy,post}/ via install-config instead" >&2
        exit 1
        ;;
      --pre-hook=*|--post-hook=*|--deploy-hook=*|--renew-hook=*|--manual-auth-hook=*|--manual-cleanup-hook=*)
        echo "Denied: ${arg%%=*} — use /etc/letsencrypt/renewal-hooks/{pre,deploy,post}/ via install-config instead" >&2
        exit 1
        ;;
      --config|--config-dir|--work-dir|--logs-dir)
        echo "Denied: $arg — path redirection not allowed (certbot must use default /etc/letsencrypt layout)" >&2
        exit 1
        ;;
      --config=*|--config-dir=*|--work-dir=*|--logs-dir=*)
        echo "Denied: ${arg%%=*} — path redirection not allowed" >&2
        exit 1
        ;;
    esac
  done
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot not installed — run: sudo apt-get install -y certbot python3-certbot-nginx" >&2
    exit 1
  fi
  exec certbot "$@"
fi

# --- harden-sshd: install a known-safe hardening drop-in and reload sshd ---
# Writes /etc/ssh/sshd_config.d/99-cakeagent-hardening.conf with a fixed,
# vetted ruleset (no user input — no foot-gun), validates the combined
# config via `sshd -t`, then reloads sshd. On validation failure, the
# drop-in is reverted to its previous contents (or deleted if new).
#
# Rationale: letting the agent write arbitrary sshd_config.d/*.conf would
# allow directives like Port, ListenAddress, AuthorizedKeysFile,
# PermitRootLogin, or Match blocks to weaken auth or enable lockout. A
# fixed-content helper bounds the blast radius while still letting the
# agent complete a common admin task ("harden SSH") on request.
if [ "${1:-}" = "harden-sshd" ]; then
  DROPIN="/etc/ssh/sshd_config.d/99-cakeagent-hardening.conf"
  BACKUP=""
  if [ -f "$DROPIN" ]; then
    BACKUP="$(mktemp "${DROPIN}.bak.XXXXXX")"
    cp -a "$DROPIN" "$BACKUP"
  fi
  mkdir -p /etc/ssh/sshd_config.d
  TMP="$(mktemp "${DROPIN}.XXXXXX.tmp")"
  trap 'rm -f "$TMP"; [ -n "$BACKUP" ] && rm -f "$BACKUP"' EXIT
  cat > "$TMP" <<'HARDENING'
# Managed by CakeAgent (setup.sh harden-sshd). Do not edit manually.
# Disables password auth, root login, agent forwarding, and limits auth attempts.
PermitRootLogin prohibit-password
PasswordAuthentication no
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
HARDENING
  chmod 0644 "$TMP"
  mv "$TMP" "$DROPIN"
  if ! sshd -t 2>&1; then
    echo "sshd -t failed after installing $DROPIN — reverting" >&2
    if [ -n "$BACKUP" ]; then
      mv "$BACKUP" "$DROPIN"
      BACKUP=""
    else
      rm -f "$DROPIN"
    fi
    trap - EXIT
    exit 1
  fi
  [ -n "$BACKUP" ] && rm -f "$BACKUP"
  trap - EXIT
  # Reload via systemctl — ssh.service ExecReload runs `sshd -t` first on
  # Debian/Ubuntu, so a broken reload won't kill the running daemon.
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  echo "Installed $DROPIN and reloaded sshd"
  exit 0
fi

# --- Update (pulls code, builds, refreshes service, restarts) ---
if [ "${1:-}" = "update" ]; then
  echo "🍰 Updating CakeAgent..."
  cd "$INSTALL_DIR"
  BEFORE=$(sudo -u "$SERVICE_USER" git rev-parse HEAD)
  sudo -u "$SERVICE_USER" git pull
  AFTER=$(sudo -u "$SERVICE_USER" git rev-parse HEAD)
  NODE_DIR=$(dirname "$(command -v node)")
  if [ "$BEFORE" != "$AFTER" ]; then
    if ! sudo -u "$SERVICE_USER" bash -c "export PATH='$NODE_DIR':\$PATH && npm run build"; then
      echo "   ❌ Build failed — rolling back to previous version"
      sudo -u "$SERVICE_USER" git reset --hard "$BEFORE"
      exit 1
    fi
  else
    echo "   No changes."
  fi
  # Refresh sudoers + service file (skip if /etc is read-only, e.g. inside systemd sandbox)
  if touch /etc/sudoers.d/.writetest 2>/dev/null; then
    rm -f /etc/sudoers.d/.writetest
    SUDOERS_FILE="/etc/sudoers.d/$SERVICE_NAME"
    cat <<SUDOERS > "$SUDOERS_FILE"
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/systemctl, /usr/sbin/nft, /usr/sbin/iptables, /usr/sbin/ip6tables, /usr/sbin/ufw, /usr/bin/firewall-cmd, /usr/bin/fail2ban-client, /usr/sbin/netfilter-persistent, /usr/bin/bash $INSTALL_DIR/setup.sh *
Defaults:$SERVICE_USER !requiretty
Defaults:$SERVICE_USER env_keep += "DEBIAN_FRONTEND"
SUDOERS
    chmod 440 "$SUDOERS_FILE"
    if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
      echo "   ❌ Sudoers syntax error — removing broken file"
      rm -f "$SUDOERS_FILE"
    fi
    sed -e "s|/opt/cakeagent|${INSTALL_DIR}|g" \
        -e "s|User=cakeagent|User=${SERVICE_USER}|g" \
        -e "s|Group=cakeagent|Group=${SERVICE_USER}|g" \
        -e "/\[Service\]/a Environment=PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        "$INSTALL_DIR/cakeagent.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
  fi
  if [ "$BEFORE" != "$AFTER" ]; then
    # Restart if we can (SSH context). Inside systemd sandbox, the caller handles restart.
    systemctl restart "$SERVICE_NAME" 2>/dev/null && echo "✅ Updated and restarted." || echo "✅ Updated and built. Restart pending."
  else
    echo "✅ No changes."
  fi
  exit 0
fi

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

  if id "$SERVICE_USER" &>/dev/null; then
    sudo userdel "$SERVICE_USER" 2>/dev/null || true
    echo "   ✅ User '$SERVICE_USER' removed"
  fi

  sudo rm -rf "$INSTALL_DIR"
  echo "   ✅ $INSTALL_DIR removed"

  echo ""
  echo "🧹 Fully uninstalled."
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

sudo mkdir -p "$INSTALL_DIR"
if id "$SERVICE_USER" &>/dev/null; then
  echo "   ✅ User '$SERVICE_USER' exists"
else
  sudo useradd -r -d "$INSTALL_DIR" -s /usr/sbin/nologin "$SERVICE_USER"
  echo "   ✅ Created user '$SERVICE_USER'"
fi
sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo ""
echo "3️⃣  Installing to $INSTALL_DIR..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  sudo cp -a "$SCRIPT_DIR"/. "$INSTALL_DIR/"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
fi

echo ""
echo "4️⃣  Installing dependencies..."

NODE_BIN=$(command -v node)
NPM_BIN=$(command -v npm)
NPX_BIN=$(command -v npx)
NODE_DIR=$(dirname "$NODE_BIN")

sudo -u "$SERVICE_USER" bash -c "export PATH='$NODE_DIR':\$PATH && cd '$INSTALL_DIR' && '$NPM_BIN' install --no-fund --no-audit 2>&1" | tail -3
sudo -u "$SERVICE_USER" bash -c "export PATH='$NODE_DIR':\$PATH && cd '$INSTALL_DIR' && '$NPM_BIN' i edge-tts --no-fund --no-audit 2>/dev/null" || true
echo "   Building..."
sudo -u "$SERVICE_USER" bash -c "export PATH='$NODE_DIR':\$PATH && cd '$INSTALL_DIR' && '$NPM_BIN' run build" || {
  echo "   ❌ Build failed"
  exit 1
}
echo "   ✅ Built"

echo ""
echo "5️⃣  Configuring agent permissions..."

SUDOERS_FILE="/etc/sudoers.d/$SERVICE_NAME"
cat <<SUDOERS | sudo tee "$SUDOERS_FILE" > /dev/null
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/systemctl, /usr/sbin/nft, /usr/sbin/iptables, /usr/sbin/ip6tables, /usr/sbin/ufw, /usr/bin/firewall-cmd, /usr/bin/fail2ban-client, /usr/sbin/netfilter-persistent, /usr/bin/bash $INSTALL_DIR/setup.sh *
Defaults:$SERVICE_USER !requiretty
Defaults:$SERVICE_USER env_keep += "DEBIAN_FRONTEND"
SUDOERS
sudo chmod 440 "$SUDOERS_FILE"
if ! sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  echo "   ❌ Sudoers syntax error — removing broken file"
  sudo rm -f "$SUDOERS_FILE"
  exit 1
fi
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
echo "   [1] Subscription token (recommended — uses your Claude Pro/Team/Enterprise plan)"
echo "       Requires Claude Code CLI: npm install -g @anthropic-ai/claude-code"
echo "       Then run in another terminal: claude setup-token"
echo "       It will display a token starting with sk-ant-oat... (valid 1 year)"
echo ""
echo "   [2] API key (pay-per-use billing)"
echo "       Create one at: https://console.anthropic.com/settings/keys"
echo "       Starts with sk-ant-api..."
echo ""
read -rp "   Choose [1/2]: " AUTH_CHOICE

AUTH_KEY=""
AUTH_VAR=""
if [ "$AUTH_CHOICE" = "2" ]; then
  echo ""
  echo "   → https://console.anthropic.com/settings/keys"
  echo "   → Click 'Create Key', copy the sk-ant-api... value"
  echo ""
  read -rp "   API key: " AUTH_KEY
  AUTH_VAR="ANTHROPIC_API_KEY"
else
  echo ""
  echo "   In another terminal, run:"
  echo ""
  echo "     npm install -g @anthropic-ai/claude-code"
  echo "     claude setup-token"
  echo ""
  echo "   Copy the sk-ant-oat... token it displays and paste below."
  echo ""
  read -rp "   Subscription token: " AUTH_KEY
  AUTH_VAR="CLAUDE_CODE_OAUTH_TOKEN"
fi

if [ -z "$AUTH_KEY" ]; then
  echo "   ⚠️  No auth provided. Add it to $INSTALL_DIR/.env before starting."
else
  if [ ${#AUTH_KEY} -gt 14 ]; then
    MASKED="${AUTH_KEY:0:10}$(printf '*%.0s' $(seq 1 $((${#AUTH_KEY} - 14))))${AUTH_KEY: -4}"
  else
    MASKED="${AUTH_KEY:0:4}****"
  fi
  echo "   ✅ $MASKED"
fi

ENV_FILE="$INSTALL_DIR/.env"
{
  echo "TELEGRAM_BOT_TOKEN=${BOT_TOKEN}"
  echo "TELEGRAM_CHAT_ID=${CHAT_ID}"
  if [ -n "$AUTH_KEY" ]; then
    echo "${AUTH_VAR}=${AUTH_KEY}"
  fi
} | sudo tee "$ENV_FILE" > /dev/null

sudo chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"
echo ""
echo "   ✅ Configuration saved"

echo ""
echo "8️⃣  Starting service..."

NODE_PATH_DIR=$(dirname "$(command -v node)")
sed -e "s|/opt/cakeagent|${INSTALL_DIR}|g" \
    -e "s|User=cakeagent|User=${SERVICE_USER}|g" \
    -e "s|Group=cakeagent|Group=${SERVICE_USER}|g" \
    -e "/\[Service\]/a Environment=PATH=${NODE_PATH_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
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
