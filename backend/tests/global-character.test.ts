import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fallbackWorldPlayerCharacterDraft,
  generateGlobalCharacterDraft,
  generateWorldPlayerCharacterDraft,
} from '../src/services/global-character.ts'

test('global character generation returns an editable draft and bounds fields', async () => {
  let prompt = ''
  const draft = await generateGlobalCharacterDraft('一个会修钟表的年轻侦探', async (value, options) => {
    prompt = value
    assert.equal(options?.timeoutMs, 45_000)
    return JSON.stringify({
      name: '沈知遥',
      role: '钟表匠兼侦探',
      appearance: '银灰色短发',
      physique: '清瘦',
      default_personality: '敏锐而克制',
      default_styling: '深绿色短外套',
    })
  })
  assert.match(prompt, /不同世界复用/)
  assert.equal(draft.name, '沈知遥')
  assert.equal(draft.default_personality, '敏锐而克制')
  assert.equal(draft.image_url, null)
})

test('global character generation requires a usable name', async () => {
  await assert.rejects(
    generateGlobalCharacterDraft('角色构想', async () => '{"name":"  "}'),
    /缺少姓名/,
  )
})

test('world character generation uses the world premise and creates a local protagonist draft', async () => {
  let prompt = ''
  const draft = await generateWorldPlayerCharacterDraft({
    title: '雾隐茶寮',
    genre: '悬疑',
    premise: '你是刚回到江城的调查记者。',
  }, async (value, options) => {
    prompt = value
    assert.equal(options?.timeoutMs, 45_000)
    return JSON.stringify({
      name: '林知夏',
      role: '调查记者',
      appearance: '短发，左眉有浅疤',
      physique: '清瘦',
      personality: '警觉而克制',
      background: '三年前搭档失踪后离开江城',
      styling: '深色风衣',
    })
  })
  assert.match(prompt, /雾隐茶寮/)
  assert.match(prompt, /调查记者/)
  assert.equal(draft.name, '林知夏')
  assert.equal(draft.background, '三年前搭档失踪后离开江城')
})

test('world character fallback keeps a usable protagonist when text generation is unavailable', () => {
  const draft = fallbackWorldPlayerCharacterDraft({
    title: '边城夜雨',
    genre: '武侠',
    premise: '你是边城驿站的杂役，今夜一辆马车闯进城。',
  })
  assert.equal(draft.name, '旅人')
  assert.equal(draft.role, '边城驿站的杂役')
  assert.equal(draft.background, '你是边城驿站的杂役，今夜一辆马车闯进城。')
  assert.match(draft.styling, /武侠/)
})
