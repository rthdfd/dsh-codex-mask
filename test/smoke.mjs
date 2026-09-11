// 冒烟测试：node test/smoke.mjs
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const calls = []
globalThis.fetch = async (input, init) => {
  calls.push({ url: typeof input === 'string' ? input : input.url, init: init || {} })
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}

// 假的 settings 服务：模拟 llm-pi-ai 用户分节
const settingsRows = [{
  ns: 'llm-pi-ai',
  revision: 1,
  user: {
    providers: {
      sharedchat: { api: 'openai-responses', baseURL: 'https://new.sharedchat.cc/codex', models: [{ id: 'gpt-5.6-sol' }] },
      'my-proxy': { baseURL: 'http://127.0.0.1:3999' },
      noBaseURL: { models: [{ id: 'x' }] },
    },
  },
}]
const cleanups = []
const makeCtx = () => ({
  get: (key) => (key === 'settings' ? { describe: () => settingsRows } : undefined),
  on: () => {},
  effect: (callback) => { cleanups.push(callback()) },
})

// ★ 零配置：不传任何 config
apply(makeCtx(), {})

// 1) 自动目标命中：头/体改写
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-x' },
  body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], tools: [{ type: 'function', name: 'f' }] }),
})
{
  const { init } = calls.at(-1)
  const h = new Headers(init.headers)
  assert.equal(
    h.get('user-agent'),
    'codex_cli_rs/0.153.4 (Windows 10.0.26200; x86_64) unknown (codex_cli_rs; 0.153.4)',
  )
  assert.equal(h.get('originator'), 'codex_cli_rs')
  assert.equal(h.get('version'), '0.153.4')
  assert.match(h.get('x-codex-installation-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(h.get('authorization'), 'Bearer sk-x')
  const body = JSON.parse(init.body)
  assert.equal(body.client_metadata['x-codex-installation-id'], h.get('x-codex-installation-id'))
  assert.deepEqual(body.reasoning, { effort: 'medium', summary: 'auto' })
  assert.equal(body.tools.length, 1)
}

// 2) 127.0.0.1:3999 也是自动目标
await fetch('http://127.0.0.1:3999/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
{
  const h = new Headers(calls.at(-1).init.headers)
  assert.equal(h.get('originator'), 'codex_cli_rs')
}

// 3) 无关域名：原样直通
await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
{
  const h = new Headers(calls.at(-1).init.headers)
  assert.equal(h.get('originator'), null)
  assert.equal(h.get('user-agent'), null)
}

// 4) 有 reasoning 无 tools：去掉（配对）
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reasoning: { effort: 'high' } }),
})
assert.equal(JSON.parse(calls.at(-1).init.body).reasoning, undefined)

// 5) 关闭自动目标且无 match：不伪装，原样直通
cleanups.forEach((cleanup) => cleanup())
cleanups.length = 0
const calls2 = []
globalThis.fetch = async (input, init) => {
  calls2.push({ init: init || {} })
  return new Response('{"ok":true}')
}
apply(makeCtx(), { autoTargets: false })
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
{
  const h = new Headers(calls2.at(-1).init.headers)
  assert.equal(h.get('originator'), null)
}

console.log('all smoke tests passed ✓')
