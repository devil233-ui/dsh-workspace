/*
 * @Description: 显示层脱敏规则的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/redact.test.ts
 */
import { describe, expect, it } from 'vitest'
import { maskSecret, redactSecrets } from './redact.js'

const r = (s: string): string => redactSecrets(s).text

describe('maskSecret', () => {
  it('保留首尾少量字符，中间固定星号', () => {
    expect(maskSecret('abc')).toBe('***')
    expect(maskSecret('abcdefgh')).toBe('ab******gh')
    expect(maskSecret('abcdefghijkl')).toBe('abc******jkl')
    expect(maskSecret('sk-abcdefghijklmnopqrstu')).toBe('sk-a******rstu')
  })
})

describe('redactSecrets', () => {
  it('常见令牌前缀', () => {
    expect(r('key sk-proj-abcdefghijklmnop1234 end')).toBe('key sk-p******1234 end')
    expect(r('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('ghp_******6789')
    expect(r('aws AKIAABCDEFGHIJKLMNOP')).toBe('aws AKIA******MNOP')
    expect(r('slack xoxb-1234567890-abcdef')).toBe('slack xoxb******cdef')
    expect(r('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer abcd******wxyz')
  })

  it('.env 风格：名称含 SECRET / TOKEN / KEY / PASSWORD 的值', () => {
    const env = ['OPENAI_API_KEY=abcdefghijklmnop', 'DB_PASSWORD="hunter2hunter2"', 'export JWT_SECRET=s3cr3tvalue', 'PORT=8080', 'NODE_ENV=production', 'SECRET_KEY=${VAULT_KEY}'].join('\n')
    expect(r(env).split('\n')).toEqual([
      'OPENAI_API_KEY=abcd******mnop',
      'DB_PASSWORD="hun******er2"',
      'export JWT_SECRET=s3c******lue',
      'PORT=8080',
      'NODE_ENV=production',
      'SECRET_KEY=${VAULT_KEY}'
    ])
  })

  it('YAML / JSON 键值', () => {
    expect(r('  password: correcthorse')).toBe('  password: cor******rse')
    expect(r('  "apiKey": "abcdefghijkl",')).toBe('  "apiKey": "abc******jkl",')
    expect(r('client_secret: abcdefghij')).toBe('client_secret: abc******hij')
  })

  it('普通代码不误伤', () => {
    const code = ['const token = getToken()', 'tokenCount: 5', 'primaryKey: id', 'key: home.title', 'password: process.env.DB_PASS', 'apiKey: null', 'max_tokens: 1000'].join('\n')
    const out = redactSecrets(code)
    expect(out.hit).toBe(false)
    expect(out.text).toBe(code)
  })

  it('行内 password= / token= 与 URL 口令', () => {
    expect(r('curl "https://x.io/api?token=abcdef123456&x=1"')).toBe('curl "https://x.io/api?token=abc******456&x=1"')
    expect(r('mysql --password=supersecret1 -u root')).toBe('mysql --password=sup******et1 -u root')
    expect(r('DATABASE_URL=postgres://admin:p4ssw0rd@db:5432/app')).toBe('DATABASE_URL=postgres://admin:p4******rd@db:5432/app')
  })

  it('PEM 私钥：保留首尾标记行，正文打码', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAabcdefghijklmn', 'xyz', '-----END RSA PRIVATE KEY-----', 'after=1'].join('\n')
    expect(r(pem).split('\n')).toEqual(['-----BEGIN RSA PRIVATE KEY-----', 'MIIE******klmn', '***', '-----END RSA PRIVATE KEY-----', 'after=1'])
  })

  it('保留 CRLF；无命中时原样返回同一字符串', () => {
    expect(r('TOKEN=abcdefghij\r\nA=1\r\n')).toBe('TOKEN=abc******hij\r\nA=1\r\n')
    const plain = 'hello\nworld'
    expect(redactSecrets(plain)).toEqual({ text: plain, hit: false })
  })
})
