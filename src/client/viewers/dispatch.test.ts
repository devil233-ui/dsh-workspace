/*
 * @Description: 查看器分派规则与偏好合并测试
 * @Author: YangHeng
 * @Date: 2026-10-10 12:30:00
 * @FilePath: /dsh-workspace/src/client/viewers/dispatch.test.ts
 */
import { describe, expect, it } from 'vitest'
import { extOf, FILE_VIEWER_EXTS, initialViewMode, needsSizeConfirm, planViewer } from './dispatch.js'
import { applyViewerPrefs, getViewerPrefs, htmlSandboxByDefault, htmlUnlockKey, isHtmlUnlocked, largeFileBytes, mergeViewerPrefs, setHtmlUnlocked } from './prefs.js'
import { DEFAULT_ASSOCIATIONS, DEFAULT_LARGE_FILE_BYTES } from './defaults.js'

const prefs = mergeViewerPrefs({})

describe('extOf', () => {
  it('取最后一段扩展名并小写；点开头的隐藏文件视为无扩展名', () => {
    expect(extOf('/a/b/Report.PDF')).toBe('pdf')
    expect(extOf('archive.tar.gz')).toBe('gz')
    expect(extOf('.gitignore')).toBe('')
    expect(extOf('Makefile')).toBe('')
    expect(extOf('C:\\x\\a.Md')).toBe('md')
  })
})

describe('planViewer', () => {
  it('按扩展名分派到各查看器', () => {
    expect(planViewer('a.ts', prefs).viewer).toBe('monaco')
    expect(planViewer('README.md', prefs)).toMatchObject({ viewer: 'markdown', mode: 'preview', textual: true })
    expect(planViewer('index.html', prefs)).toMatchObject({ viewer: 'html', textual: true })
    expect(planViewer('logo.svg', prefs)).toMatchObject({ viewer: 'html', textual: true })
    expect(planViewer('a.png', prefs).viewer).toBe('image')
    expect(planViewer('movie.mp4', prefs).viewer).toBe('media')
    expect(planViewer('song.flac', prefs).viewer).toBe('media')
    for (const f of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.zip', 'a.7z', 'photo.heic']) expect(planViewer(f, prefs).viewer, f).toBe('file-viewer')
  })

  it('.doc / .dot 走 file-viewer（@file-viewer/doc 解析）；.ppt / CAD 只下载', () => {
    for (const f of ['a.doc', 'a.dot']) expect(planViewer(f, prefs).viewer, f).toBe('file-viewer')
    for (const f of ['a.ppt', 'a.pot', 'a.dwg', 'a.dxf']) expect(planViewer(f, prefs).viewer, f).toBe('download')
  })

  it('已装配 renderer 直接支持的变体格式默认走 file-viewer', () => {
    for (const ext of ['odp', 'dotm', 'pptm', 'potm', 'ppsm', 'xlt', 'xltm', 'fods', 'dbf']) expect(planViewer(`a.${ext}`, prefs).viewer, ext).toBe('file-viewer')
  })

  it('.rtf 按文本打开（不装 rtf.js）', () => {
    expect(planViewer('a.rtf', prefs)).toMatchObject({ viewer: 'monaco', mode: 'edit', textual: true })
  })

  it('默认关联到 file-viewer 的扩展名全部在白名单里', () => {
    for (const [ext, assoc] of Object.entries(DEFAULT_ASSOCIATIONS)) {
      if (assoc.viewer === 'file-viewer') expect(FILE_VIEWER_EXTS.has(ext), ext).toBe(true)
    }
  })

  it('白名单与 file-viewer-entry 装配的 renderer 定义一致（rtf 除外）', async () => {
    const mods = await Promise.all([
      import('@file-viewer/renderer-pdf').then((m) => m.pdfRenderer),
      import('@file-viewer/renderer-word').then((m) => m.wordRenderer),
      import('@file-viewer/renderer-spreadsheet').then((m) => m.spreadsheetRenderer),
      import('@file-viewer/renderer-pptx').then((m) => m.pptxRenderer),
      import('@file-viewer/renderer-media').then((m) => m.mediaRenderer),
      import('@file-viewer/renderer-archive').then((m) => m.archiveRenderer),
      import('@file-viewer/renderer-image').then((m) => m.imageRenderer)
    ])
    const exts = new Set(mods.flatMap((r) => (r.definitions ?? []).flatMap((d) => d.extensions)))
    exts.delete('rtf')
    expect([...FILE_VIEWER_EXTS].sort()).toEqual([...exts].sort())
  })

  it('自定义关联到 file-viewer 但未装配：文本类退回 Monaco，其余退回下载', () => {
    const custom = mergeViewerPrefs({ associations: { rtf: { viewer: 'file-viewer', mode: 'preview' }, json: { viewer: 'file-viewer' }, ppt: { viewer: 'file-viewer' }, dwg: { viewer: 'file-viewer' }, epub: { viewer: 'file-viewer' } } })
    expect(planViewer('a.rtf', custom)).toMatchObject({ viewer: 'monaco', mode: 'edit', textual: true, sizeGated: false })
    expect(planViewer('a.json', custom).viewer).toBe('monaco')
    for (const f of ['a.ppt', 'a.dwg', 'a.epub']) expect(planViewer(f, custom), f).toMatchObject({ viewer: 'download', sizeGated: false })
  })

  it('csv / tsv：默认表格预览，可切源码；pdf 不能切源码', () => {
    expect(planViewer('data.csv', prefs)).toMatchObject({ viewer: 'file-viewer', textual: true, mode: 'preview' })
    expect(planViewer('a.pdf', prefs).textual).toBe(false)
  })

  it('没有关联的扩展名（含无扩展名）按文本打开，默认编辑模式', () => {
    expect(planViewer('Dockerfile', prefs)).toMatchObject({ viewer: 'monaco', mode: 'edit', textual: true })
    expect(planViewer('x.unknownext', prefs).viewer).toBe('monaco')
  })

  it('文件关联覆盖默认表', () => {
    const custom = mergeViewerPrefs({ associations: { '.MD': { viewer: 'monaco' }, csv: { viewer: 'monaco' } } })
    expect(planViewer('a.md', custom).viewer).toBe('monaco')
    expect(planViewer('a.csv', custom).viewer).toBe('monaco')
  })

  it('大文件确认：只有整文件读进浏览器的查看器需要', () => {
    const limit = 20 * 1024 * 1024
    expect(needsSizeConfirm(planViewer('a.pdf', prefs), limit + 1, limit)).toBe(true)
    expect(needsSizeConfirm(planViewer('a.pdf', prefs), limit, limit)).toBe(false)
    expect(needsSizeConfirm(planViewer('a.mp4', prefs), limit * 10, limit)).toBe(false)
    expect(needsSizeConfirm(planViewer('a.pdf', prefs), undefined, limit)).toBe(false)
  })
})

describe('initialViewMode', () => {
  it('Markdown 默认单栏预览，与 HTML 一致；Monaco 文件默认代码', () => {
    expect(initialViewMode(planViewer('README.md', prefs))).toBe('preview')
    expect(initialViewMode(planViewer('index.html', prefs))).toBe('preview')
    expect(initialViewMode(planViewer('a.ts', prefs))).toBe('code')
  })

  it('文件关联把 Markdown 设为编辑模式时默认代码视图', () => {
    const custom = mergeViewerPrefs({ associations: { md: { viewer: 'markdown', mode: 'edit' } } })
    expect(initialViewMode(planViewer('a.md', custom))).toBe('code')
  })

  it('不能切源码的查看器永远是预览', () => {
    expect(initialViewMode(planViewer('a.pdf', prefs))).toBe('preview')
    expect(initialViewMode({ viewer: 'image', mode: 'edit', textual: false })).toBe('preview')
  })
})

describe('viewer prefs', () => {
  it('默认值：20MB 阈值、HTML 默认沙箱', () => {
    applyViewerPrefs({})
    expect(largeFileBytes()).toBe(DEFAULT_LARGE_FILE_BYTES)
    expect(DEFAULT_LARGE_FILE_BYTES).toBe(20 * 1024 * 1024)
    expect(htmlSandboxByDefault()).toBe(true)
  })

  it('覆盖值生效且非法值回落默认', () => {
    applyViewerPrefs({ largeFileBytes: 1024, htmlSandbox: false })
    expect(getViewerPrefs().largeFileBytes).toBe(1024)
    expect(htmlSandboxByDefault()).toBe(false)
    applyViewerPrefs({ largeFileBytes: -1 })
    expect(largeFileBytes()).toBe(DEFAULT_LARGE_FILE_BYTES)
    applyViewerPrefs({})
  })

  it('临时解锁按「主机 + 路径」记，互不影响', () => {
    const a = htmlUnlockKey('h1', '/a.html')
    setHtmlUnlocked(a, true)
    expect(isHtmlUnlocked(a)).toBe(true)
    expect(isHtmlUnlocked(htmlUnlockKey('h2', '/a.html'))).toBe(false)
    setHtmlUnlocked(a, false)
    expect(isHtmlUnlocked(a)).toBe(false)
  })
})
