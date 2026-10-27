/**
 * 视频任务提交前把项目风格词放在提示词最前。
 * 制作台任务接口和织界影像共用这一条，避免各写一套风格前缀。
 */
export function prefixVideoStyle(stylePrompt: string, prompt: string): string {
  if (!stylePrompt) return prompt
  return `${stylePrompt}，\n${prompt}`
}
