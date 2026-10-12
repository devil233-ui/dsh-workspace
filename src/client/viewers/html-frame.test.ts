/*
 * @Description: HTML 预览 iframe 渲染决策与探针的回归测试（白屏排查：沙箱切换必须重建 iframe、保存后刷新、探针注入位置）
 * @Author: YangHeng
 * @Date: 2026-10-12 18:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/html-frame.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROBE,
  HTML_SANDBOX,
  frameLoadMode,
  framePlan,
  looksLikeSandboxDenial,
  previewBaseHref,
  probeNotes,
  reduceProbe,
  shouldProbe,
  withBaseHref,
  withProbeQuery
} from './html-frame.js'
import { PROBE_FLAG, PROBE_SCRIPT, readProbeMessage, withPreviewProbe } from '../../wire/preview-probe.js'

describe('frameLoadMode（加载方式）', () => {
  // 为什么要覆盖整张表：Windows 桌面版兼容模式页面是 http://127.0.0.1，却同时是桌面渲染进程，
  // 之前一律按「桌面 → srcdoc」处理，Worker / fetch 的相对地址全解析到 DSH 根目录。
  const cases: Array<[string, boolean, boolean, 'src' | 'srcdoc']> = [
    ['http:', false, true, 'src'],
    ['http:', false, false, 'src'],
    ['https:', false, true, 'src'],
    ['https:', false, false, 'src'],
    ['http:', true, false, 'src'],
    ['https:', true, false, 'src'],
    ['http:', true, true, 'srcdoc'],
    ['dsh-app:', true, true, 'srcdoc'],
    ['dsh-app:', true, false, 'srcdoc'],
    ['file:', false, true, 'srcdoc'],
    ['file:', false, false, 'srcdoc']
  ]
  it.each(cases)('%s 桌面=%s 沙箱=%s → %s', (protocol, desktop, sandboxed, want) => {
    expect(frameLoadMode({ protocol, desktop, sandboxed })).toBe(want)
  })

  it('srcdoc 的 <base>：指向预览路由里文件所在目录；file: 页面不可达不注入；页面自带 <base> 不覆盖', () => {
    expect(previewBaseHref('/dsh-workspace/preview/tk/C%3A/ws/ex/index.html', 'dsh-app://app/index.html')).toBe('dsh-app://app/dsh-workspace/preview/tk/C%3A/ws/ex/')
    expect(previewBaseHref('/dsh-workspace/preview/tk/srv/a.html', 'http://127.0.0.1:43120/chat')).toBe('http://127.0.0.1:43120/dsh-workspace/preview/tk/srv/')
    expect(previewBaseHref('/dsh-workspace/preview/tk/srv/a.html', 'file:///C:/x/index.html')).toBeUndefined()
    const out = withBaseHref('<!doctype html><html><head><title>x</title></head></html>', 'http://h/p/')
    expect(out).toBe('<!doctype html><html><head><base href="http://h/p/"><title>x</title></head></html>')
    expect(withBaseHref('<head><base href="/x/"></head>', 'http://h/p/')).toBe('<head><base href="/x/"></head>')
  })
})

describe('沙箱属性', () => {
  it('允许脚本与弹窗（alert / confirm 不被静默吞掉），但绝不同源', () => {
    const list = HTML_SANDBOX.split(' ')
    expect(list).toContain('allow-scripts')
    expect(list).toContain('allow-modals')
    expect(list).not.toContain('allow-same-origin')
  })
})

describe('probeNotes（提示分类）', () => {
  const opts = { sandboxed: true, timedOut: false, timeoutSeconds: 10 }
  const withError = (message: string) => reduceProbe(EMPTY_PROBE, { kind: 'error', message })

  it('同源能力被拒（Worker / origin null / SecurityError / 存储 / cookie）：沙箱下追加「临时解除沙箱」提示', () => {
    for (const m of [
      "Failed to construct 'Worker': Script at 'http://127.0.0.1:43120/worker.js' cannot be accessed from origin 'null'.",
      "SecurityError: Failed to read the 'localStorage' property from 'Window'",
      "Failed to read the 'sessionStorage' property",
      "Failed to read the 'cookie' property from 'Document'",
      'Inline module script failed to load its imports'
    ]) {
      const [n] = probeNotes(withError(m), opts)
      expect(n).toMatchObject({ tone: 'error', key: 'viewer.htmlError', hint: 'viewer.htmlSandboxHint' })
    }
  })

  it('普通报错不追加；已解除沙箱时也不追加', () => {
    expect(probeNotes(withError('ReferenceError: foo is not defined'), opts)[0]?.hint).toBeUndefined()
    expect(probeNotes(withError("cannot be accessed from origin 'null'"), { ...opts, sandboxed: false })[0]?.hint).toBeUndefined()
  })

  it('空页面：有脚本 → 中性说明（不是故障）；无脚本 → 警告；有报错时只报错', () => {
    const load = (scripts: number) => reduceProbe(EMPTY_PROBE, { kind: 'load', text: 0, elements: 0, height: 0, scripts })
    expect(probeNotes(load(1), opts)).toEqual([{ tone: 'info', key: 'viewer.htmlEmptyScripted' }])
    expect(probeNotes(load(0), opts)).toEqual([{ tone: 'warn', key: 'viewer.htmlEmpty' }])
    const both = reduceProbe(load(1), { kind: 'error', message: 'x' })
    expect(probeNotes(both, opts).map((n) => n.key)).toEqual(['viewer.htmlError'])
  })

  it('超时未加载才提示打开开发者工具', () => {
    expect(probeNotes(EMPTY_PROBE, { ...opts, timedOut: true })).toEqual([{ tone: 'warn', key: 'viewer.htmlNoSignal', vars: { seconds: '10' } }])
    expect(probeNotes(reduceProbe(EMPTY_PROBE, { kind: 'load', text: 3, elements: 1, height: 9, scripts: 0 }), { ...opts, timedOut: true })).toEqual([])
  })
})

describe('framePlan', () => {
  it('网页版走预览路由：沙箱带 sandbox 属性，解除沙箱不带', () => {
    const on = framePlan({ src: '/p/t/a.html', srcDoc: null, sandboxed: true, nonce: 0 })
    expect(on).toEqual({ key: 'src|/p/t/a.html|0|true', src: '/p/t/a.html', sandbox: HTML_SANDBOX })
    const off = framePlan({ src: '/p/t2/a.html', srcDoc: null, sandboxed: false, nonce: 0 })
    expect(off?.sandbox).toBeUndefined()
    expect(off?.src).toBe('/p/t2/a.html')
  })

  it('桌面版走 srcdoc；沙箱无 allow-same-origin', () => {
    const p = framePlan({ src: null, srcDoc: '<p>x</p>', sandboxed: true, nonce: 0 })
    expect(p?.srcDoc).toBe('<p>x</p>')
    expect(p?.src).toBeUndefined()
    expect(p?.sandbox).not.toContain('allow-same-origin')
    expect(p?.sandbox).toContain('allow-scripts')
  })

  it('解除 / 恢复沙箱、保存或刷新（nonce）都会换键 = 重建 iframe', () => {
    const base = { src: null, srcDoc: '<p>x</p>', nonce: 1 }
    const a = framePlan({ ...base, sandboxed: true })?.key
    expect(framePlan({ ...base, sandboxed: false })?.key).not.toBe(a)
    expect(framePlan({ ...base, sandboxed: true, nonce: 2 })?.key).not.toBe(a)
  })

  it('地址未就绪（undefined）且没有 srcdoc 时不渲染 iframe', () => {
    expect(framePlan({ src: undefined, srcDoc: null, sandboxed: true, nonce: 0 })).toBeUndefined()
    expect(framePlan({ src: null, srcDoc: null, sandboxed: true, nonce: 0 })).toBeUndefined()
  })
})

describe('预览探针', () => {
  it('插在 <head> 之后，先于页面脚本；页面内容不变', () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" href="a.css"></head><body><script>run()</script></body></html>'
    const out = withPreviewProbe(html)
    expect(out.indexOf('data-dshws-probe')).toBeLessThan(out.indexOf('run()'))
    expect(out.replace(PROBE_SCRIPT, '')).toBe(html)
    expect(out.startsWith('<!doctype html><html><head><script data-dshws-probe>')).toBe(true)
  })

  it('没有 head 时插在 html 或 doctype 之后，不把文档推入怪异模式', () => {
    expect(withPreviewProbe('<html><body>x</body></html>').startsWith('<html><script')).toBe(true)
    expect(withPreviewProbe('<!DOCTYPE html><p>x</p>').startsWith('<!DOCTYPE html><script')).toBe(true)
    expect(withPreviewProbe('<p>x</p>').startsWith('<script')).toBe(true)
  })

  it('页面自带 CSP 时不注入；脚本是纯 ASCII（宿主端按 latin1 插入）', () => {
    const csp = '<head><meta http-equiv="Content-Security-Policy" content="script-src none"></head>'
    expect(withPreviewProbe(csp)).toBe(csp)
    expect(shouldProbe('/a/index.html', csp)).toBe(false)
    expect(/^[\x20-\x7e\n]*$/.test(PROBE_SCRIPT)).toBe(true)
  })

  it('只给 .html / .htm 注入（svg / xhtml 按 XML 解析）', () => {
    expect(shouldProbe('/a/x.HTML', null)).toBe(true)
    expect(shouldProbe('/a/x.htm', '<p>')).toBe(true)
    expect(shouldProbe('/a/x.svg', '<svg/>')).toBe(false)
    expect(shouldProbe('/a/x.xhtml', '<html/>')).toBe(false)
  })

  it('消息解析与累计：load / 报错 / 资源失败；非探针消息忽略', () => {
    expect(readProbeMessage({ kind: 'load' })).toBeUndefined()
    expect(readProbeMessage('x')).toBeUndefined()
    let s = reduceProbe(EMPTY_PROBE, readProbeMessage({ [PROBE_FLAG]: 1, kind: 'load', text: 0, elements: 0, height: 0 })!)
    expect(s).toMatchObject({ loaded: true, empty: true })
    s = reduceProbe(s, readProbeMessage({ [PROBE_FLAG]: 1, kind: 'error', message: "SecurityError: Failed to read the 'localStorage' property" })!)
    s = reduceProbe(s, readProbeMessage({ [PROBE_FLAG]: 1, kind: 'error', message: "SecurityError: Failed to read the 'localStorage' property" })!)
    s = reduceProbe(s, readProbeMessage({ [PROBE_FLAG]: 1, kind: 'resource', src: 'http://h/a.png' })!)
    expect(s.errors).toHaveLength(1)
    expect(s.resources).toEqual(['http://h/a.png'])
    expect(looksLikeSandboxDenial(s.errors[0] as string)).toBe(true)
    expect(looksLikeSandboxDenial('ReferenceError: foo is not defined')).toBe(false)
  })

  it('预览路由地址加 probe=1', () => {
    expect(withProbeQuery('/dsh-workspace/preview/t/a.html')).toBe('/dsh-workspace/preview/t/a.html?probe=1')
    expect(withProbeQuery('/x?a=1')).toBe('/x?a=1&probe=1')
  })
})
