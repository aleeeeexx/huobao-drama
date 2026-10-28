import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageGatewayError, isRetryableImageGatewayStatus } from '../src/services/image-gateway.ts'
import { assembleStillPrompt } from '../src/services/rpg/turn.ts'
import {
  applyReferenceMarkers,
  buildStillReferences,
  PLAY_STILL_REFERENCE_LIMIT,
  prioritizeStillReferences,
  decideAssetEnqueue,
  isAssetReferenceTask,
  mentionedByName,
  PLAY_REFERENCE_WAIT_MS,
  PLAY_STILL_PROMPT_MARK,
  reuseExistingStill,
  selectPlayCharacters,
  selectPlayProps,
  STILL_REFERENCE_LIMIT,
  stillPromptCharacters,
} from '../src/services/rpg/references.ts'

const characters = [
  { id: 1, name: '林', appearance: '短发', role: '路人' },
  { id: 2, name: '林小雨', appearance: '青衫', role: '茶客', styling: '发髻' },
  { id: 3, name: '老板娘', appearance: '四十岁', role: '店主' },
  { id: 4, name: '说书人', appearance: '瘦高', role: '说书' },
]

test('named characters in the prose are the still cast, not whoever was extracted first', () => {
  const narrative = '老板娘把茶盏推向林小雨，灯花跳了一下。'
  const picked = selectPlayCharacters(characters, narrative, [1, 2, 3, 4])
  assert.deepEqual(picked.map(item => item.name), ['林小雨', '老板娘'])
  const prompts = stillPromptCharacters(picked, [
    { name: '林小雨', appearance: '青衫，发髻', role: '茶客' },
    { name: '老板娘', appearance: '四十岁，青衫', role: '店主' },
  ])
  assert.equal(prompts[0].appearance, '青衫，发髻')
  assert.equal(prompts[1].name, '老板娘')
})

test('a shorter name does not steal a longer name inside it', () => {
  const mentioned = mentionedByName(characters, '林小雨放下茶盏')
  assert.deepEqual(mentioned.map(item => item.name), ['林小雨'])
  const separate = mentionedByName(characters, '林在门外，林小雨在柜台里')
  assert.deepEqual(separate.map(item => item.name), ['林', '林小雨'])
})

test('props ride along only when the prose or the storyboard names them', () => {
  const props = [
    { id: 8, name: '茶券' },
    { id: 9, name: '灯笼' },
  ]
  assert.deepEqual(selectPlayProps(props, '你推开了门。').map(item => item.name), [])
  assert.deepEqual(selectPlayProps(props, '你捏着茶券。').map(item => item.name), ['茶券'])
  assert.deepEqual(selectPlayProps(props, '你推开了门。', [9]).map(item => item.name), ['灯笼'])
})

test('reference images stay in studio order and skip plates that are not ready', () => {
  const refs = buildStillReferences({
    scene: { name: '雾隐茶寮', imageUrl: 'static/images/scene.png' },
    characters: [
      { name: '老板娘', imageUrl: 'static/images/host.png' },
      { name: '说书人', imageUrl: '' },
    ],
    props: [{ name: '茶券', imageUrl: 'static/images/scene.png' }],
    limit: STILL_REFERENCE_LIMIT,
  })
  assert.deepEqual(refs.map(item => item.name), ['雾隐茶寮', '老板娘'])
  assert.equal(refs[0].kind, 'scene')
  assert.equal(refs[1].kind, 'character')

  const prompt = assembleStillPrompt({
    stylePrompt: '真人电影',
    sceneFinalPrompt: '空镜茶寮',
    location: '雾隐茶寮',
    time: '子时',
    scenePrompt: '灯笼',
    lighting: '冷青',
    characters: [{ name: '老板娘', appearance: '四十岁，青衫' }],
    narrative: '你推开了门。',
    references: refs,
  })
  assert.match(prompt, new RegExp(PLAY_STILL_PROMPT_MARK))
  assert.match(prompt, /参考图顺序：1\. 场景「雾隐茶寮」 2\. 角色「老板娘」/)
  assert.match(prompt, /保持同一张脸/)
  assert.match(prompt, /老板娘（四十岁，青衫）/)
  const plain = assembleStillPrompt({
    stylePrompt: '真人电影',
    sceneFinalPrompt: '空镜茶寮',
    location: '雾隐茶寮',
    time: '子时',
    scenePrompt: '灯笼',
    lighting: '冷青',
    characters: [{ name: '老板娘', appearance: '四十岁，青衫' }],
    narrative: '你推开了门。',
  })
  assert.doesNotMatch(plain, /参考图顺序/)
})

test('play stills keep the scene plate and the lead, not the first two unrelated refs', () => {
  const refs = prioritizeStillReferences({
    scene: { name: '雾隐茶寮', imageUrl: 'static/images/scene.png' },
    characters: [
      { name: '林', role: '路人', imageUrl: 'static/images/extra.png' },
      { name: '老板娘', role: '店主', imageUrl: 'static/images/host.png' },
      { name: '你', role: '主角', imageUrl: 'static/images/you.png' },
    ],
    props: [{ name: '半张茶券', imageUrl: 'static/images/ticket.png' }],
    limit: PLAY_STILL_REFERENCE_LIMIT,
  })
  assert.deepEqual(refs.map(item => item.name), ['雾隐茶寮', '你'])
  assert.equal(refs[0].kind, 'scene')
  assert.equal(refs[1].kind, 'character')

  const withoutScene = prioritizeStillReferences({
    characters: [
      { name: '林', role: '路人', imageUrl: 'static/images/extra.png' },
      { name: '老板娘', role: '店主', imageUrl: 'static/images/host.png' },
      { name: '你', role: '主角', imageUrl: 'static/images/you.png' },
    ],
    props: [{ name: '半张茶券', imageUrl: 'static/images/ticket.png' }],
  })
  assert.deepEqual(withoutScene.map(item => item.name), ['你', '老板娘'])
  assert.equal(PLAY_STILL_REFERENCE_LIMIT, 2)
})

test('video prompts tag @names with the same reference index as the studio', () => {
  const refs = buildStillReferences({
    scene: { name: '雾隐茶寮', imageUrl: 'static/images/scene.png' },
    characters: [{ name: '林小雨', imageUrl: 'static/images/lin.png' }],
    extras: [{ kind: 'still', name: '', imageUrl: 'static/images/still.png' }],
    limit: 9,
  })
  const marked = applyReferenceMarkers('@雾隐茶寮 里 @林小雨 抬眼，@林 没有入画', refs)
  assert.equal(marked, '@图片1雾隐茶寮 里 @图片2林小雨 抬眼，@林 没有入画')
  assert.equal(refs[2].kind, 'still')
})

test('an existing reference image is not regenerated, and a failed plate is not retried in the background', () => {
  assert.equal(decideAssetEnqueue({
    hasImage: true,
    latestStatus: null,
    skipIfPresent: true,
    retryFailed: true,
  }), 'use-existing')
  assert.equal(decideAssetEnqueue({
    hasImage: false,
    latestStatus: 'processing',
    skipIfPresent: true,
    retryFailed: true,
  }), 'reuse-task')
  assert.equal(decideAssetEnqueue({
    hasImage: false,
    latestStatus: 'failed',
    skipIfPresent: true,
    retryFailed: false,
  }), 'skip-failed')
  assert.equal(decideAssetEnqueue({
    hasImage: false,
    latestStatus: 'failed',
    skipIfPresent: true,
    retryFailed: true,
  }), 'enqueue')
  assert.equal(decideAssetEnqueue({
    hasImage: true,
    latestStatus: 'completed',
    skipIfPresent: false,
    retryFailed: false,
  }), 'enqueue')
  assert.equal(isAssetReferenceTask({
    frameType: 'play_still',
    sceneId: 4,
    prompt: `${PLAY_STILL_PROMPT_MARK}，雨夜`,
  }), false)
  assert.equal(isAssetReferenceTask({ frameType: 'asset_reference', sceneId: 4 }), true)
  assert.equal(isAssetReferenceTask({
    sceneId: 4,
    prompt: `${PLAY_STILL_PROMPT_MARK}，旧剧情图`,
  }), false)
})

test('image edits gateway failures stay visible instead of looking successful', () => {
  assert.equal(isRetryableImageGatewayStatus(502), true)
  assert.equal(isRetryableImageGatewayStatus(503), true)
  assert.equal(isRetryableImageGatewayStatus(504), true)
  assert.equal(isRetryableImageGatewayStatus(400), false)
  assert.equal(imageGatewayError(502), '图片服务暂时不可用（HTTP 502），请稍后再试')

  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
  const submit = generation.slice(
    generation.indexOf('let resp = await postProvider'),
    generation.indexOf('const result = await resp.json()'),
  )
  assert.match(submit, /type === 'image' && isRetryableImageGatewayStatus/)
  assert.match(submit, /throw new Error\(imageGatewayError\(resp\.status\)\)/)
  assert.match(submit, /adapter\.buildGenerateRequest/)
})

test('redraw starts a new still, while an in-flight still keeps its task', () => {
  assert.equal(reuseExistingStill('processing', true), true)
  assert.equal(reuseExistingStill('processing', false), true)
  assert.equal(reuseExistingStill('completed', false), true)
  assert.equal(reuseExistingStill('completed', true), false)
  assert.equal(reuseExistingStill('failed', true), false)
  assert.equal(reuseExistingStill(null, true), false)
})

test('play stills borrow studio plates and do not write the composed frame back onto the scene', () => {
  const engine = readFileSync(new URL('../src/services/rpg/engine.ts', import.meta.url), 'utf8')
  const illustrate = engine.slice(
    engine.indexOf('export async function illustrateSession'),
    engine.indexOf('export async function filmSession'),
  )
  const film = engine.slice(
    engine.indexOf('export async function filmSession'),
    engine.indexOf('async function commitScreenplay'),
  )
  assert.match(engine, /await syncAssets\([\s\S]*?scheduleEpisodeAssetImages/)
  assert.match(illustrate, /reuseExistingStill\(task\.status, !!options\?\.force\)/)
  assert.doesNotMatch(illustrate, /task\?\.status === 'processing' \|\| task\?\.status === 'completed'/)
  assert.match(illustrate, /resolveAssetReferenceImage|platesForTurn/)
  assert.match(illustrate, /frameType: PLAY_STILL_FRAME/)
  assert.match(illustrate, /stillReferences/)
  assert.match(illustrate, /referenceImages/)
  const stillCall = illustrate.slice(
    illustrate.indexOf('const taskId = await generateImage'),
    illustrate.indexOf('await db.update(schema.rpgTurns)'),
  )
  assert.match(stillCall, /referenceImages/)
  assert.doesNotMatch(stillCall, /sceneId/)
  assert.match(film, /referenceImageUrls/)
  assert.match(film, /applyReferenceMarkers/)
  assert.equal(PLAY_REFERENCE_WAIT_MS, 180_000)
})
