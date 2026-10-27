/**
 * 工作室 Agent 的统一入口。
 * 制作台的提取、视频提示词，以及织界回合，都从这里调用 Mastra，
 * 不再各自直连 chat/completions。
 */
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'

export interface StudioAgentRun {
  agentType: string
  episodeId: number
  dramaId: number
  message: string
  maxSteps?: number
  model?: string
  configId?: number
  /** 织界追加单条分镜时设置。保存工具会拒绝清空其他分镜。 */
  storyboardShotNumber?: number
  onTextDelta?: (delta: string) => Promise<void> | void
  onStepFinish?: (step: any) => void
}

export async function runStudioAgent(input: StudioAgentRun): Promise<{ text: string; raw: any }> {
  const agent = mastra.getAgent(input.agentType as never)
  if (!agent) throw new Error(`Agent 不可用：${input.agentType}`)
  const requestContext = buildAgentRequestContext({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    modelOverride: input.model || undefined,
    textConfigId: input.configId || undefined,
    storyboardShotNumber: input.storyboardShotNumber,
  })
  const messages = [{ role: 'user' as const, content: input.message }]
  const options: Record<string, unknown> = {
    maxSteps: input.maxSteps ?? 12,
    requestContext,
  }
  if (input.onStepFinish) options.onStepFinish = input.onStepFinish
  if (input.onTextDelta) return streamAgentText(agent, messages, options, input.onTextDelta)
  const result = await agent.generate(messages as any, options as any)
  return { text: typeof result?.text === 'string' ? result.text : '', raw: result }
}

async function streamAgentText(
  agent: { stream?: (messages: any, options: any) => Promise<any>; generate: (messages: any, options: any) => Promise<any> },
  messages: Array<{ role: 'user'; content: string }>,
  options: Record<string, unknown>,
  onTextDelta: (delta: string) => Promise<void> | void,
): Promise<{ text: string; raw: any }> {
  if (typeof agent.stream !== 'function') {
    const result = await agent.generate(messages, options)
    const text = typeof result?.text === 'string' ? result.text : ''
    if (text) await onTextDelta(text)
    return { text, raw: result }
  }

  let streamed = ''
  const emit = async (delta: string) => {
    if (!delta) return
    if (streamed && delta.startsWith(streamed)) {
      const extra = delta.slice(streamed.length)
      streamed = delta
      if (extra) await onTextDelta(extra)
      return
    }
    streamed += delta
    await onTextDelta(delta)
  }
  const stream = await agent.stream(messages, options)
  const textStream = stream?.textStream
  if (textStream && typeof textStream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of textStream) await emit(textOfChunk(chunk))
  } else if (textStream && typeof textStream.getReader === 'function') {
    const reader = textStream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await emit(textOfChunk(value))
    }
  }

  let text = streamed
  try {
    const resolved = stream?.text ? await stream.text : ''
    if (typeof resolved === 'string' && resolved) {
      text = resolved
      if (streamed && resolved.startsWith(streamed) && resolved.length > streamed.length) {
        await onTextDelta(resolved.slice(streamed.length))
      }
    }
  } catch { /* 增量已经交给调用方 */ }
  if (!streamed && text) await onTextDelta(text)
  return { text, raw: stream }
}

function textOfChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk)
  if (!chunk || typeof chunk !== 'object') return ''
  const record = chunk as Record<string, any>
  if (typeof record.text === 'string') return record.text
  if (typeof record.textDelta === 'string') return record.textDelta
  const payload = record.payload
  if (payload && typeof payload === 'object') {
    if (typeof payload.text === 'string') return payload.text
    if (typeof payload.textDelta === 'string') return payload.textDelta
  }
  return ''
}
