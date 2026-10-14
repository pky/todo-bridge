const UTF8_BOM = [0xef, 0xbb, 0xbf]

function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte) ? bytes.subarray(3) : bytes
}

// サーバー側の decodeTextDocument と同じ方針。UTF-8 で厳密に読めなければ Shift_JIS として読む
export function decodeTextDocument(data: ArrayBuffer): string {
  const body = stripUtf8Bom(new Uint8Array(data))
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    text = new TextDecoder('shift_jis').decode(body)
  }
  return text.replace(/\r\n?/g, '\n')
}
