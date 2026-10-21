# PostgreSQL SSH 代理

让本机数据库客户端通过稳定的本地端点，经指定 SSH 主机访问数据库目标。

## Language

**数据库目标（Target）**：
从 SSH 主机所在网络访问的数据库主机名或 IP 地址与 TCP 端口。
_Avoid_: 原地址、数据库 URL

**SSH 主机（SSH Host）**：
代替本机连接数据库目标的远端主机；一台 SSH 主机可服务多个数据库目标。
_Avoid_: 数据库服务器（两者不必是同一台主机）

**目标绑定（Target Binding）**：
一个本地端点、SSH 主机与数据库目标之间的具名关系。
_Avoid_: 自动选路、透明接管

**本地端点（Local Endpoint）**：
数据库客户端在本机连接的环回地址与固定 TCP 端口。
_Avoid_: 数据库目标、公开监听地址

**连接请求（Connection Request）**：
数据库客户端向本地端点发起的一次 TCP 连接尝试。
_Avoid_: SQL 请求、PostgreSQL 报文

**连接结果（Connection Result）**：
代理对连接请求建立 SSH 通道与访问数据库目标的成功或失败结果。
_Avoid_: SQL 响应、数据库结果集
