/*
 * @Description: 查看器分派规则 —— 按扩展名（文件关联偏好）决定用 Monaco / Markdown / HTML / 图片 / 音视频 / file-viewer / 仅下载
 * @Author: YangHeng
 * @Date: 2026-10-10 11:40:00
 * @FilePath: /dsh-workspace/src/client/viewers/dispatch.ts
 */
import type { ViewerKind, ViewerMode } from './defaults.js'
import type { ViewerPrefs } from './prefs.js'

export interface ViewerPlan {
  viewer: ViewerKind
  /** 打开时的模式（有预览 / 源码两种的查看器才有意义）。 */
  mode: ViewerMode
  /** 扩展名（小写，无点；没有扩展名为空串）。 */
  ext: string
  /** 内容是文本、可以切到源码（Monaco）查看编辑。 */
  textual: boolean
  /** 需要先看文件大小（超过阈值先提示再加载）：整文件读进浏览器的查看器才需要。 */
  sizeGated: boolean
}

/** 天生是文本、即便交给 file-viewer 也能切到源码的扩展名。 */
const TEXT_PREVIEWABLE = new Set(['csv', 'tsv', 'svg'])

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)

/**
 * file-viewer 实际能渲染的扩展名白名单 = lazy/file-viewer-entry.ts 装配的 renderer 覆盖的扩展名
 * （pdf / word / spreadsheet / pptx / media / archive / image；单测按 renderer 定义校验两者一致）。
 * 为什么要白名单：用户可以把任意扩展名关联到 file-viewer，而未装配的格式在 file-viewer 里只会得到一行兜底提示，
 * 不如直接下载或按文本打开。rtf 不在其中：RTF 渲染需要额外的 rtf.js，本项目不装。
 * 这里写成静态表而不是运行时从 file-viewer 读取，是因为 file-viewer 是按需加载的大包，分派时还没加载。
 */
export const FILE_VIEWER_EXTS: ReadonlySet<string> = new Set(words(`
  pdf
  docx docm dotx dotm doc dot odt odp
  xlsx xltx xlsm xlsb xls xlt xla xlam xltm csv tsv ods fods dbf
  pptx pptm potx potm ppsx ppsm
  mp4 webm m3u8 mp3 mpeg wav ogg oga opus m4a aac flac weba midi mid
  zip zipx 7z rar tar gz gzip tgz bz2 bzip2 tbz tbz2 xz txz lzma zst tzst cab ar cpio iso xar lha lzh jar war ear apk cbz cbr
  gif jpg jpeg bmp tiff tif png svg webp avif ico heic heif jxl
`))

/** 关联到 file-viewer 却不在白名单时，这些文本类扩展名退回 Monaco 看原文，其余退回下载。 */
const TEXT_FALLBACK_EXTS: ReadonlySet<string> = new Set(words(`
  rtf txt text log md markdown mdx json jsonc json5 xml yaml yml toml ini conf cfg env properties
  js mjs cjs ts tsx jsx vue css scss less html htm xhtml py rb php java kt swift go rs c cc cpp h hpp cs
  sh bash zsh ps1 bat cmd sql diff patch tex proto hcl gv mmd mermaid puml plantuml geojson kml gpx
`))

/** 文件名 → 扩展名（小写）。点开头且没有其他点的文件（.gitignore、.env）视为无扩展名，按文本打开。 */
export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * 分派。没有关联的扩展名一律 Monaco：服务器上大量配置 / 脚本没有扩展名或用冷门扩展名，
 * 文本读取会嗅探二进制，读出来是二进制时由界面改为「仅下载」。
 */
export function planViewer(name: string, prefs: Pick<ViewerPrefs, 'associations'>): ViewerPlan {
  const ext = extOf(name)
  const assoc = ext === '' ? undefined : prefs.associations[ext]
  let viewer: ViewerKind = assoc?.viewer ?? 'monaco'
  let mode: ViewerMode | undefined = assoc?.mode
  if (viewer === 'file-viewer' && !FILE_VIEWER_EXTS.has(ext)) {
    viewer = TEXT_FALLBACK_EXTS.has(ext) ? 'monaco' : 'download'
    // 关联里的 mode 是写给 file-viewer 的，退回后按新查看器的默认模式打开。
    mode = undefined
  }
  const textual = viewer === 'monaco' || viewer === 'markdown' || viewer === 'html' || TEXT_PREVIEWABLE.has(ext)
  mode = mode ?? (viewer === 'monaco' ? 'edit' : 'preview')
  return { viewer, mode, ext, textual, sizeGated: viewer === 'file-viewer' }
}

/**
 * 打开时的视图（预览 / 代码）。Markdown 与 HTML 一样只有这两种视图：
 * 曾经的宽屏左右分栏会让右侧栏里两栏都挤得很窄，用户反馈不如单栏切换清楚，所以默认值只看文件关联偏好。
 */
export function initialViewMode(plan: Pick<ViewerPlan, 'viewer' | 'mode' | 'textual'>): 'preview' | 'code' {
  if (!plan.textual) return 'preview'
  return plan.viewer === 'monaco' || plan.mode === 'edit' ? 'code' : 'preview'
}

/** 超过阈值时是否需要先确认（音视频、文本不受限：前者走 Range 流，后者读取本身有上限会截断）。 */
export function needsSizeConfirm(plan: ViewerPlan, size: number | undefined, threshold: number): boolean {
  return plan.sizeGated && size !== undefined && size > threshold
}
