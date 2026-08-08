# MyDrive Ubuntu 部署说明

目标结构：

- 项目目录：`/opt/MyDrive`
- 用户文件：`/opt/MyDrive/data/uploads`
- Node.js：仅监听 `127.0.0.1:3025`
- Nginx：监听公网 `16025`
- systemd：`/etc/systemd/system/MyDrive.service`
- Nginx：`/etc/nginx/sites-available/MyDrive`
- 私密环境变量：`/etc/mydrive.env`（权限 `600`）

以下命令均使用 `root` 用户，不需要 `sudo`。

## 1. 安装系统依赖

确认 Node.js 版本不低于 20：

```bash
node --version
npm --version
nginx -v
git --version
```

如果尚未安装 Node.js 20 和 Nginx：

```bash
apt update
apt install -y ca-certificates curl gnupg nginx git openssl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

## 2. 创建项目目录并获取代码

```bash
git clone https://github.com/LIKE9426334946/MyDrive.git /opt/MyDrive
cd /opt/MyDrive
git switch main
```

如果目录已经存在，更新代码：

```bash
cd /opt/MyDrive
git fetch origin main
git pull --ff-only origin main
```

## 3. 自动安装配置并启动

```bash
cd /opt/MyDrive
chmod +x deploy/install.sh
./deploy/install.sh
```

脚本会执行以下操作：

1. 安装生产依赖。
2. 创建文件与临时上传目录。
3. 首次运行时询问登录密码，并自动生成会话密钥。
4. 创建 `/etc/mydrive.env`，权限为 `600`。
5. 安装并启用 systemd 服务。
6. 安装并启用 Nginx 配置。
7. 执行 `nginx -t` 与内部健康检查。

在密码提示中输入项目约定的登录密码。用户名固定为 `noart`。

## 4. 手动部署步骤

如果不使用脚本，可按下面的完整步骤操作。

安装依赖并创建存储目录：

```bash
cd /opt/MyDrive
npm ci --omit=dev
install -d -m 700 /opt/MyDrive/data/uploads /opt/MyDrive/data/tmp
```

创建私密配置，按提示输入登录密码：

```bash
read -r -s -p "MyDrive 登录密码: " MYDRIVE_LOGIN_PASSWORD
echo
SESSION_SECRET_VALUE="$(openssl rand -hex 48)"
umask 077
printf 'APP_USERNAME=noart\nAPP_PASSWORD=%s\nSESSION_SECRET=%s\nSTORAGE_ROOT=/opt/MyDrive/data/uploads\nTEMP_ROOT=/opt/MyDrive/data/tmp\nMAX_UPLOAD_BYTES=5368709120\nMAX_UPLOAD_FILES=20\nCOOKIE_SECURE=false\n' \
  "$MYDRIVE_LOGIN_PASSWORD" "$SESSION_SECRET_VALUE" > /etc/mydrive.env
unset MYDRIVE_LOGIN_PASSWORD SESSION_SECRET_VALUE
chmod 600 /etc/mydrive.env
```

创建并启用 systemd 服务：

```bash
install -m 644 /opt/MyDrive/deploy/systemd/MyDrive.service /etc/systemd/system/MyDrive.service
systemctl daemon-reload
systemctl enable --now MyDrive.service
systemctl status MyDrive.service --no-pager
```

创建并启用 Nginx 配置：

```bash
install -m 644 /opt/MyDrive/deploy/nginx/MyDrive.conf /etc/nginx/sites-available/MyDrive
ln -sfn /etc/nginx/sites-available/MyDrive /etc/nginx/sites-enabled/MyDrive
nginx -t
systemctl reload nginx
```

检查内部服务和公网代理：

```bash
curl http://127.0.0.1:3025/api/health
curl http://127.0.0.1:16025/api/health
```

如果服务器启用了 UFW，还需要放行公网端口：

```bash
ufw allow 16025/tcp
```

然后访问：

```text
http://服务器公网IP:16025
```

## 5. 常用维护命令

```bash
systemctl restart MyDrive.service
journalctl -u MyDrive.service -n 100 --no-pager
tail -n 100 /var/log/nginx/mydrive_error.log
```

更新版本：

```bash
cd /opt/MyDrive
git pull --ff-only origin main
npm ci --omit=dev
systemctl restart MyDrive.service
nginx -t && systemctl reload nginx
```

## 6. 备份

用户文件均位于：

```text
/opt/MyDrive/data/uploads
```

定期备份这个目录即可。不要把该目录提交到 Git。
