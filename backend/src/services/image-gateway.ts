/** 图片网关瞬时失败。视频提交不走这里，避免一次 502 被当成可以安全重放。 */
export const IMAGE_GATEWAY_ATTEMPTS = 3
export const IMAGE_GATEWAY_RETRY_MS = 1500

export function isRetryableImageGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

export function imageGatewayError(status: number): string {
  return `图片服务暂时不可用（HTTP ${status}），请稍后再试`
}
