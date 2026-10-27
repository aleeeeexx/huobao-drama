import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NarrativeStreamParser,
  RPG_STATE_SENTINEL,
  assembleStillPrompt,
  buildPlayRewriteMessage,
  buildPlayStoryboardMessage,
  choicesFromPayload,
  emptyWorldState,
  formatScreenplayScene,
  locationFromNarrativeHeader,
  narrativeFromScreenplay,
  projectWorldState,
  resolvePlayerAction,
  stripChoiceTail,
  stripPipelineMeta,
  visibleNarrative,
} from '../src/services/rpg/turn.ts'
import { OpenAIVideoAdapter } from '../src/services/adapters/openai-video.ts'
import { LIVE_ACTION_CINEMATIC_STYLE } from '../src/services/live-action-cinematic.ts'
import { PRESET_WORLDS } from '../src/services/rpg/worlds.ts'
import { stylePresetSeeds } from '../src/db/sqlite-schema.ts'
import { prefixVideoStyle } from '../src/services/style-prompt.ts'

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
  const choices = choicesFromPayload(finished.stateRaw)
  assert.equal(choices[0].label, '推门')
})

test('dossier comes from studio assets, not a narrator state blob', () => {
  const previous = emptyWorldState('旧设定')
  previous.scene.location = '茶寮'
  previous.items = [{ name: '茶券', holder: '你', description: '半张' }]
  previous.quests = [{ title: '找到搭档', status: 'active', detail: '茶券还在' }]
  const choices = choicesFromPayload('不是 json')
  assert.equal(choices.length, 3)
  const kept = projectWorldState(previous, { characters: [], scenes: [], props: [] })
  assert.equal(kept.state.scene.location, '茶寮')
  assert.equal(kept.state.items[0].name, '茶券')
  assert.equal(kept.state.quests[0].title, '找到搭档')
  const raw = JSON.stringify({
    choices: [{ id: 'c1', label: '推门', detail: '进去' }, { id: 'c2', label: '看信', detail: '先不进' }],
    characters: [{ name: '说书人捏造', role: '无', status: '无', appearance: '无' }],
  })
  assert.equal(choicesFromPayload(raw)[0].label, '推门')
  const projected = projectWorldState(previous, {
    characters: [{ name: '老板娘', role: '茶寮主人', description: '在柜台后', appearance: '四十岁，青衫', styling: '发髻' }],
    scenes: [{ id: 7, location: '雾隐茶寮', time: '子时', prompt: '灯笼在雨里摇', lighting: '冷青', updatedAt: '2026-01-01' }],
    props: [{ name: '茶券', type: '信物', description: '半张，写着你的名字' }],
  }, 7)
  assert.equal(projected.sceneId, 7)
  assert.equal(projected.state.scene.location, '雾隐茶寮')
  assert.equal(projected.state.characters[0].name, '老板娘')
  assert.match(projected.state.characters[0].appearance, /发髻/)
  assert.equal(projected.state.characters.some(item => item.name === '说书人捏造'), false)
  assert.equal(projected.state.items[0].holder, '信物')
  assert.equal(projected.state.quests[0].title, '找到搭档')
})

test('player narrative strips agent pipeline preambles and keeps the story', () => {
  const act2 = '第2幕先落进剧本，再把给玩家看的正文补上。\n\n雨点砸在青瓦上，你还站在茶寮门外。'
  const act3 = [
    '我先读取本集已有正文，再按你选的走向续写第3幕并保存剧本。',
    '残字已经对上，我先把这一幕写入剧本，再把给你看的正文补上。',
    '你翻开杯底那半张纸，墨迹在灯下对上了。',
  ].join('')
  assert.equal(stripPipelineMeta(act2), '雨点砸在青瓦上，你还站在茶寮门外。')
  assert.equal(stripPipelineMeta(act3), '你翻开杯底那半张纸，墨迹在灯下对上了。')
  assert.equal(visibleNarrative(act3), stripPipelineMeta(act3))
  assert.equal(visibleNarrative(visibleNarrative(act3)), visibleNarrative(act3))
  const between = '你推开门。\n\n我先把这一幕写入剧本。\n\n灯还亮着。'
  assert.equal(stripPipelineMeta(between), '你推开门。\n\n灯还亮着。')
  assert.equal(stripPipelineMeta('你在灯下把那句残字写入纸页。'), '你在灯下把那句残字写入纸页。')
  assert.equal(stripPipelineMeta('这封信是写给你看的。'), '这封信是写给你看的。')
  assert.equal(stripPipelineMeta('你再把名字写入剧本。'), '你再把名字写入剧本。')
  assert.equal(stripPipelineMeta('你写下要先看那封信，于是把茶盏翻了过来。'), '你写下要先看那封信，于是把茶盏翻了过来。')
  assert.equal(stripPipelineMeta('我先读取告示上的名字。'), '我先读取告示上的名字。')
  assert.equal(stripPipelineMeta('他调用维修工具，气闸开了一条缝。'), '他调用维修工具，气闸开了一条缝。')

  const parser = new NarrativeStreamParser()
  const preamble = '我先读取本集已有正文，再按你选的走向续写第3幕并保存剧本。残字已经对上，我先把这一幕写入剧本，再把给你看的正文补上。'
  const story = '你翻开杯底那半张纸，墨迹在灯下对上了。灯花爆了一下。'
  const choicesJson = '{"choices":[{"id":"c1","label":"翻开杯底那半张纸","detail":"对残字"},{"id":"c2","label":"先问掌柜","detail":"别打草惊蛇"},{"id":"c3","label":"把纸按回去","detail":"先不声张"}]}'
  let live = ''
  live += parser.push(preamble.slice(0, 8))
  live += parser.push(preamble.slice(8, 24))
  live += parser.push(preamble.slice(24) + story.slice(0, 5))
  live += parser.push(story.slice(5) + RPG_STATE_SENTINEL + choicesJson)
  const finished = parser.finish()
  live += finished.tail
  assert.equal(live, story)
  assert.equal(finished.narrative, story)
  assert.doesNotMatch(live, /读取本集|写入剧本|落进剧本|补上正文|给玩家看的正文|save_script/)
  assert.equal(choicesFromPayload(finished.stateRaw)[0].label, '翻开杯底那半张纸')
  assert.equal(choicesFromPayload(finished.stateRaw)[2].label, '把纸按回去')

  const state = emptyWorldState()
  state.scene = { location: '雾隐茶寮', time: '子时', summary: '', atmosphere: '' }
  const screenplay = formatScreenplayScene(2, state, act2, '推门进去')
  assert.equal(narrativeFromScreenplay(screenplay, 2), '雨点砸在青瓦上，你还站在茶寮门外。')
  assert.deepEqual(
    locationFromNarrativeHeader(`我先把这一幕写入剧本。\n## S3 | 内景 · 茶寮 | 夜\n你掀开杯子。`),
    { location: '茶寮', time: '夜' },
  )

  const salvaged = new NarrativeStreamParser()
  const looseStory = '你在门口站了很久，雨把肩头打湿，茶香从门缝里渗出来。'
  const looseJson = '{"choices":[{"id":"c1","label":"推门","detail":"进去"},{"id":"c2","label":"看信","detail":"先不进门"}]}'
  const looseLive = salvaged.push(`我先读取本集已有正文，再保存剧本。${looseStory}${looseJson}`)
  const looseFinished = salvaged.finish()
  assert.equal(`${looseLive}${looseFinished.tail}`, looseStory)
  assert.equal(looseFinished.narrative, looseStory)
  assert.equal(choicesFromPayload(looseFinished.stateRaw)[0].label, '推门')
  assert.equal(choicesFromPayload(looseFinished.stateRaw)[1].label, '看信')
})

test('screenplay scene can be read back as the player narrative', () => {
  const state = emptyWorldState()
  state.scene = { location: '雾隐茶寮', time: '子时', summary: '灯笼在雨里摇', atmosphere: '冷青' }
  const screenplay = formatScreenplayScene(2, state, '你推开了门。', '推门进去')
  assert.match(screenplay, /## S2 \| 内景 · 雾隐茶寮 \| 子时/)
  assert.match(screenplay, /推门进去/)
  const script = `${screenplay}\n${RPG_STATE_SENTINEL}\n{"choices":[]}`
  assert.equal(narrativeFromScreenplay(stripChoiceTail(script), 2), '你推开了门。')
  assert.deepEqual(locationFromNarrativeHeader(screenplay), { location: '雾隐茶寮', time: '子时' })
  assert.equal(locationFromNarrativeHeader('你推开了门。'), null)
})

test('play still and video prompts keep the live-action cinema style', () => {
  const image = assembleStillPrompt({
    stylePrompt: LIVE_ACTION_CINEMATIC_STYLE.prompt,
    sceneFinalPrompt: '',
    location: '雾隐茶寮',
    time: '子时',
    scenePrompt: '灯笼在雨里摇',
    lighting: '冷青',
    characters: [{ name: '老板娘', appearance: '四十岁，青衫，发髻', role: '茶寮主人' }],
    narrative: '你推开了门。',
  })
  const video = prefixVideoStyle(LIVE_ACTION_CINEMATIC_STYLE.prompt, '分镜视频提示词由 prompt_generator 写入')
  for (const prompt of [image, video]) {
    assert.match(prompt, /真人电影/)
    assert.match(prompt, /photorealistic live-action cinema/)
    assert.match(prompt, /real human actors/)
    assert.match(prompt, /shallow depth of field/)
    assert.match(prompt, /naturalistic color grade/)
    assert.match(prompt, /live-action movie visual effects/)
    assert.match(prompt, /avoid anime/)
    assert.match(prompt, /avoid 二次元/)
    assert.match(prompt, /avoid cartoon/)
    assert.match(prompt, /avoid illustration/)
    assert.match(prompt, /avoid comic/)
    assert.match(prompt, /avoid painterly fantasy art/)
  }
  assert.match(image, /老板娘/)
  assert.match(image, /雾隐茶寮/)
  assert.match(image, /冷青/)
  assert.match(image, /不要插画/)
  assert.doesNotMatch(image, /电影感插画/)
  assert.equal(image.startsWith(LIVE_ACTION_CINEMATIC_STYLE.prompt), true)
  assert.equal(video.startsWith(LIVE_ACTION_CINEMATIC_STYLE.prompt), true)
  const alreadyStyled = assembleStillPrompt({
    stylePrompt: LIVE_ACTION_CINEMATIC_STYLE.prompt,
    sceneFinalPrompt: `${LIVE_ACTION_CINEMATIC_STYLE.prompt}，\n空镜茶寮`,
    location: '雾隐茶寮',
    time: '子时',
    scenePrompt: '灯笼',
    lighting: '冷青',
    characters: [],
    narrative: '你推开了门。',
  })
  assert.equal(alreadyStyled.indexOf(LIVE_ACTION_CINEMATIC_STYLE.prompt), 0)
  assert.equal(alreadyStyled.indexOf(LIVE_ACTION_CINEMATIC_STYLE.prompt, 1), -1)

  const preset = stylePresetSeeds.find(item => item.value === LIVE_ACTION_CINEMATIC_STYLE.value)
  assert.equal(preset?.name, '真人电影')
  assert.equal(preset?.prompt, LIVE_ACTION_CINEMATIC_STYLE.prompt)
  assert.ok(stylePresetSeeds.some(item => item.value === '3d' && item.prompt.includes('avoid 2D flat cel shading')))
  assert.ok(stylePresetSeeds.some(item => item.value === 'anime' && item.prompt.includes('avoid photorealism')))
  assert.equal(PRESET_WORLDS.every(world => world.style === LIVE_ACTION_CINEMATIC_STYLE.value), true)

  const rewrite = buildPlayRewriteMessage({
    worldTitle: '雾隐茶寮',
    genre: '悬疑',
    premise: '雨夜的茶寮。',
    actionLine: '玩家选择了剧情走向：「推门进去」',
    turnIndex: 2,
    existingScript: '## S1 | 外景 · 巷口 | 夜',
    recent: '第1幕\n你站在门外。',
  })
  assert.match(rewrite, /read_episode_script/)
  assert.match(rewrite, /save_script/)
  assert.match(rewrite, /script_rewriter|剧本改写/)
  assert.match(rewrite, /从故事的第一句写起/)
  assert.match(rewrite, /不要输出任何文字/)
  assert.doesNotMatch(rewrite, /chat\/completions/)
  const storyboard = buildPlayStoryboardMessage({
    turnIndex: 2,
    narrative: '你推开了门。',
    screenplay: '## S2 | 内景 · 雾隐茶寮 | 子时',
    videoLabel: 'codecc (openai)',
    characters: [{ id: 3, name: '老板娘' }],
    scenes: [{ id: 7, location: '雾隐茶寮', time: '子时' }],
    props: [],
  })
  assert.match(storyboard, /shot_number 必须是 2/)
  assert.match(storyboard, /不要把 replace_existing 设为 true/)
  assert.match(storyboard, /老板娘\(ID:3\)/)
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
