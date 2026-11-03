import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layout = readFileSync(new URL('../app/layouts/default.vue', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/pages/ai-novel.vue', import.meta.url), 'utf8')
const nuxt = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
const zh = readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8')

test('top bar keeps 小说 and adds a separate AI 建书 entry', () => {
  assert.match(layout, /to="\/novel"/)
  assert.match(layout, /to="\/ai-novel"/)
  assert.match(layout, /startsWith\('\/novel\/'\)/)
  assert.match(layout, /startsWith\('\/ai-novel\/'\)/)
  assert.match(zh, /"novel": "小说"/)
  assert.match(zh, /"aiNovel": "AI 建书"/)
  assert.equal(layout.includes('to="http://127.0.0.1:5681"'), false)
})

test('AI 建书 page embeds the same-origin module and explains a stopped service', () => {
  assert.match(page, /src="\/ai-novel-app\/"/)
  assert.match(page, /\/api\/v1\/ai-novel\/status/)
  assert.match(page, /\/api\/v1\/ai-novel\/start/)
  assert.match(page, /layout\.aiNovelPage\.command/)
  assert.match(nuxt, /'\/ai-novel-app'/)
  assert.match(nuxt, /path: '\/novel\/:bookId'/)
})
