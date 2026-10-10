/*
 * @Description: diff / AI 改动视图的敏感内容脱敏（只作用于显示层）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/redact.ts
 *
 * 为什么要脱敏：Git 侧栏会把 .env、配置文件的改动整段画到屏幕上，录屏 / 投屏 / 截图时密钥就泄露了。
 * 这里只改「给 Monaco 显示的文本」，暂存 / 提交 / 写回走的都是宿主里的真实文件，不经过本模块。
 * 规则偏保守：宁可漏掉少数非常规写法，也不把普通代码（tokenCount: 5、primaryKey = id）打成星号。
 * 这不是安全边界（同页面的其他插件照样能读原文），只是不让本插件自己把密钥显示出来。
 */

export interface RedactResult {
  text: string
  /** 是否有内容被打码（界面据此显示「显示原文」开关）。 */
  hit: boolean
}

/** 打码：保留首尾少量字符，中间换成星号（星号数量不随原长变化，不泄露长度）。 */
export function maskSecret(value: string): string {
  const n = value.length
  if (n <= 6) return '*'.repeat(Math.max(n, 3))
  const keep = n >= 16 ? 4 : n >= 10 ? 3 : 2
  return `${value.slice(0, keep)}******${value.slice(n - keep)}`
}

/** 常见服务的令牌前缀（OpenAI / Anthropic、GitHub、AWS、Slack、Google、Stripe、npm 等）。 */
const TOKEN_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g
]

/** Authorization: Bearer xxx / Basic xxx。 */
const AUTH_RE = /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9\-_.+/=]{16,})/g

/** .env 风格（全大写）的名称：含这些词即视为密钥（DB_PASSWORD、OPENAI_API_KEY、JWT_SECRET）。 */
const ENV_SECRET_NAME_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|CREDENTIAL)/
/**
 * 其他风格（YAML / JSON / INI）的名称：更严格 —— 单独的 key / token 在普通配置里太常见（i18n key、分词器 token），
 * 只认明确的组合写法。
 */
const SECRET_NAME_RE = /(secret|passw(or)?d|passwd|^pwd$|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|[_.-]key$|(access|refresh|auth|api|bearer|id)[_-]?token|^token$|credential)/i

function secretName(name: string): boolean {
  return name === name.toUpperCase() && /[A-Z]/.test(name) ? ENV_SECRET_NAME_RE.test(name) : SECRET_NAME_RE.test(name)
}

/**
 * 键值对：可选 export、可选引号包住的名称、= 或 :、值（可带引号）。
 * 名称不允许空格：`const token = x` 这类代码声明不匹配（要匹配的是配置写法）。
 */
const ASSIGN_RE = /^(\s*(?:export\s+)?["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(.*?)(\s*,?\s*)$/

/** 行内 password=xxx / secret=xxx / token=xxx（URL 查询串、连接串、命令行参数里常见）。 */
const INLINE_RE = /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)\s*=\s*)([^\s&;,'"]{4,})/gi

/** URL 里的口令：scheme://user:pass@host。 */
const URL_CRED_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi

/** 值看起来是普通代码 / 占位而不是密钥：数字、布尔、空值、变量引用、函数调用、模板。 */
function plainValue(v: string): boolean {
  return (
    v.length < 6 ||
    /^[\d.]+$/.test(v) ||
    /^(true|false|null|undefined|none|nil|yes|no)$/i.test(v) ||
    /^(process\.env|os\.environ|env\.|\$\{|\$[A-Z_]|<|\{\{|%)/.test(v) ||
    /[()\s]/.test(v) ||
    /^[*x•.]+$/i.test(v)
  )
}

/** 单行键值对的值打码；不是密钥赋值返回 undefined。 */
function redactAssignment(line: string): string | undefined {
  const m = ASSIGN_RE.exec(line)
  if (m === null) return undefined
  const [, lead, name, sep, rawValue, tail] = m as unknown as [string, string, string, string, string, string]
  if (!secretName(name)) return undefined
  // 去掉值两侧成对的引号再判断；打码后放回引号，保持语法外观。
  const q = /^(["'`])(.*)\1$/.exec(rawValue)
  const inner = q === null ? rawValue : q[2]!
  // 未加引号的值里有空格多半是代码（a = b + c），不打码；加了引号的照常判断。
  if (q === null && /\s/.test(inner)) return undefined
  if (plainValue(inner.trim())) return undefined
  const masked = maskSecret(inner)
  return `${lead}${name}${sep}${q === null ? masked : `${q[1]}${masked}${q[1]}`}${tail}`
}

/**
 * 对一段文本打码。规则：
 * 1. PEM 私钥块（-----BEGIN ... PRIVATE KEY----- 到 END）：保留首尾标记行，正文每行打码
 * 2. .env / YAML / JSON 风格的 KEY=VALUE、key: value，名称含 SECRET / TOKEN / KEY / PASSWORD 等：值打码
 * 3. 行内 password= / secret= / token= 后的值、URL 里的口令、Bearer / Basic 凭据
 * 4. 常见令牌前缀（sk-、ghp_、AKIA、xoxb- 等）
 */
export function redactSecrets(text: string): RedactResult {
  let hit = false
  let inPem = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      inPem = !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)
      continue
    }
    if (inPem) {
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
        inPem = false
        continue
      }
      const body = line.trim()
      if (body !== '') {
        // 保留缩进与行尾回车，正文整行打码（私钥任何片段都不该显示）。
        lines[i] = line.replace(body, maskSecret(body))
        hit = true
      }
      continue
    }
    let next = redactAssignment(line.replace(/\r$/, ''))
    if (next !== undefined) next += line.endsWith('\r') ? '\r' : ''
    let out = next ?? line
    out = out.replace(INLINE_RE, (_m, p: string, v: string) => (plainValue(v) ? `${p}${v}` : `${p}${maskSecret(v)}`))
    out = out.replace(URL_CRED_RE, (_m, a: string, v: string, b: string) => `${a}${maskSecret(v)}${b}`)
    out = out.replace(AUTH_RE, (_m, p: string, v: string) => `${p}${maskSecret(v)}`)
    for (const re of TOKEN_RES) out = out.replace(re, (v) => maskSecret(v))
    if (out !== line) {
      lines[i] = out
      hit = true
    }
  }
  return { text: hit ? lines.join('\n') : text, hit }
}
