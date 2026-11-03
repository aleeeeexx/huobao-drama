import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const prepare = readFileSync(new URL('../scripts/prepare-resources.mjs', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')

test('desktop and docker ship ai-novel and point the backend at it', () => {
  assert.match(main, /AI_NOVEL_ROOT: path\.join\(resources, 'ai-novel'\)/)
  assert.match(builder, /from: resources\/ai-novel, to: ai-novel/)
  assert.match(prepare, /ai-novel\/server\.mjs/)
  assert.match(prepare, /top !== 'data'/)
  assert.match(dockerfile, /COPY ai-novel \.\/ai-novel/)
})
