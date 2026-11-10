import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'

const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-character-image-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.STORAGE_PATH = path.join(storageDir, 'static')

const { db, schema } = await import('../src/db/index.js')
const { generateImage } = await import('../src/services/generation.js')

after(() => rmSync(storageDir, { recursive: true, force: true }))

for (const responseType of ['url', 'base64'] as const) {
  test(`character image is written before the ${responseType} task completes`, async (t) => {
    const ts = new Date().toISOString()
    const drama = db.insert(schema.dramas).values({ title: 'Portrait test', createdAt: ts, updatedAt: ts }).run()
    const character = db.insert(schema.characters).values({
      dramaId: Number(drama.lastInsertRowid), name: 'Character', imageUrl: 'static/images/old.png',
      localPath: 'static/images/old.png', createdAt: ts, updatedAt: ts,
    }).run()
    const characterId = Number(character.lastInsertRowid)
    const config = db.insert(schema.aiServiceConfigs).values({
      serviceType: 'image', provider: 'openai', name: 'Test', baseUrl: 'https://images.example',
      apiKey: 'test-key', model: JSON.stringify(['gpt-image-2']), createdAt: ts, updatedAt: ts,
    }).run()
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
    const fetchUrls: string[] = []
    t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request) => {
      const url = String(input)
      fetchUrls.push(url)
      if (url === 'https://images.example/v1/images/generations') {
        const image = responseType === 'url'
          ? { url: 'https://download.example/image.png' }
          : { b64_json: png.toString('base64') }
        return Response.json({ data: [image] })
      }
      if (url === 'https://download.example/image.png') return new Response(png)
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)

    const snapshots: Array<{ imageUrl: string | null; localPath: string | null; imageAuto: boolean }> = []
    const update = db.update.bind(db)
    t.mock.method(db, 'update', ((table: Parameters<typeof db.update>[0]) => {
      const query = update(table)
      if (table === schema.sysTask) {
        const set = query.set.bind(query)
        query.set = ((values: Parameters<typeof query.set>[0]) => {
          if ('status' in values && values.status === 'completed') {
            const row = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
            if (row) snapshots.push({ imageUrl: row.imageUrl, localPath: row.localPath, imageAuto: row.imageAuto })
          }
          return set(values)
        }) as typeof query.set
      }
      return query
    }) as typeof db.update)

    const taskId = await generateImage({ characterId, prompt: 'portrait', configId: Number(config.lastInsertRowid) })
    let task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    for (let attempt = 0; attempt < 500 && task?.status === 'processing'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    }

    assert.equal(task?.status, 'completed', task?.errorMsg || 'image task did not complete')
    assert.ok(task.localPath)
    assert.deepEqual(snapshots, [{ imageUrl: task.localPath, localPath: task.localPath, imageAuto: true }])
    const imagePath = path.join(storageDir, task.localPath)
    assert.equal(existsSync(imagePath), true)
    assert.deepEqual(readFileSync(imagePath), png)
    assert.equal(fetchUrls.length, responseType === 'url' ? 2 : 1)
  })
}
