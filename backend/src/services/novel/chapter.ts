export interface NovelPromptParams {
  [key: string]: string | number | undefined
}

/**
 * Chapter Prompts - 章节类提示词
 * 用于生成章节大纲和章节正文
 */

/**
 * 章节大纲提示词（一次性生成）
 * 悬念节奏曲线设计
 */
export const blueprint = (params: NovelPromptParams) => `
基于以下元素：
- 内容指导：${params.userGuidance || '无'}
- 小说架构：
${params.novelArchitecture}

设计${params.numberOfChapters}章的节奏分布（根据小说类型调整风格）：
1. 章节集群划分：
- 每3-5章构成一个情节单元，包含完整的小高潮
- 单元之间合理安排情感节奏（张弛有度）
- 关键转折章需预留铺垫

2. 每章需明确：
- 章节定位（角色/事件/主题等）
- 核心内容（剧情推进/情感发展/角色成长等）
- 情感基调（符合小说类型的情感色彩）
- 伏笔操作（埋设/强化/回收）
- 情节张力（★☆☆☆☆ 到 ★★★★★）

输出格式示例：
第n章 - [标题]
本章定位：[角色/事件/主题/...]
核心作用：[推进/转折/发展/升温/...]
情感强度：[平缓/渐进/高潮/...]
伏笔操作：埋设(A线索)→强化(B关系)...
情节张力：★☆☆☆☆
本章简述：[一句话概括]

要求：
- 使用精炼语言描述，每章字数控制在100字以内。
- 合理安排节奏，确保整体情感曲线的连贯性。
- 在生成${params.numberOfChapters}章前不要出现结局章节。
- **情节设计需符合小说类型的风格和情感基调**。

仅给出最终文本，不要解释任何内容。
`

/**
 * 分块章节大纲提示词
 * 用于分批生成章节
 */
export const blueprintChunked = (params: NovelPromptParams) => `
基于以下元素：
- 内容指导：${params.userGuidance || '无'}
- 小说架构：
${params.novelArchitecture}

需要生成总共${params.numberOfChapters}章的节奏分布，

当前已有章节目录（若为空则说明是初始生成）：
${params.chapterList || '(无)'}

现在请设计第${params.startChapter}章到第${params.endChapter}章的节奏分布（根据小说类型调整风格）：
1. 章节集群划分：
- 每3-5章构成一个情节单元，包含完整的小高潮
- 单元之间合理安排情感节奏（张弛有度）
- 关键转折章需预留铺垫

2. 每章需明确：
- 章节定位（角色/事件/主题等）
- 核心内容（剧情推进/情感发展/角色成长等）
- 情感基调（符合小说类型的情感色彩）
- 伏笔操作（埋设/强化/回收）
- 情节张力（★☆☆☆☆ 到 ★★★★★）

输出格式示例：
第n章 - [标题]
本章定位：[角色/事件/主题/...]
核心作用：[推进/转折/发展/升温/...]
情感强度：[平缓/渐进/高潮/...]
伏笔操作：埋设(A线索)→强化(B关系)...
情节张力：★☆☆☆☆
本章简述：[一句话概括]

要求：
- 使用精炼语言描述，每章字数控制在100字以内。
- 合理安排节奏，确保整体情感曲线的连贯性。
- 在生成${params.numberOfChapters}章前不要出现结局章节。
- **情节设计需符合小说类型的风格和情感基调**。

仅给出最终文本，不要解释任何内容。
`

/**
 * 第一章草稿提示词
 */
export const firstDraft = (params: NovelPromptParams) => `
即将创作：第 ${params.chapterNumber} 章《${params.chapterTitle}》
本章定位：${params.chapterRole}
核心作用：${params.chapterPurpose}
悬念密度：${params.suspenseLevel}
伏笔操作：${params.foreshadowing}
认知颠覆：${params.plotTwistLevel}
本章简述：${params.chapterSummary}

可用元素：
- 核心人物：${params.charactersInvolved || '(未指定)'}
- 关键道具：${params.keyItems || '(未指定)'}
- 空间坐标：${params.sceneLocation || '(未指定)'}
- 时间压力：${params.timeConstraint || '(未指定)'}

参考文档：
- 小说设定：
${params.novelSetting}

完成第 ${params.chapterNumber} 章的正文，字数要求${params.wordNumber}字，根据小说类型设计2个或以上的场景：
1. 对话场景：
   - 体现人物性格和关系
   - 推动剧情或情感发展

2. 动作/互动场景：
   - 环境交互细节（感官描写）
   - 节奏控制（根据情节需要调整）
   - 通过行动展现人物特质

3. 心理/情感场景：
   - 人物内心活动描写
   - 情感变化的细腻刻画
   - 符合小说类型的情感基调

4. 环境场景：
   - 场景氛围营造
   - 环境与人物心情的呼应
   - 符合小说类型的整体风格

格式要求：
- 仅返回章节正文文本；
- 不使用分章节小标题；
- 不要使用markdown格式。

额外指导：${params.userGuidance || '(无)'}
`

/**
 * 后续章节草稿提示词
 */
export const nextDraft = (params: NovelPromptParams) => `
参考文档：
└── 前文摘要：
    ${params.globalSummary}

└── 前章结尾段：
    ${params.previousChapterExcerpt}

└── 用户指导：
    ${params.userGuidance || '(无)'}

└── 角色状态：
    ${params.characterState}

└── 当前章节摘要：
    ${params.shortSummary || '(无)'}

当前章节信息：
第${params.chapterNumber}章《${params.chapterTitle}》：
├── 章节定位：${params.chapterRole}
├── 核心作用：${params.chapterPurpose}
├── 悬念密度：${params.suspenseLevel}
├── 伏笔设计：${params.foreshadowing}
├── 转折程度：${params.plotTwistLevel}
├── 章节简述：${params.chapterSummary}
├── 字数要求：${params.wordNumber}字
├── 核心人物：${params.charactersInvolved || '(未指定)'}
├── 关键道具：${params.keyItems || '(未指定)'}
├── 场景地点：${params.sceneLocation || '(未指定)'}
└── 时间压力：${params.timeConstraint || '(未指定)'}

下一章节目录
第${params.nextChapterNumber}章《${params.nextChapterTitle}》：
├── 章节定位：${params.nextChapterRole}
├── 核心作用：${params.nextChapterPurpose}
├── 悬念密度：${params.nextSuspenseLevel}
├── 伏笔设计：${params.nextForeshadowing}
├── 转折程度：${params.nextPlotTwistLevel}
└── 章节简述：${params.nextChapterSummary}

依据前面所有设定，开始完成第 ${params.chapterNumber} 章的正文，字数要求${params.wordNumber}字，
内容生成严格遵循：
- 用户指导
- 当前章节摘要
- 当前章节信息
- 无逻辑漏洞
确保章节内容与前文摘要、前章结尾段衔接流畅、下一章目录保证上下文完整性，

格式要求：
- 仅返回章节正文文本；
- 不使用分章节小标题；
- 不要使用markdown格式。
`

/**
 * 章节扩写提示词
 */
export const enrich = (params: NovelPromptParams) => `
以下章节文本较短，请在保持剧情连贯的前提下进行扩写，使其更充实，接近 ${params.wordNumber} 字左右。

原内容：
${params.chapterText}

要求：
- 保持剧情连贯性
- 增加环境描写和心理描写
- 丰富对话和场景细节
- 仅给出最终文本，不要解释任何内容
`

/**
 * 导出所有章节类提示词
 */
export const chapterPrompts = {
  blueprint,
  blueprintChunked,
  firstDraft,
  nextDraft,
  enrich
}
