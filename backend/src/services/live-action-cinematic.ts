/**
 * 织界场面插画与影像的视觉风格。
 * 短剧制作台继续用各自的 style_presets；玩法生图、生视频固定走这一条，不读取世界原来的漫剧风格。
 */
export const LIVE_ACTION_CINEMATIC_STYLE = {
  name: '真人电影',
  value: 'live-action',
  sortOrder: 10,
  description: '真人电影实拍：真实演员、实景、电影光与摄影。奇幻内容按电影特效呈现，而不是绘画或动画。',
  prompt: [
    '真人电影',
    'photorealistic live-action cinema',
    'real human actors on practical sets',
    'cinematic film still and movie frame',
    'natural skin texture, pores, and true human anatomy',
    'motivated practical lighting',
    'shallow depth of field',
    'naturalistic color grade',
    '35mm anamorphic lens',
    'subtle film grain',
    'real-world materials, weather, and locations',
    'fantasy or non-human subjects only as live-action movie visual effects on real performers and sets',
    'consistent actor appearance across shots',
    'avoid anime',
    'avoid 二次元',
    'avoid cartoon',
    'avoid illustration',
    'avoid comic',
    'avoid manga',
    'avoid cel shading',
    'avoid painterly fantasy art',
    'avoid stylized donghua',
    'avoid CGI cartoon',
    'avoid plastic skin',
    'avoid beauty-filter smoothing',
  ].join(', '),
} as const
