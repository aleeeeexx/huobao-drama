import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const prepare = readFileSync(new URL('../scripts/prepare-resources.mjs', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const backendIndex = readFileSync(new URL('../../backend/src/index.ts', import.meta.url), 'utf8')

test('desktop ships 幻书 chapter prompts and does not ship the ai-novel sidecar', () => {
  assert.match(main, /NOVEL_PROMPT_DEFAULTS:/)
  assert.match(main, /novel-prompts', 'defaults'/)
  assert.match(main, /prompt-source\/defaults/)
  assert.equal(main.includes('AI_NOVEL_ROOT'), false)
  assert.equal(main.includes('ai-novel'), false)
  assert.match(builder, /from: resources\/novel-prompts, to: novel-prompts/)
  assert.equal(builder.includes('ai-novel'), false)
  assert.match(prepare, /prompt-source/)
  assert.match(prepare, /novel-prompts/)
  assert.equal(prepare.includes('ai-novel'), false)
  assert.equal(prepare.includes('server.mjs'), false)
  assert.equal(dockerfile.includes('ai-novel'), false)
  assert.equal(backendIndex.includes('ai-novel'), false)
  assert.equal(backendIndex.includes("route('/novel'"), false)
  assert.equal(backendIndex.includes('/ai-novel-app'), false)
})
