# MyDrive

MyDrive 是一个面向单用户、单台 Ubuntu 服务器的私人网盘。项目使用 Node.js 提供认证与文件接口，文件直接保存在服务器目录中，并由 Nginx 从公网端口 `16025` 反向代理到本机 `127.0.0.1:3025`。

## 功能

- 唯一账号登录，不提供注册或账号创建入口
- 30 天登录会话，使用 HttpOnly 签名 Cookie
- 多文件上传、上传进度与拖放上传
- 文件下载、新建文件夹、移动与重命名文件或文件夹、递归删除目录
- 文件夹层级、面包屑导航、全盘递归搜索
- 同名上传自动添加编号，不覆盖已有文件
- 路径穿越防护、登录失败限速与基础安全响应头
- 适配电脑、平板与手机的响应式界面

## 技术结构

- 后端：Node.js 20+、Express、Multer
- 前端：原生 HTML、CSS、JavaScript，无外部 CDN
- 存储：`/opt/MyDrive/data/uploads`
- 进程管理：systemd
- 公网入口：Nginx `16025`
- Node.js 内部监听：`127.0.0.1:3025`

## 本地运行

```bash
npm install
APP_PASSWORD='本地测试密码' \
SESSION_SECRET='replace-with-at-least-32-random-characters' \
npm start
```

打开 `http://127.0.0.1:3025`。用户名默认为 `noart`。

## 验证

```bash
npm run check
```

生产部署请阅读 [DEPLOY.md](DEPLOY.md)。登录密码和会话密钥只保存在服务器的 `/etc/mydrive.env`，不会提交到 Git 仓库。
