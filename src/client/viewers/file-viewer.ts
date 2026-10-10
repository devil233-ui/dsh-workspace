/*
 * @Description: file-viewer 封装 —— mount(el, {file|url, name}) => {destroy}，首次使用时才加载 file-viewer 资源
 * @Author: YangHeng
 * @Date: 2026-10-10 11:40:00
 * @FilePath: /dsh-workspace/src/client/viewers/file-viewer.ts
 *
 * 对外只暴露这一层：底层库（@file-viewer/*，版本锁死）若要替换，只改 lazy/file-viewer-entry.ts 与这里。
 * 工具栏用 file-viewer 自带的（它按格式能力只显示支持的操作：缩放 / 搜索 / 打印 / 下载等）。
 */
import { loadViewerEntry, viewerAssetsUrl } from './lazy-load.js'

export interface FileViewerInput {
  /** 文件内容（与 url 二选一）。 */
  file?: File
  /** 同源地址（可 Range）。 */
  url?: string
  name: string
  dark?: boolean
  locale?: string
}

export interface FileViewerHandle {
  /** 查看器挂载完成（资源加载失败时 reject）。 */
  ready: Promise<void>
  destroy(): void
}

export function mount(el: HTMLElement, input: FileViewerInput): FileViewerHandle {
  let destroyed = false
  let inner: { destroy(): void } | undefined
  const ready = loadViewerEntry('file-viewer').then((entry) => {
    if (destroyed) return
    inner = entry.mount(el, {
      ...(input.file !== undefined ? { file: input.file } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      name: input.name,
      assetBase: viewerAssetsUrl('fv/'),
      dark: input.dark === true,
      ...(input.locale !== undefined ? { locale: input.locale } : {})
    })
  })
  return {
    ready,
    destroy() {
      destroyed = true
      try {
        inner?.destroy()
      } catch {
        /* 底层库卸载异常不影响关闭标签 */
      }
      el.replaceChildren()
    }
  }
}
