import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  compressReferenceImage,
  parseDataUrl,
  REFERENCE_IMAGE_JPEG_QUALITY,
  REFERENCE_IMAGE_MAX_EDGE,
} from '../src/utils/storage.ts'

async function plateDataUrl(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i * 13) & 255
    raw[i + 1] = (i * 7) & 255
    raw[i + 2] = 40 + ((i >> 8) & 127)
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  return { png, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}

test('reference plates are downscaled to jpeg before they are uploaded', async () => {
  const { dataUrl } = await plateDataUrl(1920, 1080)
  const compressed = await compressReferenceImage(dataUrl)
  assert.match(compressed, /^data:image\/jpeg;base64,/)
  const parsed = parseDataUrl(compressed)
  assert.ok(parsed)
  const bytes = Buffer.from(parsed.data, 'base64')
  const blob = new Blob([bytes], { type: parsed.mimeType })
  const meta = await sharp(bytes).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, 1536)
  assert.equal(meta.height, 864)
  assert.equal(REFERENCE_IMAGE_MAX_EDGE, 1536)
  assert.equal(REFERENCE_IMAGE_JPEG_QUALITY, 85)
  assert.equal(blob.size, bytes.length)
  assert.ok(bytes.length < 1_500_000)
})

test('a reference smaller than the max edge keeps its size', async () => {
  const { dataUrl } = await plateDataUrl(640, 360)
  const compressed = await compressReferenceImage(dataUrl)
  const parsed = parseDataUrl(compressed)
  assert.ok(parsed)
  const meta = await sharp(Buffer.from(parsed.data, 'base64')).metadata()
  assert.equal(meta.width, 640)
  assert.equal(meta.height, 360)
})

test('image reference uploads compress data urls instead of sending the original plate', () => {
  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
  const normalize = generation.slice(
    generation.indexOf('async function normalizeReferenceImages'),
    generation.indexOf('async function normalizeVideoReferenceUrl'),
  )
  assert.match(normalize, /compressReferenceImage\(value\)/)
  assert.doesNotMatch(normalize, /startsWith\('data:image\/'\)\) return value/)
  assert.doesNotMatch(normalize, /maxWidth:\s*768/)
  assert.match(generation, /\$\{value\.size\}B/)
  assert.match(generation, /readImageAsDataUrl\(localPath\)/)
})
