/*
 * @Description: file-viewer 按需加载入口（单独打包成 lib/assets/viewers/file-viewer.js，不进 client.js）
 * @Author: YangHeng
 * @Date: 2026-10-10 11:30:00
 * @FilePath: /dsh-workspace/src/client/viewers/lazy/file-viewer-entry.ts
 *
 * 由 scripts/build-viewers.mjs 以 ESM + 代码分割打包：各 renderer 的重型实现（pdf.js、styled-exceljs、pptx 解析）
 * 本身就是 renderer 内部的动态 import，打包后各自成为独立分片，只有打开对应格式时才下载。
 *
 * 资源（Worker / WASM / cMap / 字体）由构建脚本复制到 lib/assets/viewers/fv/，经插件 /dsh-workspace/assets 路由托管；
 * 这里把每个资源地址都显式传给 file-viewer，不依赖它从页面 <script> 推断部署根（DSH 页面的脚本地址与插件无关，推断必然出错）。
 */
import { DEFAULT_RENDERER_DEFINITIONS, mountViewer, setDefaultFileViewerAssetBaseUrl } from '@file-viewer/core/browser'
import type { FileRenderHandler, FileViewerRendererPlugin } from '@file-viewer/core'
import { pdfRenderer } from '@file-viewer/renderer-pdf'
import { wordRenderer } from '@file-viewer/renderer-word'
import { spreadsheetRenderer } from '@file-viewer/renderer-spreadsheet'
import { mediaRenderer } from '@file-viewer/renderer-media'
import { archiveRenderer } from '@file-viewer/renderer-archive'
import { imageRenderer } from '@file-viewer/renderer-image'
import { fallbackRenderers, renderPlainText } from './fallback-renderers.js'

export interface FileViewerMountInput {
  /** 文件内容（与 url 二选一）。 */
  file?: File
  /** 文件地址（同源，可 Range）。 */
  url?: string
  name: string
  /** 资源根（绝对 URL，以 / 结尾）：即 /dsh-workspace/assets/viewers/fv/。 */
  assetBase: string
  dark: boolean
  locale?: string
}

/**
 * Word 全量装配（docx / doc / odt / odp），只改 RTF：renderer-word 的 RTF 依赖可选的 rtf.js（未安装时直接抛
 * 「RTF support is opt-in」安装指引）。本项目不装 rtf.js，顶层 .rtf 走 Monaco 看原文；
 * 压缩包内的 .rtf 也同样按纯文本显示，避免把安装指引露给用户。.doc（OLE 二进制）由 @file-viewer/doc 解析，纯 JS、按需分片。
 */
function wordWithTextRtf(): FileViewerRendererPlugin {
  return {
    ...wordRenderer,
    handlers: (wordRenderer.handlers ?? []).map((h) => {
      if (h.rendererId !== 'open-document') return h
      const original = h.handler as FileRenderHandler
      const handler: FileRenderHandler = (buffer, target, type, context) =>
        String(type ?? '').toLowerCase() === 'rtf' ? renderPlainText(buffer, target, type, context) : original(buffer, target, type, context)
      return { ...h, handler }
    })
  } as unknown as FileViewerRendererPlugin
}

/**
 * PPTX 渲染器在模块顶层就静态引入了 @file-viewer/pptx（约 700KB）：包一层，打开 pptx 时才加载。
 * 定义取自 core 的同一份格式表，与 renderer-pptx 自己注册的完全一致。
 */
function lazyPptx(): FileViewerRendererPlugin {
  const definition = DEFAULT_RENDERER_DEFINITIONS.find((d) => d.id === 'office-presentation')
  if (definition === undefined) return { id: 'dshws-pptx-missing', definitions: [], handlers: [] }
  return {
    id: 'file-viewer-renderer-pptx',
    definitions: [definition],
    handlers: [
      {
        rendererId: definition.id,
        handler: (async (...args: unknown[]) => {
          const mod = await import('@file-viewer/renderer-pptx')
          return (mod.renderFileViewerPresentation as (...a: unknown[]) => unknown)(...args)
        }) as never
      }
    ]
  }
}

/** 各 renderer 的 handler 泛型（目标元素类型）不同，统一按「目标元素不限」收拢成一个列表。 */
type AnyRenderer = FileViewerRendererPlugin<FileRenderHandler<unknown, never>>

/** 实际装配的 renderer（对应 dispatch.ts 的 FILE_VIEWER_EXTS 白名单）。 */
const INSTALLED: readonly AnyRenderer[] = [pdfRenderer, wordWithTextRtf(), spreadsheetRenderer, lazyPptx(), mediaRenderer, archiveRenderer, imageRenderer]

/**
 * 交给 file-viewer 的完整列表：装配的 renderer + 其余矩阵类别的兜底（ppt/pot、CAD、3D、电子书……）。
 * 兜底让压缩包内预览与自定义关联不再出现「尚未装配 xx renderer」的集成方提示。
 */
export const RENDERERS: readonly AnyRenderer[] = [...INSTALLED, ...fallbackRenderers(INSTALLED)]

export function mount(el: HTMLElement, input: FileViewerMountInput): { destroy(): void } {
  const base = input.assetBase.endsWith('/') ? input.assetBase : `${input.assetBase}/`
  setDefaultFileViewerAssetBaseUrl(base)
  const at = (p: string): string => new URL(p, base).href
  const controller = mountViewer(el, {
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    name: input.name,
    filename: input.name,
    options: {
      rendererMode: 'replace',
      renderers: RENDERERS,
      theme: input.dark ? 'dark' : 'light',
      locale: input.locale ?? 'auto',
      // Shadow DOM：DSH 的全局样式碰不到查看器，查看器的样式也不会漏到 DSH。
      styleIsolation: 'shadow',
      toolbar: true,
      ui: { density: 'compact' },
      pdf: {
        assetBaseUrl: base,
        workerUrl: at('vendor/pdf/pdf.worker.mjs'),
        cMapUrl: at('vendor/pdf/cmaps/'),
        wasmUrl: at('vendor/pdf/wasm/'),
        standardFontDataUrl: at('vendor/pdf/standard_fonts/'),
        cjkFontFallbackPath: at('vendor/pdf/fonts/')
      },
      archive: { workerUrl: at('vendor/libarchive/worker-bundle.js'), wasmUrl: at('vendor/libarchive/libarchive.wasm') },
      docx: { workerUrl: at('vendor/docx/docx.worker.js'), workerJsZipUrl: at('vendor/docx/jszip.min.js') },
      presentation: { workerUrl: at('vendor/pptx/pptx.worker.js') },
      spreadsheet: { workerUrl: at('vendor/xlsx/sheet.worker.js') }
    } as never
  })
  return { destroy: () => controller.destroy() }
}
