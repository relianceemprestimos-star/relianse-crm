#!/usr/bin/env bash
set -euo pipefail

SSH_PORT="${SSH_PORT:-22022}"
APP_DIR="${APP_DIR:-/root/relianse-crm-main}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root no console da VPS."
  exit 1
fi

echo "[1/6] Conferindo servico SSH..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
fi

SSHD_CONFIG="/etc/ssh/sshd_config"
if [ -f "$SSHD_CONFIG" ]; then
  echo "[2/6] Garantindo SSH na porta ${SSH_PORT}..."
  cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
  if grep -Eq '^[#[:space:]]*Port[[:space:]]+' "$SSHD_CONFIG"; then
    sed -i "s/^[#[:space:]]*Port[[:space:]].*/Port ${SSH_PORT}/" "$SSHD_CONFIG"
  else
    printf '\nPort %s\n' "$SSH_PORT" >> "$SSHD_CONFIG"
  fi
  if grep -Eq '^[#[:space:]]*PermitRootLogin[[:space:]]+' "$SSHD_CONFIG"; then
    sed -i 's/^[#[:space:]]*PermitRootLogin[[:space:]].*/PermitRootLogin yes/' "$SSHD_CONFIG"
  else
    printf '\nPermitRootLogin yes\n' >> "$SSHD_CONFIG"
  fi
fi

echo "[3/6] Liberando firewall local, se existir..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${SSH_PORT}/tcp" || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${SSH_PORT}/tcp" || true
  firewall-cmd --permanent --add-service=http || true
  firewall-cmd --permanent --add-service=https || true
  firewall-cmd --reload || true
fi

echo "[4/6] Reiniciando SSH..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
fi

echo "[5/6] Atualizando stack do CRM, se o projeto existir..."
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  export CRM_DOMAIN="${CRM_DOMAIN:-reliancecrm.com.br}"
  export CRM_WWW_DOMAIN="${CRM_WWW_DOMAIN:-www.reliancecrm.com.br}"
  export CRM_EXTRA_DOMAINS="${CRM_EXTRA_DOMAINS:-relianceconsigzap.com.br,www.relianceconsigzap.com.br,mestreviral.com.br,www.mestreviral.com.br}"
  docker compose up -d --build
  docker compose ps
else
  echo "Projeto nao encontrado em ${APP_DIR}; pulei atualizacao dos containers."
fi

echo "[6/6] Estado final:"
ss -ltnp | grep -E "(:${SSH_PORT}|:80|:443)" || true
curl -fsS http://127.0.0.1/api/health || true
echo
echo "Teste externo esperado: ssh -p ${SSH_PORT} root@129.121.47.155"
