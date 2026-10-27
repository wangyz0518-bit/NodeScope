# NodeScope · 节点观测台

[下载 Windows 便携版（x64）](https://github.com/wangyz0518-bit/NodeScope/releases/latest/download/NodeScope-Windows-portable.zip) · [发布说明与校验文件](https://github.com/wangyz0518-bit/NodeScope/releases/latest)

一个在本机运行的代理节点诊断工具。用紧凑的中文深色界面，按次数或时长持续检测当前节点访问 ChatGPT、Cloudflare、YouTube、Google 及自定义网址的情况，观察响应延迟、成功率和错误原因。

## 下载使用

1. 打开本仓库右侧的 **Releases**，选择最新发布版本。
2. 下载附件 **NodeScope-Windows-portable.zip**。GitHub 自动提供的 `Source code` 是源码，不包含便携运行时。
3. 将压缩包 **完整解压**到有写入权限的文件夹。
4. 双击解压后 `NodeScope` 文件夹中的 **NodeScope.exe**。

便携版适用于 **Windows 10/11 x64**，已经包含 Node.js 运行时，无须安装 Node.js 或执行 npm 安装。请保留 `NodeScope.exe` 同目录中的 `runtime`、`lib`、`public` 等文件；单独复制 exe 无法运行。程序使用 Windows 自带的 curl，界面优先在 Edge/Chrome 独立窗口中打开，也可使用默认浏览器。

界面和检测服务运行在本机。关闭界面后，后台服务会在短暂等待后自动结束。

## 检测当前所选节点

1. 在代理客户端（如 Clash、Mihomo、v2rayN）中选好节点，并保持客户端运行。
2. 打开 NodeScope，检查当前使用的代理地址。默认读取 Windows 已启用的静态系统代理。
3. 选中需要检测的服务，选择按次数或按时长检测，再点击“开始检测”。默认每个服务采样 3 次。
4. 点击服务详情，查看每次请求、HTTP 状态码、连接阶段和具体错误。
5. 可在设置中填写节点名称，导出 JSON 报告或查看本机历史；换节点后再次点击检测。

支持的检测：

| 服务 | 检测范围 |
| --- | --- |
| ChatGPT | 首页与登录认证站点的网络连接，认证结果在详情中独立展示 |
| Cloudflare | 网络连接、出口 IP、国家/地区、边缘节点 |
| YouTube | 网页连接与响应情况 |
| Google | 网页连接与响应情况 |

ChatGPT 检测不会登录账号，不收集账号、密码或 Cookie。“首页可达”不能说明认证链路一定可用；认证站点可达也不代表账号登录、对话功能或 API 权限可用。

## 代理设置

- **系统代理**：读取 Windows 当前已启用的静态 HTTP/HTTPS 代理。没有可用的静态系统代理时，请手动填写或选择直连。PAC 自动代理脚本不会在本工具中执行。
- **手动代理**：填写客户端的 HTTP/HTTPS 或 SOCKS5 监听地址，例如 `http://127.0.0.1:7890`、`socks5h://127.0.0.1:1080`。端口以代理客户端设置为准；SOCKS5 目标域名使用代理端解析。第一版不支持带用户名、密码的代理地址。
- **直连 / TUN**：不设置应用层代理。开启 TUN、VPN 或其他系统路由时，流量仍会经过相应网络，因此此模式不等于物理网络完全绕过代理。

第一版检测代理客户端当前选中的节点，不管理订阅、枚举节点或自动切换节点。如果你的规则按网站分流，不同测试目标可能经过不同出口。

## 连续检测与自定义网址

在检测设置中选择：

| 设置 | 范围与含义 |
| --- | --- |
| 按次数 | 每个选中服务分别检测 1～1000 次 |
| 按时长 | 整轮检测持续 5～3600 秒，到时停止；也可手动停止 |
| 请求间隔 | 同一服务的一次请求结束后等待 0.5～30 秒，默认 1 秒 |
| 单次超时 | 每次请求最多等待 3～30 秒 |

持续检测会实时累计各服务及本轮整体的成功、受限、失败次数和请求成功率。成功率按主检测请求计算，ChatGPT 的独立认证诊断和 Cloudflare 出口查询不计入分母。按时长到期后，被中止的未完成请求不会被标成网络失败。

详情为每个服务保留最近 100 个样本，累计统计仍覆盖整轮已经完成的所有请求。ChatGPT 认证站点在首个首页样本之后独立检测一次，不随每次首页采样重复。Cloudflare 出口查询在未选中其服务卡片时也会执行，用来展示当前连接的出口。

可以添加最多 20 个自定义网址：名称为 1～40 个字符，地址支持 HTTP/HTTPS、路径和查询参数，最长 2048 个字符。只填域名时默认补为 HTTPS；地址不能包含用户名、密码或 `#` 片段。自定义服务可删除，内置服务通过取消勾选排除。检测进行时不能增删目标。

按时长检测会禁用下载测速，避免额外下载干扰延迟统计。按次数检测可以选择在主采样结束后下载约 10 MiB 数据测速。

## 结果怎么看

- **延迟**：实际 HTTPS 请求的首字节时间（TTFB），包含连接、TLS 和服务端响应等开销，不是 ICMP ping。页面也展示完整请求耗时。
- **抖动**：相邻有效样本的响应延迟变化。样本少时仅适合初步比较。
- **请求成功率 / 失败率**：本轮应用层请求结果的统计，不是 ICMP 丢包率。HTTP 403、429 等收到响应但受限的情况会独立标示。
- **连接阶段**：代理模式下，TCP 时间通常是本机到代理的连接时间；TLS 时间还可能包含代理握手、隧道建立。代理端目标 DNS 的耗时不能从本地计时单独还原。
- **服务受限**：HTTP 403、429、验证码或地区限制说明收到了远端响应，但当前访问受限，不能简单归为断网。
- **YouTube**：网页连接检测不能代表实际视频播放、码率、会员或版权地区权限。
- **出口信息**：来自当前 Cloudflare 请求的 trace 响应；按网站分流时，其他服务可能使用另一个出口。
- **下载测速**：默认关闭。主动开启后才下载约 10 MiB 数据，作为小样本吞吐量参考；结果受目标服务器、链路和测试时长影响。

## 数据与故障排查

检测历史保存在软件文件夹内的 `data/history.json`，自定义目标保存在 `data/targets.json`，启动器日志位于 `data/launcher.log`。导出的报告可能包含出口 IP、节点名称、代理地址和自定义 URL；网址中的查询参数也会随配置和报告保存，分享前请检查。公开的便携包不包含开发机检测历史、自定义目标、日志或账号信息。

检测会向你选择的目标服务发出请求，Cloudflare 出口查询和可选下载测速也使用当前设置的连接方式。程序仅监听本机回环地址。

检测失败时，先确认代理客户端正在运行、监听端口正确、节点已选好。连接被拒绝通常表示本机对应端口没有服务；超时、DNS、TLS 和 HTTP 限制会在详情中分别显示。更换节点不会自动重新检测，需再次点击开始。

双击无法启动时，可尝试 `start.cmd` 查看错误，或检查 `data/launcher.log`。

## 从源码运行

需要 Node.js 22 或更新版本及 Windows 自带 curl。项目只使用 Node.js 标准库，无第三方 npm 依赖。

```powershell
node server.cjs --desktop
```

也可双击 `start.cmd`。不自动打开界面的服务模式：

```powershell
node server.cjs
```

测试使用本地模拟服务，不会向真实目标网站发起请求：

```powershell
node --test tests/*.test.cjs
```

测试覆盖代理与参数校验、HTTP 限制识别、连续检测与累计统计、取消与历史记录、自定义目标、ChatGPT 认证诊断、本地 API 的令牌与来源检查等行为。

## 构建 Windows 便携版

源码仓库不包含 Node 运行时和编译后的 exe。先从 [Node.js 官方 v24.19.0 下载页](https://nodejs.org/en/download/archive/v24.19.0) 下载并解压 Windows x64 ZIP，保留其中的 `node.exe` 和 `LICENSE`。在 Windows PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 `
  -RuntimePath 'C:\tools\node-v24.19.0-win-x64\node.exe' `
  -RuntimeLicensePath 'C:\tools\node-v24.19.0-win-x64\LICENSE' `
  -Package -Zip
```

将示例路径改为实际解压位置。脚本使用 Windows .NET Framework C# 编译器生成窗口启动器，产物为：

- `dist/NodeScope`：可运行的便携文件夹。
- `dist/NodeScope-Windows-portable.zip`：公开下载用的完整程序包。
- `dist/NodeScope-Windows-portable.zip.sha256`：压缩包的 SHA256 校验值。

如果已经在源码目录的 `runtime` 中准备了 `node.exe` 和对应 `LICENSE.txt`，也可以直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Package -Zip
```

打包前会检查 `dist/NodeScope/data`。其中有历史记录、日志或其他文件时会拒绝打包，不会删除这些数据；请先将已有便携目录移到其他位置，再重新构建。

[Windows 构建工作流](.github/workflows/windows-release.yml) 支持在 Actions 手动触发测试与打包。推送与 `package.json` 版本一致的 `v*` 标签时，测试和构建通过后会创建 GitHub Release 并上传便携包、校验值；只有发布任务具有仓库内容写入权限。

计时与代理参数参考 [curl 官方手册](https://curl.se/docs/manpage.html)。出口诊断参考 [Cloudflare /cdn-cgi/ 文档](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/)。


