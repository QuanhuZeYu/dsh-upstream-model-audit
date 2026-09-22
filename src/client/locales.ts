/** \`upstream-model-audit\` 命名空间字典。 */

/** 本插件拥有的字典命名空间。 */
export const NS = 'upstream-model-audit'

/** 简体中文字典（键集合的唯一来源）。 */
export const zh = {
  'row.label': '上游返回',
  'row.meta': '请求 {requested} · {mark}',
  'row.aria': '第 {turn} 轮第 {step} 步：请求 {requested}，上游返回 {reported}',
  'mark.prefixed': '仅厂商前缀不同',
  'mark.different': '模型名不同',
} as const

/** 英文字典，与中文键集合一一对应。 */
export const en: Record<UpstreamModelAuditKey, string> = {
  'row.label': 'Upstream returned',
  'row.meta': 'requested {requested} · {mark}',
  'row.aria': 'Turn {turn} step {step}: requested {requested}, upstream returned {reported}',
  'mark.prefixed': 'vendor prefix only',
  'mark.different': 'different model name',
}

/** 本命名空间的键类型。 */
export type UpstreamModelAuditKey = keyof typeof zh
