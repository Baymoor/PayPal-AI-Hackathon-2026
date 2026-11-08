#!/usr/bin/env bash
# Deploy or update Outings on the server, then wait until the public URL is healthy. Run as root:
#
#   bash /opt/outings/deploy/vps/deploy.sh [git-ref]
#
# git-ref: a branch on GitHub (default: main), a tag or a commit. Deploying an older commit is the rollback.
# Migrations run when the web container starts; the worker starts only after web is healthy.
set -euo pipefail

readonly APP_DIR=/opt/outings
readonly ENV_FILE=/etc/outings/app.env
readonly COMPOSE_FILE=deploy/vps/compose.yaml
readonly HEALTH_ATTEMPTS=36 # x 5 s = 3 minutes

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

checkout_ref() {
  local ref="$1" target
  git fetch --quiet --tags origin
  if git rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    target="origin/$ref"
  else
    target="$ref"
  fi
  # Detached checkout: the server never has local commits; this refuses to overwrite local edits.
  git checkout --quiet --detach "$target"
  echo "Deploying $(git log -1 --format='%h %s')"
}

site_address() { grep -E '^SITE_ADDRESS=' "$ENV_FILE" | cut -d= -f2-; }

wait_until_healthy() {
  local site url
  site="$(site_address)"
  url="https://$site/api/health"
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 10 "$url"; then
      printf '\nHealthy: %s\n' "${url%/api/health}"
      return 0
    fi
    sleep 5
  done
  echo "Not healthy after 3 minutes. Look at: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs --tail=100 web caddy" >&2
  return 1
}

main() {
  cd "$APP_DIR"
  checkout_ref "${1:-main}"
  compose up -d --build --remove-orphans
  docker image prune -f >/dev/null
  wait_until_healthy
}

main "$@"
