#!/bin/bash
# Deploys one image of the POST_FG backend on this instance. Sent and run (as root) by
# .github/workflows/deploy.yml through SSM Run Command:
#
#   deploy.sh <environment> <image URI> <region>
#   deploy.sh dev 157320387454.dkr.ecr.ap-south-1.amazonaws.com/mcaffeine-erp-post-fg-api-ecr-dev:<git sha> ap-south-1
#
#   1. .env      SSM /mcaffeine-erp-post-fg/<environment>/api/env (the whole file) -> /opt/post-fg/.env
#   2. nginx     port 80 -> the container; only requests carrying CloudFront's secret header
#                (SSM /mcaffeine-erp-post-fg/<environment>/cloudfront/origin-verify) get through
#   3. logs      CloudWatch: the container's output -> /mcaffeine-erp-post-fg/<environment>/api
#                (Docker awslogs driver); the CloudWatch agent sends nginx -> /nginx,
#                /var/log/messages + cloud-init -> /system, and memory / swap / disk usage
#                as metrics (CWAgent). The log groups come from Terraform; without them the
#                container logs stay local and the deploy goes on.
#   4. pull      the image from ECR (the instance role)
#   5. migrate   TypeORM migrations, only when the .env has DB_ENABLED=true
#   6. replace   the post-fg-api container (127.0.0.1:3000, .env and storage mounted)
#   7. check     /api/v1/health directly and through nginx; on failure the previous image is
#                started again and the deploy fails
#   8. clean     unused images older than 3 days
set -euo pipefail

ENV_NAME="${1:?usage: deploy.sh <environment> <image URI> <region>}"
IMAGE="${2:?usage: deploy.sh <environment> <image URI> <region>}"
REGION="${3:?usage: deploy.sh <environment> <image URI> <region>}"

PROJECT="mcaffeine-erp-post-fg"
APP_DIR="/opt/post-fg"
CONTAINER="post-fg-api"
APP_PORT=3000
APP_UID=1000 # the image's node user
HEALTH_PATH="/api/v1/health"
ORIGIN_HEADER="X-Origin-Verify"
ENV_PARAM="/${PROJECT}/${ENV_NAME}/api/env"
ORIGIN_PARAM="/${PROJECT}/${ENV_NAME}/cloudfront/origin-verify"
NGINX_CONF="/etc/nginx/conf.d/post-fg.conf"
LOG_PREFIX="/${PROJECT}/${ENV_NAME}" # CloudWatch log groups: ${LOG_PREFIX}/{api,deploy,nginx,system}
CW_AGENT_CONF="/opt/aws/amazon-cloudwatch-agent/etc/post-fg.json"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }
ssm_value() { aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text; }

log "environment ${ENV_NAME}, image ${IMAGE}"
mkdir -p "${APP_DIR}/storage"
chown "${APP_UID}:${APP_UID}" "${APP_DIR}/storage"

# 1. .env -------------------------------------------------------------------
log "reading ${ENV_PARAM}"
if ! ssm_value "$ENV_PARAM" > "${APP_DIR}/.env.new"; then
  rm -f "${APP_DIR}/.env.new"
  log "ERROR: cannot read SSM parameter ${ENV_PARAM}. Create it (SecureString, the whole .env file) and deploy again."
  exit 1
fi
chown "${APP_UID}:${APP_UID}" "${APP_DIR}/.env.new"
chmod 600 "${APP_DIR}/.env.new"
mv -f "${APP_DIR}/.env.new" "${APP_DIR}/.env"

# 2. nginx -------------------------------------------------------------------
log "configuring nginx (CloudFront only, SSE-safe)"
ORIGIN_SECRET="$(ssm_value "$ORIGIN_PARAM")"
umask 077
cat > "${NGINX_CONF}.new" <<EOF
# Written by deploy.sh on every deploy; edits here are overwritten.
# CloudFront adds ${ORIGIN_HEADER} to /api/* requests; anything else is refused.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Largest upload: the app accepts files up to 200 MB (INTRANSIT_UPLOAD_MAX_BYTES), plus room
    # for the multipart encoding. Keep this above the app's own limits so the app gives the error.
    client_max_body_size 210m;

    location / {
        if (\$http_x_origin_verify != "${ORIGIN_SECRET}") {
            return 403;
        }

        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Live updates (SSE): no buffering, long-lived connections.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
umask 022
# Swap the new config in, but put the previous one back if nginx rejects it, so a bad
# config never stays behind for the next restart or reboot.
[ -f "$NGINX_CONF" ] && cp -f "$NGINX_CONF" "${NGINX_CONF}.previous"
mv -f "${NGINX_CONF}.new" "$NGINX_CONF"
if ! nginx -t; then
  log "ERROR: nginx rejected the new config; restoring the previous one"
  if [ -f "${NGINX_CONF}.previous" ]; then mv -f "${NGINX_CONF}.previous" "$NGINX_CONF"; else rm -f "$NGINX_CONF"; fi
  exit 1
fi
rm -f "${NGINX_CONF}.previous"
systemctl enable --now nginx
systemctl reload nginx

# 3. logs --------------------------------------------------------------------
# Container output: Docker's awslogs driver, one stream per image (post-fg-api/<git sha>).
# non-blocking: the app never waits on CloudWatch; `docker logs` keeps working.
LOG_OPTS=()
if [ "$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "${LOG_PREFIX}/api" \
      --query "length(logGroups[?logGroupName=='${LOG_PREFIX}/api'])" --output text 2>/dev/null)" = "1" ]; then
  LOG_OPTS=(--log-driver awslogs
    --log-opt "awslogs-region=${REGION}"
    --log-opt "awslogs-group=${LOG_PREFIX}/api"
    --log-opt mode=non-blocking
    --log-opt max-buffer-size=4m)
  log "container logs -> CloudWatch ${LOG_PREFIX}/api"
else
  log "WARNING: log group ${LOG_PREFIX}/api not found (Terraform not applied?): container logs stay on the instance"
fi

# nginx + system logs and memory / disk metrics: the CloudWatch agent (installed once,
# config rewritten on every deploy). /var/log/messages needs rsyslog on Amazon Linux 2023.
setup_cloudwatch_agent() {
  rpm -q rsyslog >/dev/null 2>&1 || dnf install -y -q rsyslog || return 1
  systemctl enable --now rsyslog || return 1
  rpm -q amazon-cloudwatch-agent >/dev/null 2>&1 || dnf install -y -q amazon-cloudwatch-agent || return 1
  cat > "$CW_AGENT_CONF" <<EOF || return 1
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/nginx/access.log", "log_group_name": "${LOG_PREFIX}/nginx", "log_stream_name": "{instance_id}/access" },
          { "file_path": "/var/log/nginx/error.log", "log_group_name": "${LOG_PREFIX}/nginx", "log_stream_name": "{instance_id}/error" },
          { "file_path": "/var/log/messages", "log_group_name": "${LOG_PREFIX}/system", "log_stream_name": "{instance_id}/messages" },
          { "file_path": "/var/log/cloud-init-output.log", "log_group_name": "${LOG_PREFIX}/system", "log_stream_name": "{instance_id}/cloud-init" }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": { "InstanceId": "\${aws:InstanceId}" },
    "metrics_collected": {
      "mem": { "measurement": ["mem_used_percent", "mem_available"] },
      "swap": { "measurement": ["swap_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"], "drop_device": true }
    }
  }
}
EOF
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c "file:${CW_AGENT_CONF}" >/dev/null || return 1
}
if setup_cloudwatch_agent; then
  log "CloudWatch agent: nginx -> ${LOG_PREFIX}/nginx, system -> ${LOG_PREFIX}/system, memory/disk metrics -> CWAgent"
else
  log "WARNING: CloudWatch agent setup failed: nginx/system logs and memory/disk metrics are not sent"
fi

# 4. pull --------------------------------------------------------------------
REGISTRY="${IMAGE%%/*}"
log "pulling from ${REGISTRY}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker pull --quiet "$IMAGE"

# 5. migrate -----------------------------------------------------------------
if grep -Eq "^[[:space:]]*DB_ENABLED[[:space:]]*=[[:space:]]*[\"']?true" "${APP_DIR}/.env"; then
  log "DB_ENABLED=true: running migrations"
  docker run --rm \
    -v "${APP_DIR}/.env:/app/.env:ro" \
    "$IMAGE" node_modules/.bin/typeorm migration:run -d dist/config/data-source.js
else
  log "DB_ENABLED is not true: migrations skipped"
fi

# 6. replace -----------------------------------------------------------------
run_container() {
  local stream=()
  # One CloudWatch stream per image: post-fg-api/<git sha>.
  [ ${#LOG_OPTS[@]} -gt 0 ] && stream=(--log-opt "awslogs-stream=${CONTAINER}/${1##*:}")
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --stop-timeout 30 \
    -p "127.0.0.1:${APP_PORT}:${APP_PORT}" \
    -e "PORT=${APP_PORT}" \
    -v "${APP_DIR}/.env:/app/.env:ro" \
    -v "${APP_DIR}/storage:/app/storage" \
    "${LOG_OPTS[@]}" "${stream[@]}" \
    "$1" >/dev/null
}

PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$PREVIOUS_IMAGE" ]; then
  log "stopping the running container (${PREVIOUS_IMAGE})"
  docker stop --time 30 "$CONTAINER" >/dev/null || true
  docker rm "$CONTAINER" >/dev/null || true
fi
log "starting ${CONTAINER}"
run_container "$IMAGE"

# 7. check -------------------------------------------------------------------
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! healthy; then
  log "ERROR: ${HEALTH_PATH} did not answer within 60 s. Last container logs:"
  docker logs --tail 100 "$CONTAINER" 2>&1 || true
  if [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$IMAGE" ]; then
    log "rolling back to ${PREVIOUS_IMAGE}"
    docker rm -f "$CONTAINER" >/dev/null || true
    run_container "$PREVIOUS_IMAGE"
  fi
  exit 1
fi

log "health (direct): $(curl -fsS -m 5 "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}")"
log "health (nginx, with CloudFront header): $(curl -fsS -m 5 -H "${ORIGIN_HEADER}: ${ORIGIN_SECRET}" "http://127.0.0.1${HEALTH_PATH}")"
WITHOUT_HEADER="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1${HEALTH_PATH}")"
if [ "$WITHOUT_HEADER" != "403" ]; then
  log "ERROR: nginx answered ${WITHOUT_HEADER} without the CloudFront header (expected 403)"
  exit 1
fi
log "nginx refuses requests without the CloudFront header (403)"

# 8. clean -------------------------------------------------------------------
docker image prune -af --filter "until=72h" >/dev/null || true
log "done: ${CONTAINER} runs ${IMAGE}"
