import { LIVE_ACTION_CINEMATIC_STYLE } from '../live-action-cinematic.js'

export interface WorldSeed {
  slug: string
  title: string
  tagline: string
  premise: string
  genre: string
  style: string
}

export const PRESET_WORLDS: WorldSeed[] = [
  {
    slug: 'mist-teahouse',
    title: '雾隐茶寮',
    tagline: '雨夜的茶寮里，每一杯茶都兑着一句谎话',
    genre: '悬疑',
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    premise: '你是刚回到江城的调查记者。连绵阴雨里，城南「雾隐茶寮」只在子时开门。三年前失踪的搭档留下半张茶券，上面写着你的名字。茶寮老板娘认得这张券，却不肯说搭档最后一夜坐在哪张桌子。门外有盯梢的黑车，柜台上压着一封没有署名的信。',
  },
  {
    slug: 'starport-exiles',
    title: '星港遗民',
    tagline: '港口还亮着灯，但母星已经不再回答',
    genre: '科幻',
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    premise: '你是星港「遗民区」的机修学徒。今夜主航道突然熄灭，所有离港船被锁在港湾。导师把一枚还温着的身份核塞进你手里，说它属于不该存在的人。海关的灯正向你的舱室靠近，而对面船坞里，一扇本该焊死的气闸开了一条缝。',
  },
  {
    slug: 'border-rain',
    title: '边城夜雨',
    tagline: '城门已关，刀还在雨里',
    genre: '武侠',
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    premise: '你是边城驿站的杂役，白天扫马厩，夜里偷听江湖人的话。今夜一辆没有旗号的马车闯进城，车上的人把一把断刀塞给你，要你在三更前送到城西废弃戏台。追兵已经换了守军的甲。戏台方向有灯，驿站后院的狗却不叫了。',
  },
]
