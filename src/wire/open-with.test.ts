/*
 * @Description: 「打开方式」的测试 —— 内置编辑器 URL、模板变量展开与编码、模板规范化、宿主端协议白名单
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/wire/open-with.test.ts
 */
import { describe, expect, it } from 'vitest'
import { builtinOpeners, encodePathForUrl, expandTemplate, isAllowedExternalUrl, normalizeOpenWith, schemeOf, templateProblem } from './open-with.js'
import { openerCommand } from '../open-external.js'

describe('builtinOpeners', () => {
  it('本机：Windows 盘符与 POSIX 路径都写成 scheme://file/<路径>，空格等逐段编码', () => {
    const win = builtinOpeners({ path: 'C:/My Proj/a.ts', remote: false })
    expect(win.map((o) => o.url)).toEqual(['vscode://file/C:/My%20Proj/a.ts', 'cursor://file/C:/My%20Proj/a.ts', 'zed://file/C:/My%20Proj/a.ts'])
    expect(builtinOpeners({ path: '/home/me/x#1.md', remote: false })[0]?.url).toBe('vscode://file/home/me/x%231.md')
  })

  it('远程：VS Code / Cursor 走 vscode-remote/ssh-remote+user@host，Zed 走 zed://ssh（非 22 端口带端口）', () => {
    const urls = builtinOpeners({ path: '/home/ps/app/main.go', remote: true, host: '10.0.0.5', user: 'ps', port: 2222 }).map((o) => o.url)
    expect(urls).toEqual([
      'vscode://vscode-remote/ssh-remote+ps@10.0.0.5/home/ps/app/main.go',
      'cursor://vscode-remote/ssh-remote+ps@10.0.0.5/home/ps/app/main.go',
      'zed://ssh/ps@10.0.0.5:2222/home/ps/app/main.go'
    ])
    expect(builtinOpeners({ path: '/x', remote: true, host: 'h', port: 22 })[2]?.url).toBe('zed://ssh/h/x')
    // 主机信息还没取到：不提供远程编辑器项
    expect(builtinOpeners({ path: '/x', remote: true })).toEqual([])
  })
})

describe('expandTemplate', () => {
  it('{path} 逐段编码保留 /，{host} {user} 整体编码，{port} 原样；本机 host 为 localhost', () => {
    expect(expandTemplate('idea://open?file={path}&h={host}&u={user}&p={port}', { path: '/a b/c&d', remote: true, host: 'h.example', user: 'u@x', port: 22 })).toBe(
      'idea://open?file=/a%20b/c%26d&h=h.example&u=u%40x&p=22'
    )
    expect(expandTemplate('x://{host}{path}', { path: 'C:/w/a.ts', remote: false })).toBe('x://localhostC:/w/a.ts')
    expect(expandTemplate('x://{unknown}', { path: '/', remote: false })).toBe('x://{unknown}')
  })
  it('encodePathForUrl 只保留开头的盘符冒号', () => {
    expect(encodePathForUrl('/C:/a:b')).toBe('/C:/a%3Ab')
    expect(encodePathForUrl('C:/x')).toBe('C:/x')
  })
})

describe('模板与白名单', () => {
  it('schemeOf / templateProblem', () => {
    expect(schemeOf('VSCode://x')).toBe('vscode')
    expect(schemeOf('/no/scheme')).toBeUndefined()
    expect(templateProblem('idea://open?file={path}')).toBeUndefined()
    expect(templateProblem('{path}')).toBe('missing-scheme')
    expect(templateProblem('file:///{path}')).toBe('denied-scheme')
    expect(templateProblem('ms-msdt:/id')).toBe('denied-scheme')
    expect(templateProblem('javascript:alert(1)')).toBe('denied-scheme')
  })

  it('normalizeOpenWith：丢弃非法项、截断名称、最多 20 条', () => {
    const out = normalizeOpenWith([
      { name: ' IDEA ', template: 'idea://open?file={path}' },
      { name: '', template: 'x://y' },
      { name: 'bad', template: 'file:///x' },
      'junk',
      { name: 'x'.repeat(80), template: 'y://z' }
    ])
    expect(out).toEqual([
      { name: 'IDEA', template: 'idea://open?file={path}' },
      { name: 'x'.repeat(40), template: 'y://z' }
    ])
    expect(normalizeOpenWith(Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, template: 'a://b' })))).toHaveLength(20)
    expect(normalizeOpenWith(null)).toEqual([])
  })

  it('isAllowedExternalUrl：内置协议放行；模板协议需已保存；禁用协议与空白 / 控制字符一律拒绝', () => {
    const tpl = [{ name: 'IDEA', template: 'idea://open?file={path}' }]
    expect(isAllowedExternalUrl('vscode://file/C:/a', [])).toBe(true)
    expect(isAllowedExternalUrl('https://example.com', [])).toBe(true)
    expect(isAllowedExternalUrl('idea://open?file=/a', [])).toBe(false)
    expect(isAllowedExternalUrl('idea://open?file=/a', tpl)).toBe(true)
    expect(isAllowedExternalUrl('file:///etc/passwd', [{ name: 'f', template: 'file:///{path}' }])).toBe(false)
    expect(isAllowedExternalUrl('search-ms:query=x', [])).toBe(false)
    expect(isAllowedExternalUrl('vscode://file/a b', [])).toBe(false)
    expect(isAllowedExternalUrl('vscode://file/a\n', [])).toBe(false)
  })

  it('openerCommand：不经 shell，URL 作为单个参数', () => {
    expect(openerCommand('vscode://file/a&b', 'win32').args).toEqual(['url.dll,FileProtocolHandler', 'vscode://file/a&b'])
    expect(openerCommand('x://y', 'darwin')).toEqual({ file: 'open', args: ['x://y'] })
    expect(openerCommand('x://y', 'linux')).toEqual({ file: 'xdg-open', args: ['x://y'] })
  })
})
