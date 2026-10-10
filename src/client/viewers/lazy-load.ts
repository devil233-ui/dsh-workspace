/*
 * @Description: 按需加载查看器资源（lib/assets/viewers/*.js，ESM + 分片）—— 浏览器原生 import() 按 URL 加载
 * @Author: YangHeng
 * @Date: 2026-10-10 11:40:00
 * @FilePath: /dsh-workspace/src/client/viewers/lazy-load.ts
 *
 * 资源由插件的 /dsh-workspace/assets 路由托管（见 src/assets-route.ts 的 viewers 子树）。
 * 用页面同源的地址：桌面版（dsh-app://app）只给主框架的同源请求附令牌，直连宿主 http 地址会被拒。
 * 分片之间是相对路径互相 import，所以不能像 Monaco 那样转成 blob 地址 —— 这是选 HTTP 路由而不是远程调用分段下发的原因。
 */
import { VERSION } from '../build-info.js'
import type * as FileViewerEntry from './lazy/file-viewer-entry.js'
import type * as MarkdownExtrasEntry from './lazy/markdown-extras-entry.js'

/** 与宿主 assets-route.ts 的 ASSETS_PREFIX 一致（浏览器 bundle 不能 import 宿主文件）。 */
export const VIEWER_ASSETS_BASE = '/dsh-workspace/assets/viewers/'

interface Entries {
  'file-viewer': typeof FileViewerEntry
  'markdown-extras': typeof MarkdownExtrasEntry
}

const loading = new Map<keyof Entries, Promise<unknown>>()

/** 资源目录的绝对地址（以 / 结尾）。 */
export function viewerAssetsUrl(sub = ''): string {
  return new URL(`${VIEWER_ASSETS_BASE}${sub}`, window.location.href).href
}

/**
 * 加载一个入口；并发调用共享同一次加载，失败不缓存（宿主正在重载插件时可重试）。
 * 写成间接调用：打包器看到字面量 import('...') 会试图把它解析成本地模块打进 client.js，而这里要的是运行时按 URL 加载。
 */
export function loadViewerEntry<K extends keyof Entries>(name: K): Promise<Entries[K]> {
  const hit = loading.get(name)
  if (hit !== undefined) return hit as Promise<Entries[K]>
  const url = viewerAssetsUrl(`${name}.js?v=${encodeURIComponent(VERSION)}`)
  const p = dynamicImport(url).catch((error: unknown) => {
    loading.delete(name)
    throw new Error(`查看器资源加载失败（${url}）：${error instanceof Error ? error.message : String(error)}`)
  }) as Promise<Entries[K]>
  loading.set(name, p)
  return p
}

function dynamicImport(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ url)
}
