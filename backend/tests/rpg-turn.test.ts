import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NarrativeStreamParser,
  RPG_STATE_SENTINEL,
  buildSceneImagePrompt,
  emptyWorldState,
  formatScreenplayScene,
  parseStatePayload,
  resolvePlayerAction,
} from '../src/services/rpg/turn.ts'
import { OpenAIVideoAdapter } from '../src/services/adapters/openai-video.ts'

test('choice and free-text actions both resolve, and empty text does not', () => {
  const choices = [
    { id: 'c1', label: '推门进去', detail: '茶寮已经亮灯' },
    { id: 'c2', label: '先看那封信', detail: '信压在柜台上' },
  ]
  const choice = resolvePlayerAction({ mode: 'choice', choice_id: 'c2' }, choices, true)
  assert.equal(choice.ok, true)
  if (choice.ok) {
    assert.equal(choice.action.mode, 'choice')
    assert.equal(choice.action.text, '先看那封信')
  }
  const free = resolvePlayerAction({ mode: 'free', text: ' 我绕到茶寮后门敲三下 ' }, choices, true)
  assert.equal(free.ok, true)
  if (free.ok) {
    assert.equal(free.action.mode, 'free')
    assert.equal(free.action.text, '我绕到茶寮后门敲三下')
  }
  const empty = resolvePlayerAction({ mode: 'free', text: '   ' }, choices, true)
  assert.equal(empty.ok, false)
  const missing = resolvePlayerAction({ mode: 'choice', choice_id: 'nope' }, choices, true)
  assert.equal(missing.ok, false)
  const opening = resolvePlayerAction({ mode: 'opening' }, null, false)
  assert.equal(opening.ok, true)
  const lateOpening = resolvePlayerAction({ mode: 'opening' }, choices, true)
  assert.equal(lateOpening.ok, false)
})

test('stream parser hides the state sentinel even when it is split across chunks', () => {
  const parser = new NarrativeStreamParser()
  const marker = RPG_STATE_SENTINEL
  const first = parser.push('雨下得更大。' + marker.slice(0, 4))
  const second = parser.push(marker.slice(4) + '{"choices":[{"id":"c1","label":"推门","detail":"进去"},{"id":"c2","label":"看信","detail":"先不进门"}]}')
  assert.equal(first + second, '雨下得更大。')
  const finished = parser.finish()
  assert.equal(finished.narrative, '雨下得更大。')
  assert.match(finished.stateRaw, /choices/)
  const parsed = parseStatePayload(finished.stateRaw, emptyWorldState('雨'))
  assert.equal(parsed.choices[0].label, '推门')
})

test('missing state keeps the previous world and still offers choices', () => {
  const previous = emptyWorldState('旧设定')
  previous.scene.location = '茶寮'
  previous.items = [{ name: '茶券', holder: '你', description: '半张' }]
  const parsed = parseStatePayload('不是 json', previous)
  assert.equal(parsed.state.scene.location, '茶寮')
  assert.equal(parsed.state.items[0].name, '茶券')
  assert.equal(parsed.choices.length, 3)
})

test('screenplay and image prompt carry the current scene', () => {
  const state = emptyWorldState()
  state.scene = { location: '雾隐茶寮', time: '子时', summary: '灯笼在雨里摇', atmosphere: '冷青' }
  const screenplay = formatScreenplayScene(2, state, '你推开了门。', '推门进去')
  assert.match(screenplay, /## S2 \| 内景 · 雾隐茶寮 \| 子时/)
  assert.match(screenplay, /推门进去/)
  const prompt = buildSceneImagePrompt(state, 'noir ink')
  assert.match(prompt, /雾隐茶寮/)
  assert.match(prompt, /noir ink/)
})

test('grok video adapter reads request_id and done url', () => {
  const adapter = new OpenAIVideoAdapter()
  const created = adapter.parseGenerateResponse({ request_id: 'abc' })
  assert.equal(created.isAsync, true)
  assert.equal(created.taskId, 'abc')
  const pending = adapter.parsePollResponse({ status: 'pending' })
  assert.equal(pending.status, 'processing')
  const done = adapter.parsePollResponse({ status: 'done', video: { url: 'https://example.com/a.mp4', duration: 6 } })
  assert.equal(done.status, 'completed')
  assert.equal(done.videoUrl, 'https://example.com/a.mp4')
  const content = adapter.resolveDownload(
    { provider: 'openai', baseUrl: 'https://codecc.cc', apiKey: 'test-key', model: 'grok-imagine-video-1.5' },
    '/v1/videos/abc/content',
  )
  assert.equal(content.url, 'https://codecc.cc/v1/videos/abc/content')
  assert.equal(content.headers?.Authorization, 'Bearer test-key')
  const failed = adapter.parsePollResponse({ status: 'failed', error: 'nope' })
  assert.equal(failed.status, 'failed')
  const request = adapter.buildGenerateRequest(
    { provider: 'openai', baseUrl: 'https://codecc.cc', apiKey: 'test', model: 'grok-imagine-video-1.5' },
    { id: 1, model: 'grok-imagine-video-1.5', prompt: '雨', duration: 6, aspectRatio: '16:9', resolution: '720p' },
  )
  assert.match(request.url, /\/v1\/videos\/generations$/)
  assert.equal(request.body.duration, 6)
})
