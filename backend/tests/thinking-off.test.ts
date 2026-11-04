import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEC_BROWSER_USER_AGENT,
  installCodeccUserAgentFetch,
  installThinkingOffFetch,
  isCodeccHost,
  isUnsupportedReasoningEffortError,
  modelRejectsReasoningEffortNone,
  type ThinkingOffState,
} from '../src/agents/thinking-off.ts'

function freshState(): ThinkingOffState {
  return { rejected: new Set(), noted: new Set() }
}

function chatFetch(status: number, text: string, onBody?: (body: any) => void) {
  const bodies: any[] = []
  const fetchImpl = async (_input: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null
    bodies.push(body)
    onBody?.(body)
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, bodies }
}

const chatInit = (model: string) => ({
  method: 'POST',
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: '开场' }],
  }),
})

test('codecc drops reasoning_effort none and keeps the other thinking-off fields', async () => {
  const { fetchImpl, bodies } = chatFetch(200, '{"ok":true}')
  const wrapped = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://codecc.cc/v1',
    enabled: true,
    fetchImpl: fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(wrapped)
  await wrapped('https://codecc.cc/v1/chat/completions', chatInit('grok-4.7'))
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].reasoning_effort, undefined)
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
  assert.equal(bodies[0].enable_thinking, false)
  assert.equal(bodies[0].model, 'grok-4.7')
})

test('codecc subdomains are treated as codecc; lookalike hosts are not', async () => {
  assert.equal(isCodeccHost('https://api.codecc.cc/v1'), true)
  assert.equal(isCodeccHost('https://codecc.cc.evil.com/v1'), false)
  const { fetchImpl, bodies } = chatFetch(200, '{"ok":true}')
  const wrapped = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://codecc.cc.evil.com/v1',
    enabled: true,
    fetchImpl: fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(wrapped)
  await wrapped('https://codecc.cc.evil.com/v1/chat/completions', chatInit('gpt-4o-mini'))
  assert.equal(bodies[0].reasoning_effort, 'none')
})

test('grok models drop reasoning_effort none on any host; gemini-compatible channels keep it', async () => {
  assert.equal(modelRejectsReasoningEffortNone('grok-4.7'), true)
  assert.equal(modelRejectsReasoningEffortNone('vendor/grok-4'), true)
  assert.equal(modelRejectsReasoningEffortNone('gemini-2.5-flash'), false)

  const grok = chatFetch(200, '{"ok":true}')
  const grokFetch = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://api.x.ai/v1',
    enabled: true,
    fetchImpl: grok.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(grokFetch)
  await grokFetch('https://api.x.ai/v1/chat/completions', chatInit('grok-4'))
  assert.equal(grok.bodies[0].reasoning_effort, undefined)
  assert.equal(grok.bodies[0].enable_thinking, false)

  const gemini = chatFetch(200, '{"ok":true}')
  const geminiFetch = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://gemini-proxy.example/v1',
    enabled: true,
    fetchImpl: gemini.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(geminiFetch)
  await geminiFetch('https://gemini-proxy.example/v1/chat/completions', chatInit('gemini-2.5-flash'))
  assert.equal(gemini.bodies[0].reasoning_effort, 'none')
  assert.deepEqual(gemini.bodies[0].thinking, { type: 'disabled' })
})

test('official OpenAI and Gemini hosts, and the disable switch, skip the patch', () => {
  assert.equal(installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://api.openai.com/v1',
    enabled: true,
    state: freshState(),
  }), undefined)
  assert.equal(installThinkingOffFetch({
    providerName: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    enabled: true,
    state: freshState(),
  }), undefined)
  assert.equal(installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://codecc.cc/v1',
    enabled: false,
    state: freshState(),
  }), undefined)
})

test('explicit low effort is kept; a custom patch without reasoning_effort is sent as written', async () => {
  const low = chatFetch(200, '{"ok":true}')
  const lowFetch = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://codecc.cc/v1',
    enabled: true,
    patchRaw: '{"reasoning_effort":"low","enable_thinking":false}',
    fetchImpl: low.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(lowFetch)
  await lowFetch('https://codecc.cc/v1/chat/completions', chatInit('grok-4.7'))
  assert.equal(low.bodies[0].reasoning_effort, 'low')

  const custom = chatFetch(200, '{"ok":true}')
  const customFetch = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    enabled: true,
    patchRaw: '{"thinking":{"type":"disabled"},"enable_thinking":false}',
    fetchImpl: custom.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(customFetch)
  await customFetch('https://api.deepseek.com/v1/chat/completions', chatInit('deepseek-chat'))
  assert.equal(custom.bodies[0].reasoning_effort, undefined)
  assert.equal(custom.bodies[0].enable_thinking, false)
})

test('gateway 500 Upstream gateway error is retried once without reasoning_effort and then remembered', async () => {
  const state = freshState()
  let calls = 0
  const bodies: any[] = []
  const fetchImpl = async (_input: any, init?: any) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    calls += 1
    if (body.reasoning_effort === 'none') {
      return new Response(JSON.stringify({ error: { message: 'Upstream gateway error' } }), { status: 500 })
    }
    return new Response('{"ok":true}', { status: 200 })
  }
  const wrapped = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://proxy.example/v1',
    enabled: true,
    fetchImpl: fetchImpl as typeof fetch,
    state,
  })
  assert.ok(wrapped)
  const first = await wrapped('https://proxy.example/v1/chat/completions', chatInit('vendor-model'))
  assert.equal(first.status, 200)
  assert.equal(calls, 2)
  assert.equal(bodies[0].reasoning_effort, 'none')
  assert.equal(bodies[1].reasoning_effort, undefined)
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' })

  const before = calls
  const second = await wrapped('https://proxy.example/v1/chat/completions', chatInit('vendor-model'))
  assert.equal(second.status, 200)
  assert.equal(calls, before + 1)
  assert.equal(bodies[bodies.length - 1].reasoning_effort, undefined)
})

test('unrelated upstream 500 is returned as-is and does not drop the field', async () => {
  const { fetchImpl, bodies } = chatFetch(500, '{"error":{"message":"model overloaded"}}')
  const wrapped = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    enabled: true,
    fetchImpl: fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(wrapped)
  const response = await wrapped('https://api.deepseek.com/v1/chat/completions', chatInit('deepseek-chat'))
  assert.equal(response.status, 500)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].reasoning_effort, 'none')
  assert.match(await response.text(), /overloaded/)
  assert.equal(isUnsupportedReasoningEffortError(429, 'Upstream gateway error'), false)
  assert.equal(isUnsupportedReasoningEffortError(400, 'Invalid reasoning effort.'), true)
})

test('non-official gemini keeps native thinkingConfig and does not use reasoning_effort', async () => {
  const older = chatFetch(200, '{"ok":true}')
  const olderFetch = installThinkingOffFetch({
    providerName: 'gemini',
    baseURL: 'https://gemini.example/v1beta',
    enabled: true,
    fetchImpl: older.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(olderFetch)
  await olderFetch('https://gemini.example/v1beta/models/gemini-2.0-flash:generateContent', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  assert.deepEqual(older.bodies[0].generationConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: false })
  assert.equal(older.bodies[0].reasoning_effort, undefined)

  const gemini3 = chatFetch(200, '{"ok":true}')
  const gemini3Fetch = installThinkingOffFetch({
    providerName: 'gemini',
    baseURL: 'https://gemini.example/v1beta',
    enabled: true,
    fetchImpl: gemini3.fetchImpl as typeof fetch,
    state: freshState(),
  })
  assert.ok(gemini3Fetch)
  await gemini3Fetch('https://gemini.example/v1beta/models/gemini-3-pro:generateContent', {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  assert.deepEqual(gemini3.bodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'low' })
})

function recordFetch() {
  const seen: Array<{ input: unknown; init: any }> = []
  const fetchImpl = async (input: unknown, init?: any) => {
    seen.push({ input, init })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl: fetchImpl as typeof fetch, seen }
}

test('codecc fetch keeps plain authorization headers and adds a browser user agent', async () => {
  const { fetchImpl, seen } = recordFetch()
  const wrapped = installCodeccUserAgentFetch(fetchImpl)
  const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }
  await wrapped('https://codecc.cc/v1/chat/completions', { method: 'POST', headers, body: '{}' })
  assert.equal(seen[0].init.headers instanceof Headers, false)
  assert.equal(seen[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json')
  assert.equal(seen[0].init.headers['User-Agent'], CODEC_BROWSER_USER_AGENT)
  assert.equal('User-Agent' in headers, false)

  const models = { Authorization: 'Bearer test-key' }
  await wrapped('https://api.codecc.cc/v1/models', { method: 'GET', headers: models })
  assert.equal(seen[1].init.headers.Authorization, 'Bearer test-key')
  assert.equal(seen[1].init.headers['User-Agent'], CODEC_BROWSER_USER_AGENT)
  assert.equal(Array.isArray(seen[1].init.headers), false)
})

test('an existing user agent is kept, and a runtime signature is replaced only on codecc', async () => {
  const { fetchImpl, seen } = recordFetch()
  const wrapped = installCodeccUserAgentFetch(fetchImpl)
  const custom = { method: 'GET', headers: { Authorization: 'Bearer test-key', 'User-Agent': 'MyApp/1.0' } }
  await wrapped('https://codecc.cc/v1/models', custom)
  assert.equal(seen[0].init, custom)
  assert.equal(seen[0].init.headers['User-Agent'], 'MyApp/1.0')

  const browser = { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (custom) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36' } }
  await wrapped('https://codecc.cc/v1/models', browser)
  assert.equal(seen[1].init, browser)

  const runtimeHeaders = {
    authorization: 'Bearer test-key',
    'content-type': 'application/json',
    'user-agent': 'ai-sdk/provider-utils/4.0.21 runtime/node.js/v22.23.4',
  }
  await wrapped('https://codecc.cc/v1/chat/completions', { method: 'POST', headers: runtimeHeaders, body: '{}' })
  assert.equal(seen[2].init.headers.authorization, 'Bearer test-key')
  assert.equal(seen[2].init.headers['content-type'], 'application/json')
  assert.equal(seen[2].init.headers['user-agent'], undefined)
  assert.equal(seen[2].init.headers['User-Agent'], CODEC_BROWSER_USER_AGENT)
  assert.equal(seen[2].init.headers instanceof Headers, false)
  assert.equal(runtimeHeaders['user-agent'], 'ai-sdk/provider-utils/4.0.21 runtime/node.js/v22.23.4')

  const elsewhere = { method: 'GET', headers: { Authorization: 'Bearer test-key' } }
  await wrapped('https://api.deepseek.com/v1/models', elsewhere)
  assert.equal(seen[3].init, elsewhere)
  assert.equal(seen[3].init.headers['User-Agent'], undefined)

  await wrapped('https://codecc.cc.evil.com/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test-key' } })
  assert.equal(seen[4].init.headers['User-Agent'], undefined)
  assert.equal(seen[4].init.headers.Authorization, 'Bearer test-key')
})

test('header lists and request objects gain a browser user agent without dropping authorization', async () => {
  const { fetchImpl, seen } = recordFetch()
  const wrapped = installCodeccUserAgentFetch(fetchImpl)
  await wrapped('https://codecc.cc/v1/models', {
    method: 'GET',
    headers: [['Authorization', 'Bearer list-key'], ['Accept', 'application/json']],
  })
  assert.equal(Array.isArray(seen[0].init.headers), true)
  assert.deepEqual(seen[0].init.headers[0], ['Authorization', 'Bearer list-key'])
  assert.deepEqual(seen[0].init.headers[2], ['User-Agent', CODEC_BROWSER_USER_AGENT])

  const headerObject = new Headers({ Authorization: 'Bearer header-key' })
  await wrapped('https://api.codecc.cc/v1/models', { method: 'GET', headers: headerObject })
  assert.equal(seen[1].init.headers instanceof Headers, true)
  assert.equal(seen[1].init.headers.get('authorization'), 'Bearer header-key')
  assert.equal(seen[1].init.headers.get('user-agent'), CODEC_BROWSER_USER_AGENT)
  assert.equal(headerObject.get('user-agent'), null)

  const request = new Request('https://codecc.cc/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer request-key', 'Content-Type': 'application/json' },
    body: '{}',
  })
  await wrapped(request)
  assert.equal(seen[2].input, request)
  assert.equal(seen[2].init.headers instanceof Headers, true)
  assert.equal(seen[2].init.headers.get('authorization'), 'Bearer request-key')
  assert.equal(seen[2].init.headers.get('user-agent'), CODEC_BROWSER_USER_AGENT)

  const preset = new Request('https://codecc.cc/v1/models', {
    headers: { Authorization: 'Bearer kept', 'User-Agent': 'MyApp/1.0' },
  })
  await wrapped(preset)
  assert.equal(seen[3].init, undefined)
})

test('thinking-off wrapper adds the browser user agent on codecc without changing other hosts', async () => {
  const codecc = recordFetch()
  const wrapped = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://codecc.cc/v1',
    enabled: true,
    fetchImpl: codecc.fetchImpl,
    state: freshState(),
  })
  assert.ok(wrapped)
  const headers = { Authorization: 'Bearer test-key' }
  await wrapped('https://codecc.cc/v1/chat/completions', { ...chatInit('grok-4.7'), headers })
  assert.equal(codecc.seen[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(codecc.seen[0].init.headers['User-Agent'], CODEC_BROWSER_USER_AGENT)
  assert.equal(JSON.parse(codecc.seen[0].init.body).reasoning_effort, undefined)
  assert.equal('User-Agent' in headers, false)

  await wrapped('/v1/chat/completions', chatInit('grok-4.7'))
  assert.equal(codecc.seen[1].init.headers['User-Agent'], CODEC_BROWSER_USER_AGENT)

  await wrapped('https://api.deepseek.com/v1/chat/completions', chatInit('deepseek-chat'))
  assert.equal(codecc.seen[2].init.headers, undefined)

  const other = recordFetch()
  const otherFetch = installThinkingOffFetch({
    providerName: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    enabled: true,
    fetchImpl: other.fetchImpl,
    state: freshState(),
  })
  assert.ok(otherFetch)
  const otherHeaders = { Authorization: 'Bearer test-key' }
  await otherFetch('https://api.deepseek.com/v1/chat/completions', { ...chatInit('deepseek-chat'), headers: otherHeaders })
  assert.equal(other.seen[0].init.headers, otherHeaders)
  assert.equal(other.seen[0].init.headers['User-Agent'], undefined)
})
