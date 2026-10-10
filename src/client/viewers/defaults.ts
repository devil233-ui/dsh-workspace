/*
 * @Description: 文件查看器的默认偏好（文件关联、大文件阈值、HTML 沙箱）—— 默认值只写在这里
 * @Author: YangHeng
 * @Date: 2026-10-10 11:40:00
 * @FilePath: /dsh-workspace/src/client/viewers/defaults.ts
 *
 * 后续「侧边栏」管理页（方案 3.1）只需读写 prefs.ts 的覆盖值，不改这里；恢复默认 = 清空覆盖。
 */

/** 查看器种类。 */
export type ViewerKind = 'monaco' | 'markdown' | 'html' | 'image' | 'media' | 'file-viewer' | 'download'

/** 打开时的默认模式：预览（渲染）或编辑（源码）。只对同时有两种模式的查看器（markdown / html / 文本类 file-viewer）有意义。 */
export type ViewerMode = 'preview' | 'edit'

export interface ViewerAssociation {
  viewer: ViewerKind
  mode?: ViewerMode
}

/** 大文件阈值：超过先提示再加载（音视频走 Range 流，不受限）。 */
export const DEFAULT_LARGE_FILE_BYTES = 20 * 1024 * 1024

/** HTML 预览默认在沙箱里运行（脚本可执行但处于不透明源，碰不到 DSH 界面）。 */
export const DEFAULT_HTML_SANDBOX = true

const group = (exts: string, assoc: ViewerAssociation): Array<[string, ViewerAssociation]> =>
  exts.split(/\s+/).filter(Boolean).map((e) => [e, assoc])

/**
 * 默认文件关联（扩展名小写、不带点）。没列出的扩展名按文本打开（Monaco）；读出来是二进制时界面提示并提供下载。
 * 取舍：
 * - .doc / .dot 走 file-viewer：renderer-word 自带的 @file-viewer/doc（纯 JS、MIT，按需分片）解析 OLE 二进制；
 * - .ppt / CAD 只下载：.ppt 渲染器强制水印、CAD 渲染器是 AGPL（方案 3.3）；
 * - .rtf 走 Monaco 看原文：renderer-word 的 RTF 需要额外装 rtf.js，本项目不装；
 * - 宏启用 / 模板变体（dotm pptm xltm …）、odp、fods、dbf 由已装配的 renderer 直接支持，不增加体积；
 * - csv / tsv 默认表格预览，可切到源码编辑；svg 归入 html（预览 + 源码）；
 * - tiff / heic 浏览器不能原生显示，交给 file-viewer 的图片渲染器转换。
 * 关联到 file-viewer 的扩展名必须在 dispatch.ts 的 FILE_VIEWER_EXTS 白名单里（有单测把关）。
 */
export const DEFAULT_ASSOCIATIONS: Readonly<Record<string, ViewerAssociation>> = Object.freeze(
  Object.fromEntries([
    ...group('md markdown mdx', { viewer: 'markdown', mode: 'preview' }),
    ...group('html htm xhtml svg', { viewer: 'html', mode: 'preview' }),
    ...group('png jpg jpeg gif webp avif bmp ico', { viewer: 'image' }),
    ...group('mp4 m4v webm ogv mov mp3 m4a aac wav ogg oga opus flac weba', { viewer: 'media' }),
    ...group('pdf doc dot docx docm dotx dotm odt odp', { viewer: 'file-viewer' }),
    ...group('xlsx xlsm xlsb xls xlt xltx xltm ods fods dbf', { viewer: 'file-viewer' }),
    ...group('pptx pptm ppsx ppsm potx potm', { viewer: 'file-viewer' }),
    ...group('csv tsv', { viewer: 'file-viewer', mode: 'preview' }),
    ...group('zip 7z rar tar gz tgz bz2 tbz2 xz txz zst', { viewer: 'file-viewer' }),
    ...group('tif tiff heic heif', { viewer: 'file-viewer' }),
    ...group('ppt pps pot dwg dxf dwf exe dll msi so dylib bin iso dmg class jar war', { viewer: 'download' })
  ])
)
