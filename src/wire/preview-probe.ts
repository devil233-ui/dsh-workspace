/*
 * @Description: HTML 预览探针 —— 往预览页注入一小段脚本，把「已加载 / 脚本报错 / 资源加载失败 / 空页面」回报给查看器
 * @Author: YangHeng
 * @Date: 2026-10-12 17:50:00
 * @FilePath: /dsh-workspace/src/wire/preview-probe.ts
 *
 * 为什么需要：沙箱预览页是不透明源，父页面读不到它的 DOM，也看不到它的报错；页面出问题时用户只看到一片白，
 * 无从判断是脚本崩了（例如沙箱里访问 localStorage 抛 SecurityError）、资源缺失，还是页面根本没加载。
 * 探针只做 postMessage 回报，不改页面行为；页面自带 CSP（meta http-equiv）时不注入，避免被拦截后误报「未加载」。
 *
 * 浏览器端（桌面版 srcdoc 内联）与宿主端（网页版预览路由）共用：脚本保持纯 ASCII，
 * 宿主端可以按 latin1 在原始字节里插入，不必关心页面本身的编码。
 */

/** 探针消息的标记字段（与页面自己的 postMessage 区分）。 */
export const PROBE_FLAG = '__dshwsPreviewProbe'

export type ProbeMessage =
  | { kind: 'load'; text: number; elements: number; height: number; scripts: number }
  | { kind: 'error'; message: string }
  | { kind: 'resource'; src: string }

/** 注入的脚本：同步注册监听（最先执行，能接到页面后续脚本的报错）；load 后稍等再统计，给页面脚本渲染留时间。 */
export const PROBE_SCRIPT = `<script data-dshws-probe>(function(){var F=${JSON.stringify(PROBE_FLAG)};function s(m){m[F]=1;try{parent.postMessage(m,'*')}catch(e){}}
addEventListener('error',function(e){var t=e.target;var el=t&&t!==window&&t.tagName;var src=el&&(t.src||t.href);if(src)s({kind:'resource',src:String(src).slice(0,300)});else if(el==='SCRIPT')s({kind:'error',message:'Inline module script failed to load its imports'});else s({kind:'error',message:String(e.message||'error')})},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;s({kind:'error',message:String(r&&r.message||r)})});
addEventListener('load',function(){setTimeout(function(){var b=document.body,n=0,k=0,a=b?b.getElementsByTagName('*'):[],i;for(i=0;i<a.length;i++)if(!/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META|BASE)$/.test(a[i].tagName))n++;for(i=0;i<document.scripts.length;i++)if(!document.scripts[i].hasAttribute('data-dshws-probe'))k++;
s({kind:'load',text:b?(b.innerText||'').trim().length:0,elements:n,height:document.documentElement.scrollHeight,scripts:k})},300)})})()</script>`

/** 页面自带 CSP 时不注入（内联脚本可能被拦）。 */
export function hasOwnCsp(html: string): boolean {
  return /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(html)
}

/** 探针插入位置：<head> 之后；没有就 <html> 之后；再没有就 doctype 之后（避免把文档推入怪异模式）；都没有放最前。 */
export function probeInsertAt(html: string): number {
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i]) {
    const m = re.exec(html)
    if (m !== null) return m.index + m[0].length
  }
  return 0
}

/**
 * 注入探针（保证先于页面脚本执行）。
 * @returns 注入后的页面；页面自带 CSP 时原样返回。
 */
export function withPreviewProbe(html: string): string {
  if (hasOwnCsp(html)) return html
  const at = probeInsertAt(html)
  return `${html.slice(0, at)}${PROBE_SCRIPT}${html.slice(at)}`
}

/** 解析探针消息；不是探针发的返回 undefined。 */
export function readProbeMessage(data: unknown): ProbeMessage | undefined {
  if (typeof data !== 'object' || data === null || (data as Record<string, unknown>)[PROBE_FLAG] !== 1) return undefined
  const d = data as Record<string, unknown>
  if (d.kind === 'error') return { kind: 'error', message: String(d.message ?? '') }
  if (d.kind === 'resource') return { kind: 'resource', src: String(d.src ?? '') }
  if (d.kind === 'load') return { kind: 'load', text: Number(d.text) || 0, elements: Number(d.elements) || 0, height: Number(d.height) || 0, scripts: Number(d.scripts) || 0 }
  return undefined
}
