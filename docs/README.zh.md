[English](../README.md) | 简体中文

# x-mcp

一个面向 X（Twitter）的只读 MCP 服务器。它把用户资料、推文、搜索、趋势和评论区封装为 MCP
工具，走的是 X 网页端自身调用的接口——不需要开发者账号，不需要 API Key，也不抓 HTML。

## 工具

| 工具 | 说明 |
|---|---|
| `x_auth_status` | 检查当前配置的会话是否仍然有效 |
| `x_user_lookup` | 按用户名取资料：简介、关注者数、推文数、认证状态、注册时间、头像与横幅 |
| `x_user_tweets` | 用户最近的推文，按时间倒序；转推会嵌套原始推文 |
| `x_home_timeline` | 当前账号的「为你推荐」时间线 |
| `x_search` | 搜索推文，支持 `from:`、`lang:`、`min_faves:`、`#tag` 等 X 搜索语法 |
| `x_tweet_detail` | 单条推文及其评论区，支持翻页 |
| `x_trends` | 按地区查询趋势话题 |

所有工具都只读。发帖、点赞、收藏和私信不在范围内。

## 环境要求

- Node.js 20 或更高版本
- 一个 X 账号及其浏览器会话

## 安装

### 从 npm 运行

```bash
npx -y @nite07/x-mcp
```

### 从私有 registry 运行

同一个包也镜像在自建的 Gitea registry 上。两个参数都需要：包本体来自 Gitea，依赖来自 npmjs。

```bash
npx -y --registry=https://registry.npmjs.org/ \
  --@nite07:registry=https://git.nite07.com/api/packages/nite/npm/ \
  @nite07/x-mcp
```

### 从源码运行

```bash
git clone https://git.nite07.com/nite/x-mcp.git
cd x-mcp
npm install
npm run build
node dist/stdio.js
```

## 配置

服务器使用你已有的 X 浏览器会话完成认证，需要两个 cookie：`auth_token` 和 `ct0`。

1. 在浏览器中登录 <https://x.com>。
2. 打开开发者工具 → Application → Cookies → `x.com`。
3. 复制 `auth_token` 和 `ct0` 的值。

按启动方式选择下面的一种提供。

**环境变量**，由客户端拉起进程时使用：

```
X_AUTH_TOKEN=<auth_token>
X_CSRF_TOKEN=<ct0>
X_LANG=zh-cn
```

`X_LANG` 可选，影响 X 返回内容的语言。

**`.env` 文件**，在项目目录中从源码运行时使用：

```
auth_token=<auth_token>
ct0=<ct0>
lang=zh-cn
```

这两个值等同于完整的登录态。请按密码对待：文件权限设为 `600`，不要提交到仓库。

## 客户端配置

多数 MCP 客户端接受 JSON 形式的服务器定义：

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "@nite07/x-mcp@latest"],
      "env": {
        "X_AUTH_TOKEN": "<auth_token>",
        "X_CSRF_TOKEN": "<ct0>"
      }
    }
  }
}
```

服务器通过 stdio 通信。若客户端使用其他传输方式，也可以独立运行 HTTP 端点：

```bash
npm start
# POST http://127.0.0.1:8787/mcp
```

## 使用

在依赖数据工具之前，先确认会话状态：

```
x_auth_status  {}
```

查询资料，再取其最近的推文：

```
x_user_lookup   {"username": "X"}
x_user_tweets   {"username": "X", "limit": 20}
```

带 X 搜索语法检索：

```
x_search  {"query": "from:X lang:en", "product": "Latest", "limit": 20}
```

逐页读取评论区：

```
x_tweet_detail  {"id": "2106019976381689871", "limit": 40}
                → { "tweet": {...}, "replies": [...], "nextCursor": "DAAKCgABHVQ…" }

x_tweet_detail  {"id": "2106019976381689871", "limit": 40, "cursor": "DAAKCgABHVQ…"}
                → { "tweet": null, "replies": [...], "nextCursor": "..." }
```

后续页只包含回复，`tweet` 为 `null`。只要返回里有 `nextCursor` 就可以继续翻。每页的数量由
X 决定，`limit` 限制的是本页返回多少条，而不是向服务端多要。

## 故障排查

| 现象 | 处理 |
|---|---|
| `[err.auth_expired]` 或 `[err.auth_csrf]` | 会话 cookie 已失效。在已登录的浏览器中重新复制 `auth_token` 和 `ct0`，更新后重启客户端。 |
| `[err.auth_restricted]` | 账号被锁定、封禁，或无权读取该目标。需要在 x.com 上处理，换 cookie 无效。 |
| `[err.rate_limited]` | 等到消息中给出的时间再试。 |
| `[err.query_stale]` 或 `[err.signer_broken]` | X 修改了前端，需要更新本服务器。参见下方的开发文档。 |
| `[err.not_found]` | 用户名或推文 ID 不存在，或当前账号不可见。 |
| `[err.upstream]` | 临时故障，可重试一次。 |

每条错误都会说明重试是否有用，驱动这些工具的客户端不必靠猜。

## 限制

- **只读。** 不支持发帖、点赞、收藏和私信。
- **非官方接口。** X 随时可能改动。服务器会自动刷新请求标识并重建请求签名器，但若 X 侧发生
  破坏性变更，仍可能需要更新版本。
- **速率限制跟随你的账号。** 高频自动化使用可能被 X 限流或标记。
- **个人用途。** 请使用自己的账号，并遵守 X 的服务条款。

## 开发文档

- [endpoints.md](endpoints.md)——各能力对应哪个接口，以及 X 各版本响应结构的差异
- [reverse-engineering.md](reverse-engineering.md)——请求签名头的逆向过程、维护手册与踩坑记录

## 许可

MIT

## 免责声明

本项目与 X Corp. 无关联，未获其认可或赞助。X 与 Twitter 是 X Corp. 的商标。软件按现状提供，
供个人使用，使用者需自行确保遵守 X 的服务条款。
