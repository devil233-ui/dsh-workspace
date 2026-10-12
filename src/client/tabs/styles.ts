/*
 * @Description: 右侧栏标签右键菜单插件项的样式（由 styles.ts 的 injectStyles 一并注入）
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/styles.ts
 *
 * 为什么自写：宿主菜单项的类名是 CSS Module 哈希（每次构建都变），只能照着宿主 [data-dockkit-tab-menu] [role=menuitem] 的取值复刻：
 * padding 4px 7px、字号 = 次要字号 - 1px、圆角 md、悬停背景 interactive-bg-hover。菜单挂在 document.body 的 portal 里，全局样式可达。
 * 隐藏固定标签关闭按钮的规则按会话 + tabId 动态生成，不在这里（见 pins.ts 的 pinCss）。
 */
export const TABS_CSS = `
[data-dockkit-tab-menu] .dshws-tabmenu-item {
  padding: 4px 7px; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  text-align: left; white-space: nowrap; background: transparent; border: none; border-radius: var(--dsw-radius-md, 6px); cursor: pointer;
}
[data-dockkit-tab-menu] .dshws-tabmenu-item:hover:not([aria-disabled="true"]),
[data-dockkit-tab-menu] .dshws-tabmenu-item:focus-visible:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
[data-dockkit-tab-menu] .dshws-tabmenu-item[aria-disabled="true"] { color: var(--dsw-alias-label-tertiary); cursor: default; }
[data-dockkit-tab-menu] .dshws-tabmenu-sep { height: 0; margin: 4px 2px; border-top: .5px solid var(--dsw-alias-border-l2); }
`
