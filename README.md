# pg-ssh-proxy

把本机固定端口通过 SSH 转发到远端网络中的 PostgreSQL。它不修改系统路由、不接管网络，也不解析数据库协议。

## 要求

- Node.js 22 或更高版本
- 可访问 SSH 主机的 agent、私钥或密码

## 使用

```bash
pnpm install
pnpm build
node dist/cli/main.js
```

首次运行会进入向导，只询问完成连接所需的信息：

1. 代理名称与数据库目标；
2. 复用或新增 SSH 主机；
3. 固定的本地端口；
4. 保存前显示完整连接路径并确认。

配置保存到 `~/.pg-ssh-proxy/config.json`。密码和私钥口令只在启动时输入，不会写入配置或日志。启动后，把数据库客户端的地址改为向导回显的 `127.0.0.1:<localPort>`；数据库用户名、密码和 TLS 设置保持不变。

## 命令

```text
pg-ssh-proxy                 首次配置，或启动所有已配置代理
pg-ssh-proxy add             添加代理并测试连接
pg-ssh-proxy edit [name]     编辑代理
pg-ssh-proxy remove [name]   删除代理
pg-ssh-proxy list            显示本地端点、数据库目标和 SSH 路径
pg-ssh-proxy check [name]    测试 SSH 与数据库目标可达性
pg-ssh-proxy config path     显示配置文件路径
pg-ssh-proxy config validate 一次列出全部配置错误
pg-ssh-proxy --no-ui         使用逐行输出
pg-ssh-proxy --verbose       显示连接阶段、重试次数和耗时
pg-ssh-proxy --version       显示当前版本
```

交互式终端默认显示 fullscreen：左侧是代理状态，中间是 `REQ`、`RES`、`CLOSE` 连接事件，右侧是选中事件的详情。这里的请求和响应只代表 TCP 连接建立过程，不是 SQL 请求或数据库返回内容。

快捷键：`↑/↓` 选择、`/` 过滤、`Space` 暂停滚动、`r` 立即重试、`?` 帮助、`q` 正常退出。第一次 `Ctrl+C` 最多等待现有连接 10 秒；再次退出会强制关闭。

## 安全边界

- 只监听 `127.0.0.1`。
- 首次遇到 SSH 主机时必须人工确认 SHA-256 指纹。
- 主机身份变化时普通启动拒绝连接；使用 `check` 并输入完整主机名才能替换记录。
- 日志只包含连接生命周期、耗时和字节汇总，不包含 SQL、数据库认证报文或原始数据。
- 活跃日志为 `~/.pg-ssh-proxy/logs/pg-ssh-proxy.log`，单文件 5 MiB，最多保留 5 个文件。

## 故障定位

日志是 JSONL，每次启动使用独立 `runId`。定位问题时先保留完整日志目录，再按 `runId`、`event`、`phase`、`errorCode` 和 `connectionId` 过滤；不要只截取最后一行。日志包含版本、平台、Node.js 版本、SSH 状态、重试过程和连接汇总，不包含 SQL、认证报文或数据库返回内容。

```bash
tail -f ~/.pg-ssh-proxy/logs/pg-ssh-proxy.log
```
