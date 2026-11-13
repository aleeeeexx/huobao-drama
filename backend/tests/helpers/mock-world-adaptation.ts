import { eq } from 'drizzle-orm'

/** 模拟世界适配的文本服务；其他模型请求仍交给测试自己的 fetch。 */
export async function withMockWorldAdaptation<T>(
  run: () => Promise<T>,
  respond?: (prompt: string) => string,
): Promise<T> {
  const { db, schema } = await import('../../src/db/index.js')
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: '世界适配测试',
    baseUrl: 'https://world-adaptation.example', apiKey: 'test', model: '["test"]',
    priority: 100000, createdAt: timestamp, updatedAt: timestamp,
  }).run()
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://world-adaptation.example/')) return previousFetch(input, init)
    const body = JSON.parse(String(init?.body || '{}'))
    const prompt = String(body.messages?.[0]?.content || '')
    const value = (label: string) => prompt.match(new RegExp(`(?:^|\\n)${label}：([^\\n]*)`))?.[1]?.trim() || '未设定'
    const answer = respond ? respond(prompt) : JSON.stringify({
      name: value('默认姓名'), role: value('默认身份'), personality: value('默认性格'),
      values: value('默认价值观'), speech: value('默认说话方式'), habits: value('默认习惯'),
      desires: value('默认愿望'), fears: value('默认恐惧'), relationships: value('默认在乎的人'),
      abilities: value('默认能力'), background: value('默认经历'), styling: value('默认服装'),
    })
    return Response.json({ choices: [{ message: { content: answer } }] })
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = previousFetch
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid))).run()
  }
}
