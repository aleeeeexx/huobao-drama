import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
