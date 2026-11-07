import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layout = readFileSync(new URL('../app/layouts/default.vue', import.meta.url), 'utf8')
const nuxt = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
const index = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(code => readFileSync(new URL(`../app/locales/${code}.json`, import.meta.url), 'utf8'))

test('top bar keeps 幻书, studio, and settings without 小说 or AI 建书', () => {
  assert.match(layout, /<span class="brand-name">幻书<\/span>/)
  assert.match(locales[0], /"play":\s*"幻书"/)
  assert.match(layout, /to="\/"/)
  assert.match(layout, /layout\.nav\.play/)
  assert.match(layout, /to="\/studio"/)
  assert.match(layout, /to="\/settings"/)
  assert.equal(layout.includes('to="/novel"'), false)
  assert.equal(layout.includes('to="/ai-novel"'), false)
  assert.equal(layout.includes('/ai-novel-app'), false)
  assert.equal(index.includes('/novel'), false)
  assert.equal(index.includes('去写小说'), false)
  assert.equal(nuxt.includes("'/novel"), false)
  assert.equal(nuxt.includes('/ai-novel-app'), false)
  assert.equal(nuxt.includes('novel-read'), false)
  for (const locale of locales) {
    assert.equal(locale.includes('"novel"'), false)
    assert.equal(locale.includes('aiNovel'), false)
    assert.equal(locale.includes('AI 建书'), false)
    assert.equal(locale.includes('ai-novel'), false)
  }
})
