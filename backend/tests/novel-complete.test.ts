import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { NOVEL_MAX_TOKENS } from '../src/services/novel/project.ts'

process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.SQLITE_PATH = path.join(os.tmpdir(), `huobao-novel-complete-${process.pid}.sqlite3`)

const { completeNovelPrompt } = await import('../src/services/novel/complete.ts')

const PROMPT = '创意如下：雨夜茶寮'

interface RecordedRequest {
  url: string
  init: any
  body: any
}

function textConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    baseUrl: 'https://codecc.cc',
    apiKey: 'test-key',
    model: 'grok-4.7',
    temperature: 0.4,
    ...overrides,
  }
}

function scriptedFetch(steps: Array<{ status?: number; body: string }>) {
  const queue = [...steps]
  const requests: RecordedRequest[] = []
  const fetchImpl = async (input: any, init?: any) => {
    const step = queue.shift()
    if (!step) throw new Error(`unexpected request ${String(input)}`)
    const raw = typeof init?.body === 'string' ? init.body : ''
    requests.push({ url: String(input), init, body: raw ? JSON.parse(raw) : null })
    return new Response(step.body, {
      status: step.status ?? 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
  }
  return { fetchImpl: fetchImpl as typeof fetch, requests }
}

function chatDelta(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

function sse(events: unknown[]) {
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n`
}

function chatStream(parts: string[]) {
  return sse([
    chatDelta({ role: 'assistant' }),
    chatDelta({ reasoning_content: '先想设定' }),
    ...parts.map(part => chatDelta({ content: part })),
    chatDelta({}, 'stop'),
  ])
}

async function withTimeoutSpy<T>(run: () => Promise<T>) {
  const original = AbortSignal.timeout
  const timeouts: number[] = []
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds)
    return original.call(AbortSignal, milliseconds)
  }) as typeof AbortSignal.timeout
  try {
    return { result: await run(), timeouts }
  } finally {
    AbortSignal.timeout = original
  }
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('completeNovelPrompt streaming', { concurrency: false }, () => {
  test('stitches a codecc stream into the full text and keeps the request patches', async () => {
    const { fetchImpl, requests } = scriptedFetch([{ body: chatStream(['雨夜', '的茶寮']) }])
    const { result, timeouts } = await withEnv('AI_THINKING_OFF_PATCH', undefined, () => (
      withTimeoutSpy(() => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl }))
    ))
    assert.equal(result, '雨夜的茶寮')
    assert.equal(typeof result, 'string')
    assert.deepEqual(timeouts, [600_000])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://codecc.cc/v1/chat/completions')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key')
    assert.equal(requests[0].init.headers.Accept, 'text/event-stream')
    assert.ok(requests[0].init.signal instanceof AbortSignal)
    assert.equal(requests[0].body.model, 'grok-4.7')
    assert.equal(requests[0].body.stream, true)
    assert.equal(requests[0].body.temperature, 0.4)
    assert.equal(requests[0].body.max_tokens, NOVEL_MAX_TOKENS)
    assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: PROMPT }])
    assert.equal(requests[0].body.reasoning_effort, undefined)
    assert.equal(requests[0].body.thinking, undefined)
    assert.equal(requests[0].body.enable_thinking, false)
  })

  test('joins keepalive frames, content arrays, and CRLF chunks', async () => {
    const body = [
      ': keep-alive',
      '',
      `data: ${JSON.stringify(chatDelta({ content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] }))}`,
      '',
      `data: ${JSON.stringify(chatDelta({ content: '丙' }))}`,
      '',
      'data: [DONE]',
      '',
    ].join('\r\n')
    const { fetchImpl } = scriptedFetch([{ body }])
    const text = await completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    assert.equal(text, '甲乙丙')
  })

  test('reads a non-stream JSON body when the gateway ignores stream', async () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          content: [
            { type: 'text', text: '完整' },
            '设定',
          ],
        },
      }],
    })
    const { fetchImpl, requests } = scriptedFetch([{ body }])
    const text = await completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    assert.equal(text, '完整设定')
    assert.equal(requests[0].body.stream, true)
  })

  test('official OpenAI stays streaming without max_tokens or thinking fields', async () => {
    const { fetchImpl, requests } = scriptedFetch([{
      body: JSON.stringify({ choices: [{ message: { content: '官方全文' } }] }),
    }])
    const text = await withEnv('AI_THINKING_OFF_PATCH', undefined, () => completeNovelPrompt(PROMPT, {
      config: textConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        temperature: null,
      }),
      fetchImpl,
    }))
    assert.equal(text, '官方全文')
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(requests[0].body.stream, true)
    assert.equal(requests[0].body.temperature, 0.7)
    assert.equal(requests[0].body.max_tokens, undefined)
    assert.equal(requests[0].body.thinking, undefined)
    assert.equal(requests[0].body.enable_thinking, undefined)
    assert.equal(requests[0].body.reasoning_effort, undefined)
  })

  test('keeps an explicit temperature of 0', async () => {
    const { fetchImpl, requests } = scriptedFetch([{
      body: sse([chatDelta({ content: '零温' })]),
    }])
    await completeNovelPrompt(PROMPT, {
      config: textConfig({ temperature: 0 }),
      fetchImpl,
    })
    assert.equal(requests[0].body.temperature, 0)
  })

  test('volcengine chat completion stays on the joined completions URL', async () => {
    const { fetchImpl, requests } = scriptedFetch([{
      body: sse([chatDelta({ content: '豆包全文' })]),
    }])
    const text = await withEnv('AI_THINKING_OFF_PATCH', undefined, () => completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'volcengine',
        baseUrl: 'https://ark.cn-beijing.volces.com',
        model: 'doubao-seed',
      }),
      fetchImpl,
    }))
    assert.equal(text, '豆包全文')
    assert.equal(requests[0].url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    assert.equal(requests[0].body.stream, true)
    assert.equal(requests[0].body.max_tokens, NOVEL_MAX_TOKENS)
    assert.equal(requests[0].body.reasoning_effort, 'none')
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' })
  })

  test('retries a 524 once and then returns the streamed text', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 524, body: '<html>error 524</html>' },
      { body: chatStream(['第二次', '写完']) },
    ])
    const { result, timeouts } = await withTimeoutSpy(() => (
      completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    ))
    assert.equal(result, '第二次写完')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].body.stream, true)
    assert.deepEqual(timeouts, [600_000, 600_000])
  })

  test('stops after a second 524', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 524, body: '<html>error 524</html>' },
      { status: 524, body: '<html>error 524</html>' },
      { body: chatStream(['不该再请求']) },
    ])
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl }),
      /小说章节生成失败（524）/,
    )
    assert.equal(requests.length, 2)
  })

  test('retries an empty or whitespace stream once', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { body: sse([chatDelta({ role: 'assistant' }), chatDelta({ content: ' \n ' })]) },
      { body: sse([chatDelta({ content: '补上了' })]) },
    ])
    const text = await completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    assert.equal(text, '补上了')
    assert.equal(requests.length, 2)
  })

  test('stops when the retry is still empty', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { body: sse([chatDelta({ content: '' })]) },
      { body: '{"choices":[{"message":{"content":""}}]}' },
    ])
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl }),
      /小说章节没有写出来/,
    )
    assert.equal(requests.length, 2)
  })

  test('retries a 524 carried inside a 200 stream payload', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { body: sse([{ error: { message: 'timeout', code: 524 } }]) },
      { body: sse([chatDelta({ content: '流里恢复' })]) },
    ])
    const text = await completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    assert.equal(text, '流里恢复')
    assert.equal(requests.length, 2)
  })

  test('does not retry auth, overload, malformed JSON, or an aborted request', async () => {
    const unauthorized = scriptedFetch([{ status: 401, body: '{"error":{"message":"bad key"}}' }])
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl: unauthorized.fetchImpl }),
      /小说章节生成失败（401）/,
    )
    assert.equal(unauthorized.requests.length, 1)

    const overloaded = scriptedFetch([{ status: 500, body: '{"error":{"message":"overloaded"}}' }])
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl: overloaded.fetchImpl }),
      /小说章节生成失败（500）/,
    )
    assert.equal(overloaded.requests.length, 1)

    const malformed = scriptedFetch([{ body: '<html>not json</html>' }])
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl: malformed.fetchImpl }),
      { message: '小说章节生成失败' },
    )
    assert.equal(malformed.requests.length, 1)

    let abortedCalls = 0
    const fetchImpl = (async () => {
      abortedCalls += 1
      throw new DOMException('The operation was aborted', 'TimeoutError')
    }) as typeof fetch
    await assert.rejects(
      () => completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    )
    assert.equal(abortedCalls, 1)
  })

  test('thinking-off can be disabled without turning streaming off', async () => {
    const { fetchImpl, requests } = scriptedFetch([{ body: sse([chatDelta({ content: '没关思考字段' })]) }])
    const text = await withEnv('AI_DISABLE_THINKING', 'false', () => (
      completeNovelPrompt(PROMPT, { config: textConfig(), fetchImpl })
    ))
    assert.equal(text, '没关思考字段')
    assert.equal(requests[0].body.stream, true)
    assert.equal(requests[0].body.thinking, undefined)
    assert.equal(requests[0].body.enable_thinking, undefined)
    assert.equal(requests[0].body.reasoning_effort, undefined)
  })

  test('gemini stream skips thoughts and keeps generation limits', async () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '想', thought: true }, { text: '故事' }] } }] })}`,
      '',
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '继续' }] } }] })}`,
      '',
    ].join('\n')
    const { fetchImpl, requests } = scriptedFetch([{ body }])
    const text = await withEnv('AI_THINKING_OFF_PATCH', undefined, () => completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'gemini',
        baseUrl: 'https://gemini.example',
        model: 'gemini-2.0-flash',
      }),
      fetchImpl,
    }))
    assert.equal(text, '故事继续')
    assert.equal(requests[0].url, 'https://gemini.example/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
    assert.equal(requests[0].init.headers['x-goog-api-key'], 'test-key')
    assert.equal(requests[0].init.headers.Authorization, undefined)
    assert.equal(requests[0].body.generationConfig.temperature, 0.4)
    assert.equal(requests[0].body.generationConfig.maxOutputTokens, NOVEL_MAX_TOKENS)
    assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: false })
    assert.equal(requests[0].body.reasoning_effort, undefined)
  })

  test('gemini 3 uses thinkingLevel low on the stream request', async () => {
    const { fetchImpl, requests } = scriptedFetch([{
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '三' }] } }] }),
    }])
    const text = await completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'gemini',
        baseUrl: 'https://gemini.example',
        model: 'gemini-3-pro',
      }),
      fetchImpl,
    })
    assert.equal(text, '三')
    assert.match(requests[0].url, /gemini-3-pro:streamGenerateContent\?alt=sse$/)
    assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' })
  })

  test('official gemini streams without the thinking patch', async () => {
    const { fetchImpl, requests } = scriptedFetch([{
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '官方', thought: true }, { text: '正文' }] } }] }),
    }])
    const text = await completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash',
        temperature: null,
      }),
      fetchImpl,
    })
    assert.equal(text, '正文')
    assert.equal(
      requests[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    )
    assert.equal(requests[0].body.generationConfig.temperature, 0.7)
    assert.equal(requests[0].body.generationConfig.maxOutputTokens, NOVEL_MAX_TOKENS)
    assert.equal(requests[0].body.generationConfig.thinkingConfig, undefined)
  })

  test('gemini falls back to generateContent when streaming is missing', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 404, body: '{"error":{"code":404,"message":"not found"}}' },
      { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '原生全文' }] } }] }) },
    ])
    const { result, timeouts } = await withTimeoutSpy(() => completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'gemini',
        baseUrl: 'https://gemini.example',
        model: 'gemini-2.0-flash',
      }),
      fetchImpl,
    }))
    assert.equal(result, '原生全文')
    assert.equal(requests.length, 2)
    assert.match(requests[0].url, /:streamGenerateContent\?alt=sse$/)
    assert.equal(requests[1].url, 'https://gemini.example/v1beta/models/gemini-2.0-flash:generateContent')
    assert.equal(requests[1].body.generationConfig.maxOutputTokens, NOVEL_MAX_TOKENS)
    assert.deepEqual(timeouts, [600_000])
  })

  test('gemini retries 524 on the stream endpoint', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 524, body: '<html>error 524</html>' },
      { body: sse([{ candidates: [{ content: { parts: [{ text: '再写' }] } }] }]) },
    ])
    const text = await completeNovelPrompt(PROMPT, {
      config: textConfig({
        provider: 'gemini',
        baseUrl: 'https://gemini.example',
        model: 'gemini-2.0-flash',
      }),
      fetchImpl,
    })
    assert.equal(text, '再写')
    assert.equal(requests.length, 2)
    assert.match(requests[0].url, /:streamGenerateContent/)
    assert.match(requests[1].url, /:streamGenerateContent/)
  })
})
