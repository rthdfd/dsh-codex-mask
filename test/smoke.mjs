// 冒烟测试：node test/smoke.mjs
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const calls = []
globalThis.fetch = async (input, init) => {
  calls.push({ url: typeof input === 'string' ? input : input.url, init: init || {} })
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}

apply({ effect: () => () => {} }, { match: ['sharedchat.cc'], kind: 'desktop', sessionHeaders: true })

// 1) 命中 + 有 tools 无 reasoning：补 reasoning、注 client_metadata、头改写
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
    'Codex Desktop/0.153.4 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.901.51231)',
  )
  assert.equal(h.get('originator'), 'Codex Desktop')
  assert.equal(h.get('version'), '0.153.4')
  assert.match(h.get('x-codex-installation-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(h.get('authorization'), 'Bearer sk-x')
  assert.match(h.get('session_id'), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const body = JSON.parse(init.body)
  assert.equal(body.client_metadata['x-codex-installation-id'], h.get('x-codex-installation-id'))
  assert.deepEqual(body.reasoning, { effort: 'medium', summary: 'auto' })
  assert.equal(body.tools.length, 1)
}

// 2) 命中 + 有 reasoning 无 tools：去掉 reasoning（配对）
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reasoning: { effort: 'high' } }),
})
{
  const body = JSON.parse(calls.at(-1).init.body)
  assert.equal(body.reasoning, undefined)
}

// 3) 命中 + 两者都有：保持原样
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reasoning: { effort: 'high' }, tools: [] }),
})
{
  const body = JSON.parse(calls.at(-1).init.body)
  assert.equal(body.reasoning.effort, 'high')
}

// 4) 未命中：原样直通
await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tools: [] }),
})
{
  const { init } = calls.at(-1)
  const h = new Headers(init.headers)
  assert.equal(h.get('originator'), null)
  assert.equal(h.get('user-agent'), null)
  assert.equal(JSON.parse(init.body).client_metadata, undefined)
}

// 5) 二次 apply（默认 tui 形态）不会叠加改写：先命中的 desktop 实例生效
apply({ effect: () => () => {} }, { match: ['sharedchat.cc'] })
await fetch('https://new.sharedchat.cc/codex/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
})
{
  const h = new Headers(calls.at(-1).init.headers)
  assert.ok(h.get('user-agent').startsWith('Codex Desktop/'), 'first matched instance wins')
  assert.ok(!h.get('user-agent').includes('codex_cli_rs/'), 'no double-rewrite')
}

console.log('all smoke tests passed ✓')
