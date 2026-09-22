/**
 * 插件自有样式表：注入一段 \`<style>\`，产物保持纯 JavaScript bundle。
 *
 * 审计行是 Chat flow 里的一个同级行，紧跟它的 assistant 消息；排版只做低干扰的
 * 次要信息（小字号、次要色、等宽模型名），不覆盖任何原生样式。
 *
 * @module dsh-upstream-model-audit/styles
 */

/** 样式元素标记；同时是卸载时匹配的选择器。 */
export const STYLE_TAG = 'dsh-upstream-model-audit'

/** 类名前缀，避免与其他插件样式冲突。 */
export const CLS = 'uma'

const STYLES = [
  '.' + CLS + '-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 2px 0 6px; font-size: 11px; line-height: 16px; }',
  '.' + CLS + '-label { color: var(--dsw-alias-label-caption); }',
  '.' + CLS + '-to { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }',
  '.' + CLS + '-meta { color: var(--dsw-alias-label-caption); }',
  '.' + CLS + '-audit { flex-basis: 100%; color: var(--dsw-alias-label-caption); }',
].join('\n')

/**
 * 注入样式表。
 * @returns 移除样式表的清理函数（由 \`ctx.effect\` 在插件卸载时调用）。
 */
export function installStyles(): () => void {
  const element = document.createElement('style')
  element.dataset.dshPlugin = STYLE_TAG
  element.textContent = STYLES
  document.head.appendChild(element)
  return () => { element.remove() }
}
