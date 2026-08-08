#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=/opt/MyDrive
ENV_FILE=/etc/mydrive.env
SERVICE_FILE=/etc/systemd/system/MyDrive.service
NGINX_FILE=/etc/nginx/sites-available/MyDrive
NGINX_LINK=/etc/nginx/sites-enabled/MyDrive

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 用户运行此脚本。" >&2
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/package.json" ]]; then
  echo "未找到 ${PROJECT_DIR}/package.json，请先把仓库克隆到 ${PROJECT_DIR}。" >&2
  exit 1
fi

if [[ "$(command -v node)" != "/usr/bin/node" ]]; then
  echo "需要在 /usr/bin/node 安装 Node.js 20 或更高版本。" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 版本过低，需要 20 或更高版本。" >&2
  exit 1
fi

cd "${PROJECT_DIR}"
npm ci --omit=dev
install -d -m 700 "${PROJECT_DIR}/data/uploads" "${PROJECT_DIR}/data/tmp"

if [[ ! -f "${ENV_FILE}" ]]; then
  read -r -s -p "请输入 MyDrive 登录密码: " MYDRIVE_LOGIN_PASSWORD
  echo
  if [[ -z "${MYDRIVE_LOGIN_PASSWORD}" ]]; then
    echo "登录密码不能为空。" >&2
    exit 1
  fi
  SESSION_SECRET_VALUE="$(openssl rand -hex 48)"
  umask 077
  {
    printf 'APP_USERNAME=noart\n'
    printf 'APP_PASSWORD=%s\n' "${MYDRIVE_LOGIN_PASSWORD}"
    printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET_VALUE}"
    printf 'STORAGE_ROOT=/opt/MyDrive/data/uploads\n'
    printf 'TEMP_ROOT=/opt/MyDrive/data/tmp\n'
    printf 'MAX_UPLOAD_BYTES=5368709120\n'
    printf 'MAX_UPLOAD_FILES=20\n'
    printf 'COOKIE_SECURE=false\n'
  } > "${ENV_FILE}"
  unset MYDRIVE_LOGIN_PASSWORD SESSION_SECRET_VALUE
  chmod 600 "${ENV_FILE}"
else
  echo "保留已有的 ${ENV_FILE} 登录配置。"
fi

install -m 644 "${PROJECT_DIR}/deploy/systemd/MyDrive.service" "${SERVICE_FILE}"
install -m 644 "${PROJECT_DIR}/deploy/nginx/MyDrive.conf" "${NGINX_FILE}"
ln -sfn "${NGINX_FILE}" "${NGINX_LINK}"

nginx -t
systemctl daemon-reload
systemctl enable --now MyDrive.service
systemctl reload nginx

sleep 1
curl --fail --silent --show-error http://127.0.0.1:3025/api/health
echo
echo "MyDrive 已启动：公网端口 16025，内部端口 3025。"
