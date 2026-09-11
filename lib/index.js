/**
 * dsh-codex-mask — 让 dsh 发出的模型请求带上一枚可信的 Codex 客户端指纹。
 *
 * 零配置：装好后自动读取 llm-pi-ai 里你自己配置的 provider（手填了 baseURL 的行），
 * 把发往这些地址的请求改写为 Codex 客户端形态。其余流量原样直通，响应一概不改。
 *
 * 改写内容：
 *   1) 请求头：user-agent / originator / version / x-codex-installation-id
 *      （可选追加会话级头：session_id / thread-id / x-client-request-id / x-codex-window-id）
 *   2) 请求体（JSON）：注入 client_metadata；对 reasoning 与 tools 做出现性配对
 *
 * 指纹形状参考 codex2api（基于约 6.5 万条真实请求的统计实现）：
 *   UA = {originator}/{CLI版本} ({OS} {OS版本}; {架构}) {终端} ({应用名}; {应用版本})
 * desktop / vscode 形态的构建号与 CLI 版本成对出现，插件内置的是真实出现过的组合。
 *
 * @module dsh-codex-mask
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-codex-mask'

/** 进程级共享状态：所有实例共用同一条被包装的 fetch。 */
const STATE_KEY = Symbol.for('dsh.codex-mask.state')

/** 读取「你自己配置的 provider」所用的设置命名空间。 */
const SETTINGS_NS = 'llm-pi-ai'

/** 各客户端形态的画像。platform 与版本配对取自真实流量统计。 */
const KINDS = {
  tui: {
    originator: 'codex_cli_rs',
    appName: 'codex_cli_rs',
    appFollowsCli: true,
    platform: { os: 'Windows', version: '10.0.26200', arch: 'x86_64' },
    terminal: 'unknown',
  },
  desktop: {
    originator: 'Codex Desktop',
    appName: 'Codex Desktop',
    appFollowsCli: false,
    platform: { os: 'Windows', version: '10.0.26200', arch: 'x86_64' },
    terminal: 'unknown',
    pairs: [
      { cli: '0.153.4', app: '26.901.51231' },
      { cli: '0.153.4', app: '26.901.41600' },
      { cli: '0.153.0', app: '26.901.22334' },
    ],
  },
  vscode: {
    originator: 'codex_vscode',
    appName: 'VS Code',
    appFollowsCli: false,
    platform: { os: 'Ubuntu', version: '22.4.0', arch: 'x86_64' },
    terminal: 'unknown',
    pairs: [{ cli: '0.153.0', app: '26.901.22334' }],
  },
  exec: {
    originator: 'codex_exec',
    appName: 'codex_exec',
    appFollowsCli: true,
    platform: { os: 'Windows', version: '10.0.19045', arch: 'x86_64' },
    terminal: 'unknown',
  },
}

const DEFAULTS = {
  enabled: true,
  /** 自动把「你自己配置的 provider」加入伪装目标（零配置的关键）。 */
  autoTargets: true,
  /** 额外追加的 URL 子串匹配（可选）。 */
  match: [],
  /** tui | desktop | vscode | exec */
  kind: 'tui',
  /** CLI 版本；desktop/vscode 形态会与内置构建号配对。 */
  cliVersion: '0.153.4',
  /** desktop/vscode 的构建号；留空自动取配对。 */
  appVersion: '',
  /** { os, version, arch }，留空用形态默认。 */
  platform: null,
  /** 终端标识，留空用形态默认。 */
  terminal: '',
  /** 'auto' = 首次生成 UUIDv4 并持久化到 ~/.dsh-codex-mask.json。 */
  installationId: 'auto',
  /** 追加会话级头（session_id / thread-id / x-client-request-id / x-codex-window-id）。 */
  sessionHeaders: false,
  /** 请求体注入 client_metadata。 */
  clientMetadata: true,
  /** reasoning 与 tools 的配对规则。 */
  reasoning: { enabled: true, effort: 'medium', summary: 'auto', pairWithTools: true },
}

/** 重建请求时要走「透传」而非「改写」的 init 键。 */
const PASS_KEYS = new Set(['method', 'headers', 'body', 'signal', 'redirect', 'duplex'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并：对象递归合并，数组与标量直接覆盖。 */
function merge(base, patch) {
  if (patch === undefined) return base
  if (!isObject(base) || !isObject(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value)
  return out
}

/** UUIDv7（RFC 9562）：真实 Codex 的 session/thread/window 标识均为 v7。 */
function uuidv7() {
  const ts = Date.now()
  const b = randomBytes(16)
  b[0] = Math.floor(ts / 2 ** 40) & 0xff
  b[1] = Math.floor(ts / 2 ** 32) & 0xff
  b[2] = Math.floor(ts / 2 ** 24) & 0xff
  b[3] = Math.floor(ts / 2 ** 16) & 0xff
  b[4] = Math.floor(ts / 2 ** 8) & 0xff
  b[5] = ts & 0xff
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** installation id：显式配置 > 持久化文件 > 现造一个（写失败时仅本进程内稳定）。 */
function resolveInstallationId(configured) {
  if (typeof configured === 'string' && configured.length > 0 && configured !== 'auto') return configured
  const file = join(homedir(), '.dsh-codex-mask.json')
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(saved) && typeof saved.installationId === 'string' && saved.installationId) {
      return saved.installationId
    }
  } catch {}
  const id = randomUUID()
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ installationId: id, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch {}
  return id
}

/** 组装出站画像：UA 串 + originator + CLI 版本。 */
function resolvePersona(cfg) {
  const spec = KINDS[cfg.kind] || KINDS.tui
  const platform = merge(spec.platform, isObject(cfg.platform) ? cfg.platform : {})
  const terminal = typeof cfg.terminal === 'string' && cfg.terminal ? cfg.terminal : spec.terminal || 'unknown'

  let cli = typeof cfg.cliVersion === 'string' ? cfg.cliVersion.trim() : ''
  let app = typeof cfg.appVersion === 'string' ? cfg.appVersion.trim() : ''

  if (spec.appFollowsCli) {
    if (!cli) cli = '0.153.4'
    if (!app) app = cli
  } else {
    const pairs = spec.pairs || []
    const fallback = pairs[0] || { cli: '0.153.4', app: '26.901.51231' }
    if (!cli && !app) {
      cli = fallback.cli
      app = fallback.app
    } else if (cli && !app) {
      const pair = pairs.find((x) => x.cli === cli)
      app = (pair && pair.app) || fallback.app
    } else if (!cli && app) {
      const pair = pairs.find((x) => x.app === app)
      cli = (pair && pair.cli) || fallback.cli
    }
  }

  const ua = `${spec.originator}/${cli} (${platform.os} ${platform.version}; ${platform.arch}) ${terminal} (${spec.appName}; ${app})`
  return { originator: spec.originator, cli, ua }
}

/** 改写请求头（原地修改传入的 Headers）。 */
function rewriteHeaders(headers, persona, installationId, cfg) {
  headers.set('user-agent', persona.ua)
  headers.set('originator', persona.originator)
  headers.set('version', persona.cli)
  headers.set('x-codex-installation-id', installationId)
  if (cfg.sessionHeaders) {
    const thread = uuidv7()
    headers.set('session_id', uuidv7())
    headers.set('thread-id', thread)
    headers.set('x-client-request-id', thread)
    headers.set('x-codex-window-id', `${thread}:0`)
  }
}

/** 改写 JSON 请求体：client_metadata 注入 + reasoning/tools 配对。 */
function transformBody(text, installationId, cfg) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return text
  }
  if (!isObject(obj)) return text
  let changed = false

  if (cfg.clientMetadata) {
    const meta = isObject(obj.client_metadata) ? obj.client_metadata : {}
    if (meta['x-codex-installation-id'] !== installationId) {
      meta['x-codex-installation-id'] = installationId
      changed = true
    }
    obj.client_metadata = meta
  }

  const reasoning = isObject(cfg.reasoning) ? cfg.reasoning : {}
  if (reasoning.enabled !== false) {
    const hasTools = Array.isArray(obj.tools)
    const hasReasoning = isObject(obj.reasoning)
    if (hasTools && !hasReasoning) {
      obj.reasoning = {
        effort: typeof reasoning.effort === 'string' && reasoning.effort ? reasoning.effort : 'medium',
        summary: typeof reasoning.summary === 'string' && reasoning.summary ? reasoning.summary : 'auto',
      }
      changed = true
    } else if (!hasTools && hasReasoning && reasoning.pairWithTools !== false) {
      delete obj.reasoning
      changed = true
    }
  }

  return changed ? JSON.stringify(obj) : text
}

/** 将被匹配的请求改写成 Codex 指纹形态后发出；任何异常都回退原样直通。 */
async function handleMatched(input, init, cfg, persona, installationId) {
  const state = globalThis[STATE_KEY]
  const original = state.original
  let req
  try {
    req = new Request(input, init)
  } catch {
    return original(input, init)
  }

  const headers = new Headers(req.headers)
  rewriteHeaders(headers, persona, installationId, cfg)

  const extra = {}
  if (isObject(init)) {
    for (const [key, value] of Object.entries(init)) {
      if (!PASS_KEYS.has(key)) extra[key] = value
    }
  }

  const method = req.method.toUpperCase()
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  const hasInitBody = isObject(init) && init.body !== undefined && init.body !== null
  const hasBody = hasInitBody || req.body !== null

  if (method === 'GET' || method === 'HEAD' || !hasBody) {
    return original(req.url, { ...extra, method: req.method, headers, signal: req.signal, redirect: req.redirect })
  }
  if (!contentType.includes('json')) {
    return original(req.url, {
      ...extra,
      method: req.method,
      headers,
      body: req.body,
      duplex: 'half',
      signal: req.signal,
      redirect: req.redirect,
    })
  }

  let text
  try {
    text = await req.text()
  } catch {
    return original(input, init)
  }
  const outputText = transformBody(text, installationId, cfg)
  return original(req.url, { ...extra, method: req.method, headers, body: outputText, signal: req.signal, redirect: req.redirect })
}

/** 安装/复用一个被包装过的 fetch；返回卸载函数。 */
function installFetchPatch(handler) {
  const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = { original: null, handlers: new Set() })
  if (state.original === null) {
    state.original = globalThis.fetch.bind(globalThis)
    globalThis.fetch = function dshCodexMaskFetch(input, init) {
      for (const candidate of state.handlers) {
        try {
          const result = candidate(input, init)
          if (result !== undefined) return result
        } catch {}
      }
      return state.original(input, init)
    }
  }
  state.handlers.add(handler)
  return () => {
    state.handlers.delete(handler)
  }
}

/** 从 baseURL 里提取 host（自动目标匹配用）。 */
function hostOf(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    return new URL(text).host
  } catch {}
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(text)
  if (match) return match[1]
  const first = text.split('/')[0]
  return first.includes('.') ? first : ''
}

/**
 * 读取 settings（llm-pi-ai 用户分节）里手填 baseURL 的 provider host。
 * 这就是「零配置」的来源：你在 dsh 里配过哪些网关，就自动伪装哪些地址。
 */
function collectAutoTargets(ctx) {
  const targets = new Set()
  try {
    const settings = ctx?.get?.('settings')
    if (!settings || typeof settings.describe !== 'function') return targets
    const row = settings.describe().find((candidate) => isObject(candidate) && candidate.ns === SETTINGS_NS)
    const providers = isObject(row?.user) && isObject(row.user.providers) ? row.user.providers : undefined
    if (providers === undefined) return targets
    for (const route of Object.values(providers)) {
      if (!isObject(route)) continue
      const host = hostOf(route.baseURL)
      if (host) targets.add(host)
    }
  } catch {}
  return targets
}

/** Cordis 插件入口。 */
export function apply(ctx, config) {
  const cfg = merge(DEFAULTS, isObject(config) ? config : {})
  if (cfg.enabled === false) return

  const log = (message) => {
    try {
      console.log(`[dsh-codex-mask] ${message}`)
    } catch {}
  }

  const persona = resolvePersona(cfg)
  const installationId = resolveInstallationId(cfg.installationId)
  const explicitPatterns = Array.isArray(cfg.match)
    ? cfg.match.filter((item) => typeof item === 'string' && item.length > 0)
    : []

  let autoTargets = new Set()
  let lastShape = ''
  let attempts = 0

  const refreshTargets = (reason) => {
    if (cfg.autoTargets === false) return
    const next = collectAutoTargets(ctx)
    const shape = [...next].sort().join('|')
    if (shape !== lastShape) {
      lastShape = shape
      autoTargets = next
      if (next.size > 0) log(`自动目标已更新：${[...next].join(' / ')}`)
    }
    if (next.size === 0 && attempts < 6) {
      attempts += 1
      const timer = setTimeout(() => refreshTargets(`retry#${attempts}`), Math.min(1500 * 2 ** (attempts - 1), 15000))
      timer.unref?.()
    }
  }

  refreshTargets('initial')
  for (const event of ['settings/updated', 'settings/document-updated']) {
    try {
      ctx?.on?.(event, (ns) => {
        if (ns === SETTINGS_NS) refreshTargets(`event:${event}`)
      })
    } catch {}
  }

  const handler = (input, init) => {
    let url = ''
    try {
      url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : isObject(input) && typeof input.url === 'string'
            ? input.url
            : ''
    } catch {
      return undefined
    }
    if (!url || !/^https?:/i.test(url)) return undefined
    let matched = explicitPatterns.some((pattern) => url.includes(pattern))
    if (!matched) {
      for (const target of autoTargets) {
        if (url.includes(target)) {
          matched = true
          break
        }
      }
    }
    if (!matched) return undefined
    return handleMatched(input, init, cfg, persona, installationId)
  }

  const uninstall = installFetchPatch(handler)
  if (autoTargets.size > 0 || explicitPatterns.length > 0) {
    log(`已启用：伪装目标 ${[...explicitPatterns, ...autoTargets].join(' / ')}；UA = ${persona.ua}`)
  } else {
    log('已启用：暂未发现目标（等你在 llm-pi-ai 里配置 provider，或填 config.match）')
  }
  try {
    ctx?.effect?.(() => uninstall)
  } catch {}
}
