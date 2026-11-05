# Windows 批量上传 CSV

`upload-csv.ps1` 会递归查找指定本地目录中的全部 `.csv` 文件（扩展名不区分大小写），逐个流式上传到指定网盘目录。不会修改、移动或删除本地文件，不需要安装 Python 或第三方 PowerShell 模块。

以本地目录 `D:\runs`、服务器目录 `results` 为例：

| 本地文件 | 网盘中的位置 |
| --- | --- |
| `D:\runs\metrics.csv` | `results/metrics.csv` |
| `D:\runs\abc\ab.csv` | `results/abc_ab.csv` |
| `D:\runs\exp1\train\loss.csv` | `results/exp1_train_loss.csv` |
| `D:\runs\实验\结果.CSV` | `results/实验_结果.CSV` |
| `D:\runs\abc\model.pth` | 不上传（不是 CSV） |

文件名来自**相对于指定本地目录的路径**，用 `_` 替换目录分隔符，不包含 `runs` 本身。文件实际内容和编码保持不变。包括隐藏目录中的 CSV，但跳过符号链接、目录联接和其他重解析点，避免上传所选目录以外的内容。

## 1. 更新服务器并获取 Token

在 Ubuntu 服务器上用 root 执行：

```bash
cd /opt/MyDrive
git pull --ff-only origin main
bash deploy/install.sh
grep '^CSV_UPLOAD_TOKEN=' /etc/mydrive.env
```

部署脚本自动生成独立的 `CSV_UPLOAD_TOKEN` 并重启服务。已存在的 CSV Token、Kaggle Token 和登录密码保持不变；仍使用外部端口 `16025`、内部端口 `3025`。复制最后一行**等号后面的值**，不要复制 `CSV_UPLOAD_TOKEN=` 前缀。

CSV Token 只允许通过专用接口上传 CSV，可以指定网盘内的任意子目录，并**替换同名 CSV 的内容**，不能用来读取或删除文件。原来的 Kaggle Token 仍只能上传到 `/kaggle/`。请把两个 Token 都当作密码保管，不要提交到 GitHub 或分享脚本运行日志中的私密配置。

## 2. 在脚本内配置，然后直接运行

把仓库根目录的 `upload-csv.ps1` 保存到 Windows 电脑，例如 `D:\tools\upload-csv.ps1`。脚本按 Windows PowerShell 5.1 / PowerShell 7 的语法编写。

用文本编辑器打开脚本，修改文件顶部的配置区。地址换成你当前能访问的网盘地址，Token 填入上一步复制的值：

```powershell
$LocalDirectory = 'D:\runs'
$ServerDirectory = 'results'
$ServerUrl = 'http://192.168.0.150:16025'
$Token = '在这里填写CSV_UPLOAD_TOKEN的值'
$TimeoutSeconds = 3600
$Preview = $false
```

保存后在脚本所在目录打开 PowerShell，直接运行，不需要传入任何配置参数，也不会再提示输入 Token：

```powershell
.\upload-csv.ps1
```

若系统执行策略阻止运行，可使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\upload-csv.ps1`，这只影响本次 PowerShell 进程；本地目录、地址、Token 等仍全部在脚本内配置。

- `LocalDirectory`：本地目录，支持空格和中文；建议填写绝对路径，默认示例为 `D:\runs`。相对路径以 PowerShell 当前工作目录为基准。
- `ServerDirectory`：**网盘里的目录**，例如 `results` 或 `results/experiment1`；默认 `results`，不存在会自动创建。不是服务器操作系统路径，不要填写 `/opt/MyDrive/...`。
- `ServerUrl`：填写正确的网盘地址，例如 `http://192.168.0.150:16025`。`192.168.0.150` 是局域网地址，电脑必须能通过同一局域网或 VPN 访问它；也可以填写实际公网地址或 HTTPS 地址。
- `Token`：填写 `CSV_UPLOAD_TOKEN=` 后面的值，不要填写整个配置行，也不要使用 Kaggle Token。
- `TimeoutSeconds`：每个文件的上传超时，默认 3600 秒，最长 86400 秒。
- `Preview`：设置为 `$true` 只预览，设置为 `$false` 正式上传。

脚本不再从命令行参数或环境变量读取配置。填有真实 Token 的版本仅在自己的电脑保存，不要上传到 GitHub 或分享给他人。脚本使用 UTF-8 BOM 编码，修改中文路径后请保留该编码，以兼容 Windows PowerShell 5.1。

## 3. 先预览，不上传

将脚本顶部的 `$Preview` 改为 `$true`，只列出文件名转换结果，不需要 Token，也不会发送网络请求：

```powershell
$Preview = $true
```

确认列表后改回 `$false` 再运行脚本。正常上传会显示文件数量、当前文件进度、实际保存位置和最终成功/失败统计：

```text
Found 2 CSV file(s) in D:\runs
[1/2] abc\ab.csv -> results/abc_ab.csv
Upload success: abc\ab.csv -> results/abc_ab.csv
[2/2] metrics.csv -> results/metrics.csv
Upload success: metrics.csv -> results/metrics.csv
Finished. Success: 2; Failed: 0; Not attempted: 0
```

重复运行脚本会更新原路径，例如 `results/abc_ab.csv`。新文件完整上传后才替换旧文件，不会再产生 `_1`、`_2` 副本。此前生成的编号副本不会被自动删除。若两个本地路径转换成同一个文件名（例如 `abc/ab.csv` 和 `abc_ab.csv`），以后一次成功上传的内容为准。需要同时保留两份时请先改名或指定不同目标目录。超过 255 个 UTF-8 字节的文件名会报错。

脚本继续处理普通文件错误；Token 错误或接口未启用时停止后续上传。不会自动重试：超时或断网时服务器可能已经收到文件，应先在网盘中确认，再决定是否重新上传。退出码：`0` 全部成功或没有 CSV，`1` 有文件上传失败，`2` 参数、目录访问或初始化失败。

## 4. 接口约定

```http
POST /api/upload/csv?path=results&filename=abc_ab.csv
Authorization: Bearer <CSV_UPLOAD_TOKEN>
Content-Type: multipart/form-data; boundary=...
```

- 查询参数 `path`：网盘内的目标目录，必填，支持多级目录。
- 查询参数 `filename`：转换后的保存文件名，必填，必须是 CSV 文件名。
- 请求体：仅包含一个文件字段 `file`。脚本中 multipart 的传输名固定为 `upload.csv`，真实保存名以 UTF-8 URL 编码放在 `filename` 中，避免中文文件名被 multipart 的旧编码规则误解。
- 不接受网页 Cookie 或 Kaggle Token 代替 CSV Token。
- 使用磁盘临时文件流式接收，不把整个 CSV 放进内存。大小限制沿用 `MAX_UPLOAD_BYTES`，默认单文件 100GB，Nginx 上传配置不需额外修改。
- 根据 `.csv` 扩展名筛选，不重新解析或转码 CSV 内容，兼容不同分隔符、编码和空文件。

新增文件返回 HTTP `201`，替换已有文件返回 HTTP `200`。已有的脚本在更新服务端后即使用新的同名策略，无需修改 Token 或传参。

```json
{"status":"success","filename":"abc_ab.csv","path":"results/abc_ab.csv","size":123,"replaced":true}
```

错误返回 `{"status":"error","message":"原因"}`，常见状态：

| 状态码 | 含义 |
| --- | --- |
| `400` | 路径/文件名不合法、不是 CSV、文件字段错误 |
| `401` | CSV Token 错误或缺失 |
| `409` | 目标是目录、符号链接等非普通文件，不能替换 |
| `413` | 文件超过大小限制 |
| `503` | 服务器未配置 `CSV_UPLOAD_TOKEN` |

HTTP 不加密 Token 和文件。只在可信局域网/VPN 中使用 HTTP；公网使用建议为现有 Nginx 配置 HTTPS。脚本不关闭 TLS 证书验证，也不会自动跟随重定向，避免把上传请求发往意外地址。

## 验证

运行 `npm run check` 检查接口及原有功能。若本机可运行 `powershell.exe`（Windows）或 `pwsh`，还会执行真实的脚本端到端测试；否则该项明确显示为跳过。也可通过 `MYDRIVE_POWERSHELL` 环境变量指定可执行文件的完整路径。测试使用隔离临时目录和本地 HTTP 服务，不连接生产网盘。
