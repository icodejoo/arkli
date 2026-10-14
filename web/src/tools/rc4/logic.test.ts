import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, bytesToHex, decryptText, encryptText, hexToBytes, rc4, utf8Decode, utf8Encode } from './logic'

describe('rc4', () => {
  it('公开测试向量', () => {
    expect(bytesToHex(rc4(utf8Encode('Key'), utf8Encode('Plaintext')))).toBe('BBF316E8D940AF0AD3')
    expect(bytesToHex(rc4(utf8Encode('Wiki'), utf8Encode('pedia')))).toBe('1021BF0420')
    expect(bytesToHex(rc4(utf8Encode('Secret'), utf8Encode('Attack at dawn')))).toBe('45A01F645FC35B383552544B9BF5')
  })
  it('再来一次就还原，空数据返回空', () => {
    const k = utf8Encode('k')
    const d = utf8Encode('你好 RC4')
    expect(rc4(k, rc4(k, d))).toEqual(d)
    expect(rc4(k, new Uint8Array(0)).length).toBe(0)
  })
  it('密钥长度越界抛错', () => {
    expect(() => rc4(new Uint8Array(0), new Uint8Array(1))).toThrow(RangeError)
    expect(() => rc4(new Uint8Array(257), new Uint8Array(1))).toThrow(RangeError)
    expect(rc4(new Uint8Array(256).fill(1), new Uint8Array(1)).length).toBe(1)
  })
})

describe('utf8Encode / utf8Decode', () => {
  it('往返含中文与 emoji', () => {
    expect(utf8Decode(utf8Encode('汉字😀'))).toBe('汉字😀')
    expect(Array.from(utf8Encode('A'))).toEqual([65])
  })
})

describe('hex', () => {
  it('编码为大写', () => {
    expect(bytesToHex(new Uint8Array([0, 0xbb, 15]))).toBe('00BB0F')
  })
  it('解码忽略空白和 0x，大小写不敏感', () => {
    expect(Array.from(hexToBytes('0xbb 0F')!)).toEqual([187, 15])
    expect(hexToBytes('')!.length).toBe(0)
  })
  it('奇数位或非法字符返回 null', () => {
    expect(hexToBytes('abc')).toBeNull()
    expect(hexToBytes('zz')).toBeNull()
  })
})

describe('base64', () => {
  it('编码与宽容解码', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe('SGk=')
    expect(Array.from(base64ToBytes('SGk')!)).toEqual([72, 105])
    expect(Array.from(base64ToBytes(' SGk= ')!)).toEqual([72, 105])
    expect(Array.from(base64ToBytes('-_8')!)).toEqual([251, 255])
  })
  it('非法输入返回 null', () => {
    expect(base64ToBytes('a')).toBeNull()
    expect(base64ToBytes('!!!!')).toBeNull()
    expect(base64ToBytes('')!.length).toBe(0)
  })
})

describe('encryptText / decryptText', () => {
  it('十六进制与 Base64 往返', () => {
    expect(encryptText('Key', 'Plaintext', 'hex')).toEqual({ ok: true, text: 'BBF316E8D940AF0AD3' })
    for (const enc of ['hex', 'base64'] as const) {
      const c = encryptText('密钥', '你好，世界', enc)
      expect(c.ok).toBe(true)
      if (c.ok) expect(decryptText('密钥', c.text, enc)).toEqual({ ok: true, text: '你好，世界' })
    }
  })
  it('空密钥、超长密钥给提示', () => {
    expect(encryptText('', 'a', 'hex').ok).toBe(false)
    expect(decryptText('', 'AA', 'hex').ok).toBe(false)
    expect(encryptText('a'.repeat(257), 'a', 'hex').ok).toBe(false)
  })
  it('密文格式错给提示', () => {
    const h = decryptText('k', 'xyz', 'hex')
    expect(h.ok === false && h.error).toContain('十六进制')
    const b = decryptText('k', '!!!', 'base64')
    expect(b.ok === false && b.error).toContain('Base64')
  })
  it('密钥不对解出乱码但不抛错', () => {
    const c = encryptText('a', 'hello', 'hex')
    if (c.ok) expect(decryptText('b', c.text, 'hex').ok).toBe(true)
  })
})
