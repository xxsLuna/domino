import { describe, expect, it } from 'vitest'
import { externalTargetError, isLoopbackHost, isPrivateHost } from './external'

describe('isLoopbackHost', () => {
  it('covers the loopback spellings', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('dev.localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.32.1.5')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
  })
  it('rejects look-alikes', () => {
    expect(isLoopbackHost('localhost.evil.example')).toBe(false)
    expect(isLoopbackHost('notlocalhost')).toBe(false)
    expect(isLoopbackHost('8.8.8.8')).toBe(false)
  })
})

describe('isPrivateHost', () => {
  it('blocks RFC1918, link-local, carrier and loopback ranges', () => {
    for (const h of [
      '0.0.0.0',
      '10.1.2.3',
      '127.5.5.5',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.9',
      '192.168.0.7',
      '::1',
      'fc00::1',
      'fd12:3456::7',
      'fe80::2',
      'router.local',
      'box.localhost'
    ]) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })
  it('blocks IPv4 written inside IPv6 and CGNAT', () => {
    // `::ffff:a.b.c.d` routes to the embedded v4 address — the URL parser
    // keeps the dotted tail, so the old hextet-only check waved it through.
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('[::ffff:169.254.169.254]')).toBe(true)
    expect(isPrivateHost('::192.168.1.9')).toBe(true)
    expect(isPrivateHost('0:0:0:0:0:ffff:10.0.0.1')).toBe(true)
    // The URL parser serializes mapped addresses in HEX: that is the form
    // that actually reaches this check from `new URL(…).hostname`.
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true)
    expect(isPrivateHost('::ffff:a9fe:a9fe')).toBe(true) // ::ffff:169.254.169.254
    expect(isPrivateHost('::ffff:808:808')).toBe(false) // ::ffff:8.8.8.8
    // CGNAT (100.64.0.0/10) is carrier-internal, never a public website.
    expect(isPrivateHost('100.64.0.1')).toBe(true)
    expect(isPrivateHost('100.127.255.9')).toBe(true)
  })
  it('leaves public space open', () => {
    for (const h of [
      '8.8.8.8',
      'example.com',
      'www.yna.co.kr',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '::ffff:8.8.8.8'
    ]) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })
})

describe('externalTargetError', () => {
  it('allows public https targets', () => {
    expect(externalTargetError('https://www.yna.co.kr/rss/news.xml')).toBeNull()
    expect(externalTargetError('  https://api.open-meteo.com/v1/forecast?lat=1&lon=2  ')).toBeNull()
  })
  it('allows plain http on this machine only', () => {
    expect(externalTargetError('http://127.0.0.1:8790/feed')).toBeNull()
    expect(externalTargetError('http://localhost:5173/x')).toBeNull()
    expect(externalTargetError('http://104.16.0.1/x')).toContain('use https')
  })
  it('blocks the SSRF ladder', () => {
    expect(externalTargetError('http://169.254.169.254/latest/meta-data/')).toContain('localhost')
    expect(externalTargetError('https://169.254.169.254/')).toContain('private')
    expect(externalTargetError('https://10.0.0.5/admin')).toContain('private')
    expect(externalTargetError('https://metadata.google.internal/')).toContain('private')
    expect(externalTargetError('https://[fd12::5]/')).toContain('private')
  })
  it('rejects non-http schemes, junk and embedded credentials', () => {
    expect(externalTargetError('file:///etc/passwd')).toContain('http(s)')
    expect(externalTargetError('not a url')).toContain('not a valid')
    expect(externalTargetError('https://user:pass@api.example.com/x')).toContain('credentials')
  })
})
