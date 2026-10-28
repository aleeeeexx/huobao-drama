import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrsaiVideoAdapter } from '../src/services/adapters/grsai-video.ts'
import { getVideoAdapter } from '../src/services/adapters/registry.ts'
import { isOfficialProvider } from '../src/services/ai.ts'

const config = {
  provider: 'grsai',
  baseUrl: 'https://grsaiapi.com',
  apiKey: 'grsai-test-key',
  model: 'minimax-h3',
}

const adapter = new GrsaiVideoAdapter()

function requestBody(record: Record<string, unknown> = {}) {
  return adapter.buildGenerateRequest(config, { id: 1, prompt: '雨夜街头', ...record }).body
}

test('grsai video provider is registered without replacing codecc or native minimax', () => {
  assert.equal(getVideoAdapter('grsai').provider, 'grsai')
  assert.equal(getVideoAdapter('GRSAI').provider, 'grsai')
  assert.equal(getVideoAdapter('openai').provider, 'openai')
  assert.equal(getVideoAdapter('minimax').provider, 'minimax')
  assert.equal(getVideoAdapter('aliyun').provider, 'aliyun')
  assert.equal(getVideoAdapter('volcengine').provider, 'volcengine')
  assert.equal(isOfficialProvider('video', 'grsai'), true)
  assert.equal(isOfficialProvider('video', 'openai'), true)
  assert.equal(isOfficialProvider('video', 'minimax'), true)
  assert.equal(isOfficialProvider('image', 'grsai'), false)
  assert.equal(isOfficialProvider('text', 'grsai'), false)
})

test('generate request posts the MiniMax H3 async body to /v1/api/generate', () => {
  const request = adapter.buildGenerateRequest({
    ...config,
    baseUrl: 'https://grsaiapi.com///',
  }, {
    id: 7,
    prompt: '  雨夜街头  ',
    duration: 10,
    aspectRatio: '16:9',
    resolution: '720p',
    firstFrameUrl: 'https://cdn.example/first.png',
    imageUrl: 'https://cdn.example/ignored-when-first-frame-exists.png',
    lastFrameUrl: 'https://cdn.example/last.png',
    referenceImageUrls: JSON.stringify([
      'https://cdn.example/first.png',
      'https://cdn.example/ref.png',
      'data:image/png;base64,aaaa',
    ]),
    referenceAudioUrls: JSON.stringify(['https://cdn.example/voice.mp3']),
    seed: 1000,
  })

  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://grsaiapi.com/v1/api/generate')
  assert.equal(request.headers.Authorization, 'Bearer grsai-test-key')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.url.includes('grsai-test-key'), false)
  assert.deepEqual(request.body, {
    model: 'minimax-h3',
    prompt: '雨夜街头',
    aspectRatio: 'landscape',
    resolution: '768p',
    duration: 10,
    replyType: 'async',
    promptSkill: true,
    images: [
      'https://cdn.example/first.png',
      'https://cdn.example/last.png',
      'https://cdn.example/ref.png',
      'data:image/png;base64,aaaa',
    ],
    audios: ['https://cdn.example/voice.mp3'],
    seed: 1000,
  })
})

test('aspect ratio, resolution and duration follow the grsai limits', () => {
  assert.equal(requestBody({ aspectRatio: '9:16' }).aspectRatio, 'portrait')
  assert.equal(requestBody({ aspectRatio: '3:4' }).aspectRatio, 'portrait')
  assert.equal(requestBody({ aspectRatio: 'portrait' }).aspectRatio, 'portrait')
  assert.equal(requestBody({ aspectRatio: '16:9' }).aspectRatio, 'landscape')
  assert.equal(requestBody({ aspectRatio: '4:3' }).aspectRatio, 'landscape')
  assert.equal(requestBody({ aspectRatio: '1:1' }).aspectRatio, 'landscape')
  assert.equal(requestBody({ aspectRatio: 'adaptive' }).aspectRatio, 'landscape')
  assert.equal(requestBody({ aspectRatio: '' }).aspectRatio, 'landscape')
  assert.equal(requestBody({}).aspectRatio, 'landscape')

  assert.equal(requestBody({ resolution: '480p' }).resolution, '480p')
  assert.equal(requestBody({ resolution: '720p' }).resolution, '768p')
  assert.equal(requestBody({ resolution: '768P' }).resolution, '768p')
  assert.equal(requestBody({ resolution: '1080p' }).resolution, '1080p')
  assert.equal(requestBody({ resolution: '2K' }).resolution, '1080p')
  assert.equal(requestBody({ resolution: 'nope' }).resolution, '768p')
  assert.equal(requestBody({}).resolution, '768p')

  assert.equal(requestBody({ duration: 0, resolution: '480p' }).duration, 1)
  assert.equal(requestBody({ duration: 20, resolution: '768p' }).duration, 15)
  assert.equal(requestBody({ duration: 15, resolution: '1080p' }).duration, 10)
  assert.equal(requestBody({ duration: 10, resolution: '1080p' }).duration, 10)
  assert.equal(requestBody({ duration: 6.6, resolution: '720p' }).duration, 7)
  assert.equal(requestBody({ duration: null }).duration, 5)
  assert.equal(requestBody({ duration: Number.NaN, resolution: '2K' }).duration, 5)
})

test('optional fields stay off the body unless the studio actually set them', () => {
  const body = requestBody({
    imageUrl: 'https://cdn.example/still.png',
    referenceImageUrls: null,
    referenceAudioUrls: '[]',
    promptExtend: 0,
    seed: null,
  })
  assert.deepEqual(body.images, ['https://cdn.example/still.png'])
  assert.equal('audios' in body, false)
  assert.equal('seed' in body, false)
  assert.equal(body.promptSkill, false)
  assert.equal(requestBody({ promptExtend: false }).promptSkill, false)
  assert.equal(requestBody({ promptExtend: true }).promptSkill, true)
  assert.equal(requestBody({ seed: 0 }).seed, 0)

  const bare = adapter.buildGenerateRequest({ ...config, model: '' }, { id: 2, prompt: '只写提示词', model: '  ' })
  assert.equal(bare.body.model, 'minimax-h3')
  assert.equal('images' in bare.body, false)
})

test('base URL that already contains /v1 is not prefixed twice', () => {
  const request = adapter.buildGenerateRequest({
    ...config,
    baseUrl: 'https://grsai.dakka.com.cn/v1/',
  }, { id: 3, prompt: '国内节点' })
  assert.equal(request.url, 'https://grsai.dakka.com.cn/v1/api/generate')
  const poll = adapter.buildPollRequest({
    ...config,
    baseUrl: 'https://grsai.dakka.com.cn/v1/',
  }, 'task/1')
  assert.equal(poll.url, 'https://grsai.dakka.com.cn/v1/api/result?id=task%2F1')
})

test('too many images or audios, and a missing prompt, are rejected before the request', () => {
  const images = Array.from({ length: 10 }, (_, index) => `https://cdn.example/${index}.png`)
  assert.throws(
    () => requestBody({ referenceImageUrls: JSON.stringify(images) }),
    /参考图片超限/,
  )
  const audios = ['https://cdn.example/a.mp3', 'https://cdn.example/b.mp3', 'https://cdn.example/c.mp3', 'https://cdn.example/d.mp3']
  assert.throws(
    () => requestBody({ referenceAudioUrls: JSON.stringify(audios) }),
    /参考音频超限/,
  )
  assert.throws(() => adapter.buildGenerateRequest(config, { id: 4, prompt: '   ' }), /需要提示词/)
})

test('submit parses an async id and a synchronous succeeded url', () => {
  assert.deepEqual(adapter.parseGenerateResponse({
    id: '14-5f3cf761-a4bb-486a-8016-77f490998f80',
    status: 'running',
    progress: 0,
  }), {
    isAsync: true,
    taskId: '14-5f3cf761-a4bb-486a-8016-77f490998f80',
  })
  assert.deepEqual(adapter.parseGenerateResponse({
    id: 'sync-task',
    status: 'succeeded',
    results: [{ url: 'https://file.example/clip.mp4' }],
  }), {
    isAsync: false,
    taskId: 'sync-task',
    videoUrl: 'https://file.example/clip.mp4',
  })
  assert.throws(
    () => adapter.parseGenerateResponse({ status: 'violation', error: 'unsafe' }),
    /内容审核未通过：unsafe/,
  )
  assert.throws(
    () => adapter.parseGenerateResponse({ status: 'failed', error: { message: 'busy' } }),
    /busy/,
  )
  assert.throws(() => adapter.parseGenerateResponse({ status: 'running' }), /没有返回任务 id/)
})

test('poll uses GET /v1/api/result and maps grsai statuses', () => {
  const poll = adapter.buildPollRequest(config, '14-5f3cf761-a4bb-486a-8016-77f490998f80')
  assert.equal(poll.method, 'GET')
  assert.equal(poll.body, undefined)
  assert.equal(poll.headers.Authorization, 'Bearer grsai-test-key')
  assert.equal(
    poll.url,
    'https://grsaiapi.com/v1/api/result?id=14-5f3cf761-a4bb-486a-8016-77f490998f80',
  )

  const videoUrl = 'https://file.example/clip.mp4'
  assert.deepEqual(adapter.parsePollResponse({
    id: 'task',
    status: 'succeeded',
    results: [{ url: videoUrl }],
  }), { status: 'completed', videoUrl })
  assert.deepEqual(adapter.parsePollResponse({ status: 'running', progress: 40 }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'succeeded', results: [] }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'failed' }), { status: 'failed', error: '视频生成失败' })
  assert.deepEqual(
    adapter.parsePollResponse({ status: 'violation' }),
    { status: 'failed', error: '内容审核未通过' },
  )
  assert.equal(adapter.extractVideoUrl({ results: [{ url: '  https://file.example/clip.mp4  ' }] }), videoUrl)
  assert.equal(adapter.extractVideoUrl({ url: videoUrl }), null)
})
