# dsh-codex-mask

让 dsh 发出的模型请求带上一枚可信的 **Codex 客户端指纹**——**零配置，装完即用**。

## 装完自动做什么

1. 读取 `llm-pi-ai` 里**你自己配置的 provider**（手填了 `baseURL` 的行），把这些地址作为伪装目标；
2. 发往这些地址的请求自动改写：
   - 请求头：`user-agent`（Codex 指纹格式）/ `originator` / `version` / `x-codex-installation-id`；
   - 请求体（JSON）：注入 `client_metadata`；`reasoning` 与 `tools` 按「同时出现或同时缺」自动配对。

其余流量（包括所有响应）原样直通。**不需要本地代理，不需要填写任何配置。**

指纹形状取自真实流量统计（参考 codex2api 的公开实现）：

```
UA = {originator}/{CLI版本} ({OS} {OS版本}; {架构}) {终端} ({应用名}; {应用版本})
```

desktop / vscode 形态的构建号与 CLI 版本是**成对**出现的，插件内置的是真实出现过的组合。

## 安装

- **DSHA**：插件市场粘贴本仓库链接安装；
- **命令行**：`dsh plugin add github:rthdfd/dsh-codex-mask`

装完重启 Web，日志出现 `[dsh-codex-mask] 自动目标已更新：…` 即生效。

## 可选配置（一般不用动）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoTargets` | `true` | 自动发现你配的 provider；设 `false` 可关闭 |
| `match` | `[]` | 额外追加的 URL 子串匹配（在自动目标之外补充） |
| `kind` | `tui` | 客户端形态：`tui` / `desktop` / `vscode` / `exec`（被网关拒绝时换一个试） |
| `cliVersion` | `0.153.4` | 网关提示「请使用最新版」时在这里跟进（npm 上 codex 最新 0.154.0） |
| `sessionHeaders` | `false` | 追加会话级头（session_id/thread-id 等，UUIDv7，按请求随机） |
| `clientMetadata` | `true` | 请求体注入 `client_metadata` |
| `reasoning.effort` / `reasoning.summary` | `medium` / `auto` | 补 `reasoning` 时使用的值 |

## 已知限制

- 只改请求、不改响应；不做流式请求体的改写（dsh 的模型请求体都是 JSON 字符串，正常覆盖）。
- `installationId` 持久化在 `~/.dsh-codex-mask.json`；删除该文件会在下次启动重新生成。
- 自动目标 = 你手填 `baseURL` 的 provider 的 host；如果某个 provider 不想被伪装，把它的
  `baseURL` 留在内置目录里、或给插件配 `autoTargets: false` + 白名单 `match`。

## 开发

```bash
node test/smoke.mjs
```
