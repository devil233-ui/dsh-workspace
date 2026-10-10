/*
 * @Description: 侧边对话的样式与会话页头按钮（由 styles.ts 的 injectStyles 一并注入）
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/styles.ts
 *
 * 原先与底部 dock 共用一个样式文件；dock 已按用户决定取消，侧边对话的部分原样搬到这里。窄屏断点与 narrow.ts 一致（640px）。
 */
export const SIDECHAT_CSS = `
.dshws-head-btn {
  display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dshws-head-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-head-btn[data-active="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshws-head-btn[data-busy="true"] { opacity: .5; cursor: progress; }
.dshws-head-btn[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }

.dshws-sidechat { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.dshws-sidechat-bar {
  display: flex; align-items: center; gap: 6px; flex: none; padding: 6px 10px; font-size: 12px; line-height: 1.4;
  color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent);
}
.dshws-sidechat-bar > .dshws-ico { flex: none; color: var(--dsw-alias-state-business-primary); }
.dshws-sidechat-bar-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dshws-sidechat-bar .dshws-link-btn { flex: none; }
.dshws-link-btn[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dshws-sidechat-body { flex: 1 1 auto; min-height: 0; display: flex; }
.dshws-sidechat-list { overflow: auto; }
.dshws-sidechat-list-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 4px; }
.dshws-sidechat-list-title { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 500; }
.dshws-sidechat-hint { padding: 0 12px 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshws-sidechat-rows { display: flex; flex-direction: column; gap: 2px; padding: 0 6px 12px; }
.dshws-sidechat-row { padding: 6px 8px; border-radius: 8px; }
.dshws-sidechat-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-sidechat-row-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshws-sidechat-row-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.dshws-sidechat-row-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshws-sidechat-row-actions { display: flex; flex-wrap: wrap; gap: 2px; margin: 2px 0 0 -4px; }

@media (max-width: 640px) {
  .dshws-sidechat-row-time { display: none; }
}
`
