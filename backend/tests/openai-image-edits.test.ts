import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROK_IMAGE_REFERENCE_LIMIT, OpenAIImageAdapter } from '../src/services/adapters/openai-image.ts'
import {
  EDITS_FALLBACK_MESSAGE,
  officialXaiEditsTarget,
  promptAfterEditsFallback,
  selectGrokReferenceUrl,
  shouldFallbackFromImageEdits,
} from '../src/services/image-gateway.ts'

const config = {
  provider: 'openai',
  baseUrl: 'https://codecc.cc',
  apiKey: 'test-key',
  model: 'grok-imagine-image-quality',
}
const plate = (n: number) => `https://cdn.example.com/plates/${n}.jpg`
const dataPlate = (n: number) => `data:image/jpeg;base64,ref${n}`

function httpsRefs(count: number) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => plate(i + 1)))
}

function dataRefs(count: number) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => dataPlate(i + 1)))
}

test('grok edits are JSON image or images, not multipart image[]', () => {
  const adapter = new OpenAIImageAdapter()
  const one = adapter.buildGenerateRequest(config, {
    id: 1,
    model: 'grok-imagine-image-quality',
    prompt: '剧照',
    size: '1920x1080',
    referenceImages: httpsRefs(1),
  })
  assert.match(one.url, /\/v1\/images\/edits$/)
  assert.equal(one.headers['Content-Type'], 'application/json')
  assert.equal(one.body instanceof FormData, false)
  assert.equal(one.body.response_format, 'url')
  assert.equal(one.body.aspect_ratio, '16:9')
  assert.deepEqual(one.body.image, { type: 'image_url', url: plate(1) })
  assert.equal(one.body.images, undefined)
  assert.equal(String(one.body.image.url).startsWith('data:'), false)

  const four = adapter.buildGenerateRequest(config, {
    id: 2,
    model: 'grok-imagine-image-quality',
    prompt: '剧照',
    size: '1920x1080',
    referenceImages: httpsRefs(4),
  })
  assert.equal(four.body.image, undefined)
  assert.equal(four.body.images.length, 2)
  assert.deepEqual(four.body.images[0], { type: 'image_url', url: plate(1) })
  assert.deepEqual(four.body.images[1], { type: 'image_url', url: plate(2) })

  const six = adapter.buildGenerateRequest(config, {
    id: 3,
    model: 'grok-imagine-image-quality',
    prompt: '剧照',
    size: '1024x1024',
    referenceImages: httpsRefs(6),
  })
  assert.equal(six.body.images.length, 2)
  assert.equal(six.body.aspect_ratio, '1:1')
  assert.equal(six.body.images[0].url, plate(1))
  assert.equal(six.body.images[1].url, plate(2))
  assert.equal(GROK_IMAGE_REFERENCE_LIMIT, 2)
  const codecc = readFileSync(new URL('../src/services/codecc-config.ts', import.meta.url), 'utf8')
  assert.match(codecc, /grok-imagine-image-quality/)
  assert.doesNotMatch(codecc, /gpt-image-2\.5/)

  assert.throws(
    () => adapter.buildGenerateRequest(config, {
      id: 7,
      model: 'grok-imagine-image-quality',
      prompt: '剧照',
      size: '1920x1080',
      referenceImages: JSON.stringify(['data:image/jpeg;base64,aaaa']),
    }),
    /https/,
  )
})

test('grok text-only plates stay on generations', () => {
  const adapter = new OpenAIImageAdapter()
  const plain = adapter.buildGenerateRequest(config, {
    id: 4,
    model: 'grok-imagine-image-quality',
    prompt: '定妆',
    size: '1920x1080',
  })
  assert.match(plain.url, /\/v1\/images\/generations$/)
  assert.equal(plain.body.response_format, 'url')
  assert.equal(plain.body.image, undefined)
  assert.equal(plain.body.images, undefined)
})

test('OpenAI edits repeat the image field and do not use image[]', () => {
  const adapter = new OpenAIImageAdapter()
  const gpt = adapter.buildGenerateRequest(
    { ...config, model: 'gpt-image-2' },
    { id: 5, model: 'gpt-image-2', prompt: 'edit', size: '1024x1024', referenceImages: dataRefs(2) },
  )
  assert.ok(gpt.body instanceof FormData)
  const names = [...(gpt.body as FormData).keys()]
  assert.equal(names.filter(name => name === 'image').length, 2)
  assert.equal(names.includes('image[]'), false)
  assert.equal(names.includes('response_format'), false)

  const dalle = adapter.buildGenerateRequest(
    { ...config, model: 'dall-e-2' },
    { id: 6, model: 'dall-e-2', prompt: 'edit', size: '1024x1024', referenceImages: dataRefs(2) },
  )
  const dalleNames = [...(dalle.body as FormData).keys()]
  assert.equal(dalleNames.filter(name => name === 'image').length, 1)
  assert.equal(dalleNames.includes('response_format'), true)

  const source = readFileSync(new URL('../src/services/adapters/openai-image.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /append\('image\[\]'/)
})

test('grok edits prefer the provider https url over a data url', () => {
  assert.equal(selectGrokReferenceUrl({
    reference: 'static/images/you.png',
    providerResultUrl: 'https://cdn.example.com/you.png',
    publicFileUrl: 'https://drama.example/static/images/you.jpg',
  }), 'https://cdn.example.com/you.png')
  assert.equal(selectGrokReferenceUrl({
    reference: 'https://cdn.example.com/already.jpg',
    providerResultUrl: 'https://cdn.example.com/other.jpg',
  }), 'https://cdn.example.com/already.jpg')
  assert.equal(selectGrokReferenceUrl({
    reference: 'static/images/you.png',
    publicFileUrl: 'https://drama.example/static/images/you.jpg',
  }), 'https://drama.example/static/images/you.jpg')
  assert.equal(selectGrokReferenceUrl({
    reference: 'data:image/jpeg;base64,aaaa',
  }), null)
  assert.equal(selectGrokReferenceUrl({
    reference: 'static/images/you.png',
    providerResultUrl: 'http://cdn.example.com/you.png',
    publicFileUrl: 'http://127.0.0.1:5679/static/images/you.jpg',
  }), null)
})

test('grok edits call api.x.ai only when an xAI credential already exists', () => {
  assert.equal(officialXaiEditsTarget({
    baseUrl: 'https://codecc.cc',
    apiKey: 'sk-gateway',
  }), null)
  assert.deepEqual(officialXaiEditsTarget({
    baseUrl: 'https://codecc.cc',
    apiKey: 'xai-stored',
  }), { baseUrl: 'https://api.x.ai', apiKey: 'xai-stored' })
  assert.deepEqual(officialXaiEditsTarget({
    baseUrl: 'https://codecc.cc',
    apiKey: 'sk-gateway',
    explicitApiKey: 'xai-env',
  }), { baseUrl: 'https://api.x.ai', apiKey: 'xai-env' })
  assert.deepEqual(officialXaiEditsTarget({
    baseUrl: 'https://codecc.cc',
    apiKey: 'sk-gateway',
    storedOfficial: { baseUrl: 'https://api.x.ai', apiKey: 'xai-db' },
  }), { baseUrl: 'https://api.x.ai', apiKey: 'xai-db' })
  assert.equal(officialXaiEditsTarget({
    baseUrl: 'https://api.x.ai',
    apiKey: 'xai-already',
  }), null)
  assert.equal(officialXaiEditsTarget({
    baseUrl: 'https://codecc.cc',
    apiKey: 'sk-gateway',
    explicitApiKey: 'xai-env',
    explicitBaseUrl: 'https://evil.example',
  }), null)
})

test('edits fallback keeps the written appearance when reference images are dropped', () => {
  const prompt = promptAfterEditsFallback('画面中的人物：你（青衫、短发）')
  assert.match(prompt, /青衫、短发/)
  assert.match(prompt, /必须严格按上文已经写明的外貌/)
  assert.equal(promptAfterEditsFallback(prompt), prompt)
})

test('play stills fall back to generations only after edits gateway failure', () => {
  assert.equal(shouldFallbackFromImageEdits(502, 'play_still', true), true)
  assert.equal(shouldFallbackFromImageEdits(503, 'play_still', true), true)
  assert.equal(shouldFallbackFromImageEdits(400, 'play_still', true), false)
  assert.equal(shouldFallbackFromImageEdits(401, 'play_still', true), false)
  assert.equal(shouldFallbackFromImageEdits(401, 'play_still', true, true), true)
  assert.equal(shouldFallbackFromImageEdits(502, 'asset_reference', true), false)
  assert.equal(shouldFallbackFromImageEdits(502, 'play_still', false), false)
  assert.match(EDITS_FALLBACK_MESSAGE, /不含参考图/)

  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
  const submit = generation.slice(
    generation.indexOf('let resp = await postProvider'),
    generation.indexOf('const result = await resp.json()'),
  )
  assert.match(submit, /shouldFallbackFromImageEdits/)
  assert.match(submit, /referenceImages: null/)
  assert.match(submit, /edits-fallback/)
  assert.match(generation, /normalizeGrokReferenceUrls/)
  assert.match(generation, /selectGrokReferenceUrl/)
  assert.match(generation, /officialXaiEditsTarget/)
  assert.match(submit, /promptAfterEditsFallback\(record\.prompt\)/)
  assert.doesNotMatch(generation.slice(
    generation.indexOf('async function normalizeGrokReferenceUrls'),
    generation.indexOf('async function normalizeReferenceImages'),
  ), /readImageAsCompressedDataUrl|data:image/)
})
