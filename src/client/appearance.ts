/*
 * @Description: 外观偏好的页内生效 —— IME 守卫与自定义 CSS（均可撤销，跟随偏好实时开关）
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/client/appearance.ts
 *
 * IME 守卫：中文 / 日文输入法组字时按回车、方向键选词，浏览器照样派发 keydown（isComposing=true，部分浏览器 keyCode=229）。
 * 宿主与其他插件的全局快捷键若不判断组字状态，就会把「选词的回车」当成发送 / 确认。
 * 在 document 捕获阶段拦下这类事件的传播（只 stopPropagation，不 preventDefault）：输入框本身仍收到按键，
 * 输入法照常工作，只是冒泡 / 后续捕获阶段的快捷键处理器看不到它。
 */
import { getSidebarPrefs, subscribeSidebarPrefs } from './sidebar-prefs.js'

const CAPTURE = { capture: true } as const

/** 是否属于输入法组字中的按键。 */
export function isImeKey(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229
}

/**
 * 在 target（默认 document）捕获阶段挂 IME 守卫。
 * @returns 撤销函数
 */
export function installImeGuard(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  // 精简环境（构建冒烟测试的假 document 等）没有事件接口：静默跳过，不影响其余功能。
  if (target === undefined || typeof target.addEventListener !== 'function') return () => undefined
  const guard = (e: Event): void => {
    if (!isImeKey(e as KeyboardEvent)) return
    // 捕获阶段在 document 上停止传播，连目标元素自己的 keydown 监听也收不到。
    // xterm / Monaco 自己处理组字（xterm 还靠 keyCode 229 的 keydown 驱动组字辅助层），对它们放行，免得终端 / 编辑器里输入法失灵。
    const target = e.target as { closest?: (selector: string) => unknown } | null
    if (typeof target?.closest === 'function' && target.closest('.xterm, .monaco-editor') !== null) return
    e.stopPropagation()
  }
  // 用选项对象而不是布尔 true：部分 EventTarget 实现（如 Node）对 removeEventListener 的布尔 capture 匹配不上，撤销会失效。
  target.addEventListener('keydown', guard, CAPTURE)
  target.addEventListener('keyup', guard, CAPTURE)
  return () => {
    target.removeEventListener('keydown', guard, CAPTURE)
    target.removeEventListener('keyup', guard, CAPTURE)
  }
}

export const CUSTOM_CSS_ATTR = 'data-dshws-custom'

/**
 * 把自定义 CSS 写进 <style data-dshws-custom>（放在 head 末尾，优先级高于本插件与宿主的样式）。
 * 空文本时移除节点。
 * @returns 撤销函数（移除节点）
 */
export function mountCustomCss(css: string, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  if (doc === undefined || typeof doc.querySelectorAll !== 'function' || typeof doc.createElement !== 'function') return () => undefined
  // HMR 重载后旧实例可能残留：先清掉同标记的节点，保证始终只有一份。
  for (const old of doc.querySelectorAll(`style[${CUSTOM_CSS_ATTR}]`)) old.remove()
  if (css.trim() === '') return () => undefined
  const style = doc.createElement('style')
  style.setAttribute(CUSTOM_CSS_ATTR, '')
  style.textContent = css
  doc.head.appendChild(style)
  return () => {
    style.remove()
  }
}

/**
 * 按偏好挂载外观功能，偏好变化时即时开关 / 更新。
 * @returns 撤销全部（交给 ctx.effect，插件卸载 / HMR 时回收）
 */
export function installAppearance(): () => void {
  let offIme: (() => void) | undefined
  let offCss: (() => void) | undefined
  let css: string | undefined
  const sync = (): void => {
    const p = getSidebarPrefs()
    if (p.imeGuard && offIme === undefined) offIme = installImeGuard()
    if (!p.imeGuard && offIme !== undefined) {
      offIme()
      offIme = undefined
    }
    if (p.customCss !== css) {
      css = p.customCss
      offCss?.()
      offCss = mountCustomCss(css)
    }
  }
  sync()
  const unsubscribe = subscribeSidebarPrefs(sync)
  return () => {
    unsubscribe()
    offIme?.()
    offCss?.()
    offIme = undefined
    offCss = undefined
  }
}
