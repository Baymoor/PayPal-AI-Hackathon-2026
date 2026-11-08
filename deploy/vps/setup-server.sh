#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Outings. Run as root:
#
#   bash setup-server.sh [site-address]
#
# site-address: a domain whose DNS A record points at this server (e.g. outings.example.com).
# Leave it out to use <ip>.sslip.io, a free name that resolves to the server's IP (no domain needed).
#
# Safe to re-run: each step skips work that is already done. It never prints a secret.
set -euo pipefail

readonly REPO_URL="https://github.com/Baymoor/PayPal-AI-Hackathon-2026.git"
readonly APP_DIR=/opt/outings
readonly ENV_FILE=/etc/outings/app.env
readonly BACKUP_DIR=/var/backups/outings

log() { printf '\n==> %s\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this as root (ssh root@<server-ip>)." >&2
    exit 1
  fi
}

# DigitalOcean's metadata service; falls back to an external lookup on other providers.
public_ipv4() {
  curl -fsS --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null \
    || curl -fsS --max-time 5 https://api.ipify.org
}

default_site_address() {
  local ip
  ip="$(public_ipv4)"
  echo "${ip//./-}.sslip.io"
}

install_base_packages() {
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl git openssl ufw unattended-upgrades
}

# Docker Engine + Compose plugin from Docker's official apt repository.
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker already installed"
    return
  fi
  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

# Only SSH and the web are reachable. (Docker publishes only Caddy's 80/443; Postgres is never published.)
configure_firewall() {
  log "Configuring the firewall (SSH, HTTP, HTTPS)"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
}

# Key-only SSH. The file name sorts first because sshd uses the first value it reads.
harden_ssh() {
  log "SSH: keys only, no passwords"
  cat > /etc/ssh/sshd_config.d/01-outings.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  systemctl reload ssh
}

enable_security_updates() {
  log "Enabling automatic security updates"
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
}

# Headroom for `next build` on a 4 GB machine.
add_swap() {
  if swapon --show | grep -q .; then
    log "Swap already present"
    return
  fi
  log "Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

clone_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    log "Repository already at $APP_DIR"
    return
  fi
  log "Cloning the repository into $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
}

# Creates the secrets file once from the committed template. Generated values go straight
# into the file (hex only, so they need no quoting); nothing is echoed.
write_env_file() {
  local site="$1"
  if [ -f "$ENV_FILE" ]; then
    log "Keeping the existing $ENV_FILE"
    return
  fi
  log "Creating $ENV_FILE for https://$site"
  install -d -m 700 "$(dirname "$ENV_FILE")"
  (
    umask 077
    sed -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$site|" \
        -e "s|^APP_BASE_URL=.*|APP_BASE_URL=https://$site|" \
        -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
        -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
        -e "s|^MERCHANT_DASHBOARD_PASSWORD=.*|MERCHANT_DASHBOARD_PASSWORD=$(openssl rand -hex 12)|" \
        "$APP_DIR/deploy/vps/app.env.example" > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# Daily compressed database dump, kept for 14 days.
install_backup_job() {
  log "Installing the daily database backup ($BACKUP_DIR)"
  install -d -m 700 "$BACKUP_DIR"
  cat > /etc/cron.daily/outings-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
docker exec outings-db-1 pg_dump -U outings -d outings | gzip > "$BACKUP_DIR/outings-\$(date +%F).sql.gz"
find "$BACKUP_DIR" -name 'outings-*.sql.gz' -mtime +14 -delete
EOF
  chmod 755 /etc/cron.daily/outings-backup
}

main() {
  require_root
  local site="${1:-}"
  install_base_packages
  [ -n "$site" ] || site="$(default_site_address)"
  install_docker
  configure_firewall
  harden_ssh
  enable_security_updates
  add_swap
  clone_repo
  write_env_file "$site"
  install_backup_job
  log "Done. Next: add your keys with   nano $ENV_FILE"
  echo "Then deploy with:               bash $APP_DIR/deploy/vps/deploy.sh"
}

main "$@"
