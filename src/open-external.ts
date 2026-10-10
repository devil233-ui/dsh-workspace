/*
 * @Description: 用系统 URL 处理程序打开外部 URL（文件树「打开方式」的 vscode:// 等）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/open-external.ts
 *
 * 为什么在宿主端做：DSH 桌面版的渲染进程 setWindowOpenHandler 只把 http(s) / mailto 交给系统，
 * 其余协议的新窗口一律拒绝，页面里直接打开 vscode:// 没有任何反应。
 * 调用方必须先用 wire/open-with.ts 的 isAllowedExternalUrl 校验协议。
 * 不经 shell：Windows 用 rundll32 url.dll,FileProtocolHandler（不经 cmd，URL 里的 & ^ 不会被解释），
 * macOS 用 open，其他用 xdg-open。参数作为单个 argv 传入。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    return { file: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] }
  }
  if (platform === 'darwin') return { file: 'open', args: [url] }
  return { file: 'xdg-open', args: [url] }
}

/** 启动系统处理程序；进程成功启动即返回（不等待它退出）。 */
export function openExternal(url: string): Promise<void> {
  const { file, args } = openerCommand(url)
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    child.once('error', (error) => reject(new Error(`无法启动系统 URL 处理程序：${error.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
