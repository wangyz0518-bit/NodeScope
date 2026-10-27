# NodeScope · Windows 便携版

下载附件 `NodeScope-Windows-portable.zip`，完整解压后双击 `NodeScope/NodeScope.exe`。适用于 Windows 10/11 x64，内置 Node.js 运行时，无须 npm 安装。

本版包含：

- 紧凑的中文深色诊断界面。
- ChatGPT、Cloudflare、YouTube、Google 以及自定义网址的当前代理连接检测。
- 按次数（每项 1～1000 次）或按时长（5～3600 秒）持续检测，设置请求间隔与超时。
- 累计成功率、成功/受限/失败次数、HTTPS 响应延迟、抖动和错误原因。
- ChatGPT 首页与认证站点网络诊断，独立展示认证结果，不验证账号登录。
- 系统代理、手动 HTTP/HTTPS/SOCKS5、直连/TUN 模式。
- Cloudflare 出口信息、按次数检测后的可选下载测速、本机历史记录和 JSON 报告。

首次使用：在代理客户端选好节点并保持客户端运行，打开 NodeScope，选择检测服务与次数或时长，再开始检测。

便携包不包含开发机历史记录、自定义目标或日志。运行后，历史保存在软件文件夹中的 `data/history.json`，自定义目标位于 `data/targets.json`。网页网络检测不代表账号权限、完整对话功能或实际视频播放能力。

可使用附件 `.sha256` 文件核对压缩包完整性。
