const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function stripUtf8Bom(original: Buffer): Buffer {
  return original.subarray(0, 3).equals(UTF8_BOM) ? original.subarray(3) : original
}

// UTF-8 で厳密に読めなければ Windows 由来の Shift_JIS として読む
export function decodeTextDocument(original: Buffer): string {
  const body = stripUtf8Bom(original)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    text = new TextDecoder('shift_jis').decode(body)
  }
  return text.replace(/\r\n?/g, '\n')
}
