/*
 * @Description: 把文本写入宿主对话输入框（Markdown 预览选区「加入对话」用）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/viewers/composer.ts
 *
 * 为什么走 DOM：查过 DSH 0.2 的客户端（dsh-client-ui-conversation / chat / input-trigger），输入框草稿存在会话 store
 * （setDraft）里，没有对插件公开的「插入文本」接口；输入框是 Lexical 编辑器（contenteditable + data-lexical-editor）。
 * 所以模拟一次粘贴：Lexical 自己处理 paste 事件，换行、撤销栈、草稿持久化都与用户手动粘贴一致。
 * 粘贴没生效时退回 execCommand('insertText')（Lexical 监听 beforeinput），仍不行就复制到剪贴板让用户自己粘贴。
 * 宿主日后提供正式接口时，只改这一个文件。
 */

export type InsertResult = 'inserted' | 'copied' | 'failed'

/** 找当前可见的对话输入框：多个时取最靠下的那个（主对话输入框在页面底部）。 */
function findComposer(): HTMLElement | undefined {
  const all = [...document.querySelectorAll<HTMLElement>('[data-lexical-editor="true"][contenteditable="true"]')]
  const visible = all.filter((el) => el.getClientRects().length > 0)
  return visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
}

function caretToEnd(el: HTMLElement): void {
  const selection = window.getSelection()
  if (selection === null) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/** 引用格式：每行加「> 」，末尾注明出处，再空一行便于接着输入。 */
export function quoteForChat(text: string, source: string): string {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n')
  return `${lines.map((l) => `> ${l}`).join('\n')}\n> —— ${source}\n\n`
}

export async function insertIntoComposer(text: string): Promise<InsertResult> {
  const el = findComposer()
  if (el !== undefined) {
    const before = el.textContent ?? ''
    el.focus()
    caretToEnd(el)
    try {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    } catch {
      /* 个别环境不允许构造 ClipboardEvent：走下一种 */
    }
    await nextFrame()
    if ((el.textContent ?? '') !== before) return 'inserted'
    try {
      // 已废弃但各浏览器仍支持；Lexical 通过 beforeinput(insertText) 接收。
      document.execCommand('insertText', false, text)
    } catch {
      /* 忽略 */
    }
    await nextFrame()
    if ((el.textContent ?? '') !== before) return 'inserted'
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
