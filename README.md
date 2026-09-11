# dsh-codex-mask

让 DeepSeek Harness（dsh）发出的模型请求带上一枚可信的 **Codex 客户端指纹**——
用于访问「只认 Codex 客户端」的 OpenAI 兼容网关（例如各公益站的 `/codex` 端点）。

装好之后**不需要再挂本地代理**（如 `codex-mask.mjs`）：插件直接在本进程内完成改写。

## 功能

- **请求头**：`user-agent` / `originator` / `version` / `x-codex-installation-id`
  （可选追加 `session_id` / `thread-id` / `x-client-request-id` / `x-codex-window-id`）
- **请求体（JSON）**：注入 `client_metadata`；按「`reasoning` 与 `tools` 同时出现或同时缺」
  的规则自动配对（有 tools 没 reasoning 时补 `reasoning`；有 reasoning 没 tools 时去掉 reasoning，
  可用 `reasoning.pairWithTools: false` 关掉后半条）
- 只影响 `match` 命中的 URL，其余流量（含响应）原样直通

指纹形状取自真实流量统计（参考 codex2api 的公开实现）：

```
UA = {originator}/{CLI版本} ({OS} {OS版本}; {架构}) {终端} ({应用名}; {应用版本})
```

desktop / vscode 形态的构建号与 CLI 版本是**成对**出现的，插件内置的是真实出现过的组合，
不要随意混搭——组合错了会生成真实流量里从未出现过的指纹。

## 安装

- **DSHA**：在插件市场粘贴本仓库链接安装（或下载发布包后用「导入插件包」）。
- **其他 dsh 环境**：把包安装进 profile 依赖后，由 `cordis.patch.yml` 自动挂载，
  也可以在自己的 profile patch 里加一条同 id 的行来覆盖配置：

```yaml
- insert:
    - id: codex-mask
      name: 'dsh-codex-mask'
      config:
        match: ['sharedchat.cc']
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `match` | `[]` | 目标 URL 子串列表；**为空则插件完全不生效**（安全默认值） |
| `kind` | `tui` | 客户端形态：`tui` / `desktop` / `vscode` / `exec` |
| `cliVersion` | `0.153.4` | CLI 版本；网关要求更新版本时改这里 |
| `appVersion` | 自动 | `desktop` / `vscode` 的构建号，留空自动用内置配对 |
| `platform` | 形态默认 | `{ os, version, arch }` |
| `terminal` | `unknown` | UA 中的终端标识 |
| `installationId` | `auto` | `auto` = 首次生成 UUIDv4 并持久化到 `~/.dsh-codex-mask.json` |
| `sessionHeaders` | `false` | 追加会话级头（session_id/thread-id 等，UUIDv7） |
| `clientMetadata` | `true` | 请求体注入 `client_metadata: { "x-codex-installation-id": … }` |
| `reasoning.effort` | `medium` | 补 `reasoning` 时使用的档位 |
| `reasoning.summary` | `auto` | 补 `reasoning` 时使用的 summary 值 |
| `reasoning.pairWithTools` | `true` | 「有 reasoning 没 tools 时去掉 reasoning」是否生效 |

完整示例：

```yaml
- id: codex-mask
  name: 'dsh-codex-mask'
  config:
    match: ['sharedchat.cc']
    kind: desktop            # 也可以试 tui
    # cliVersion: '0.153.4'  # 网关提示「请使用最新版」时在这里跟进版本
    # sessionHeaders: true
```

## 已知限制

- 只改请求、不改响应；不做流式请求体的改写（dsh 的模型请求体都是 JSON 字符串，正常覆盖）。
- 会话级头的 session/thread 标识按请求随机生成（与 codex2api 的默认隔离模式一致），
  不维护跨请求的会话连续性。
- `installationId` 持久化在 `~/.dsh-codex-mask.json`；删除该文件会在下次启动重新生成。
- 网关若有其他专属规则（特定路径、特定模型名），不在本插件职责内。

## 开发

```bash
node test/smoke.mjs
```

冒烟测试覆盖：头改写、client_metadata 注入、reasoning/tools 配对（补/删/保持）、
未命中直通、多实例不叠加。
