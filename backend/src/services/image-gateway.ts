import { PLAY_STILL_FRAME } from './rpg/references.js'

/** 图片网关瞬时失败。视频提交不走这里，避免一次 502 被当成可以安全重放。 */
export const IMAGE_GATEWAY_ATTEMPTS = 3
export const IMAGE_GATEWAY_RETRY_MS = 1500
export const EDITS_FALLBACK_MESSAGE = '参考图编辑接口失败，已改为纯文生图，本次剧情图不含参考图'

export function isRetryableImageGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** 剧情图的 edits 在重试耗尽后仍是网关 5xx 时，改走不带参考图的 generations。定妆图不走这条。 */
export function shouldFallbackFromImageEdits(status: number, frameType: unknown, hadReferences: boolean): boolean {
  return hadReferences && frameType === PLAY_STILL_FRAME && isRetryableImageGatewayStatus(status)
}

export function imageGatewayError(status: number): string {
  return `图片服务暂时不可用（HTTP ${status}），请稍后再试`
}
