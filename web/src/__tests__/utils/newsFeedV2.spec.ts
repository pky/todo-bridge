import { describe, expect, it } from 'vitest'
import contract from '../../../../functions/test/fixtures/aiFeedV2Contract.json'
import { AI_FEED_V2_MAX_BYTES, parseAiFeedV2 } from '@/utils/newsFeedV2'

const encoder = new TextEncoder()
const emptyFeed = contract.validFeeds[0]!.feed
const threeFeed = contract.validFeeds[1]!.feed

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

describe('AIニュースv2の共有契約', () => {
  it('受信サイズ上限は非圧縮1MiB', () => {
    expect(AI_FEED_V2_MAX_BYTES).toBe(1048576)
  })

  for (const scenario of contract.validFeeds) {
    it(`Uint8Arrayで有効な共有fixtureを受理する: ${scenario.name}`, () => {
      expect(parseAiFeedV2(encode(scenario.feed))).toEqual({ ok: true, feed: scenario.feed })
    })

    it(`ArrayBufferで有効な共有fixtureを受理する: ${scenario.name}`, () => {
      expect(parseAiFeedV2(toArrayBuffer(encode(scenario.feed)))).toEqual({ ok: true, feed: scenario.feed })
    })
  }

  for (const scenario of contract.invalidFeeds) {
    it(`不正な共有fixtureを拒否する: ${scenario.reason}`, () => {
      expect(parseAiFeedV2(encode(scenario.feed))).toEqual({ ok: false, reason: scenario.expectedParseReason })
    })
  }

  it('revisionは形式を検証し、本文から再計算しない', () => {
    const feed = { ...structuredClone(threeFeed), revision: '0'.repeat(64) }
    expect(parseAiFeedV2(encode(feed))).toEqual({ ok: true, feed })
  })

  it('上限ちょうど20件の記事を受理する', () => {
    const feed = {
      ...structuredClone(threeFeed),
      totalCount: 20,
      articles: Array.from({ length: 20 }, (_, i) => ({ ...threeFeed.articles[1]!, id: `fictional-${i}` })),
    }
    expect(parseAiFeedV2(encode(feed))).toEqual({ ok: true, feed })
  })

  it('Uint8ArrayのbyteOffsetとbyteLengthが示す領域だけを読む', () => {
    const bytes = encode(threeFeed)
    const framed = new Uint8Array(bytes.byteLength + 8).fill(0xff)
    framed.set(bytes, 4)
    expect(parseAiFeedV2(framed.subarray(4, 4 + bytes.byteLength))).toEqual({ ok: true, feed: threeFeed })
  })

  it('大きな背後のbufferではなく部分領域のbyteLengthで上限を判定する', () => {
    const bytes = encode(emptyFeed)
    const framed = new Uint8Array(1048577).fill(0xff)
    framed.set(bytes, 4)
    expect(parseAiFeedV2(framed.subarray(4, 4 + bytes.byteLength))).toEqual({ ok: true, feed: emptyFeed })
  })

  it('末尾のJSON空白を含むちょうど1MiBの入力を受理する', () => {
    const bytes = new Uint8Array(1048576).fill(0x20)
    bytes.set(encode(emptyFeed))
    expect(parseAiFeedV2(bytes)).toEqual({ ok: true, feed: emptyFeed })
    expect(parseAiFeedV2(toArrayBuffer(bytes))).toEqual({ ok: true, feed: emptyFeed })
  })

  it('1MiBを1バイト超える入力はJSON解析前にtoo-largeにする', () => {
    const bytes = new Uint8Array(1048577).fill(0x20)
    expect(parseAiFeedV2(bytes)).toEqual({ ok: false, reason: 'too-large' })
    expect(parseAiFeedV2(toArrayBuffer(bytes))).toEqual({ ok: false, reason: 'too-large' })
  })

  it('多バイト文字を含むJSONは文字数ではなくUTF-8バイト数で上限を判定する', () => {
    const feed = structuredClone(threeFeed)
    feed.articles[0]!.summary = 'あ'.repeat(350000)
    const json = JSON.stringify(feed)
    expect(json.length).toBeLessThan(1048576)
    const bytes = encoder.encode(json)
    expect(bytes.byteLength).toBeGreaterThan(1048576)
    expect(parseAiFeedV2(bytes)).toEqual({ ok: false, reason: 'too-large' })
  })

  for (const [name, json] of [
    ['空', ''],
    ['閉じ括弧が欠落', '{"schemaVersion":2'],
    ['JSONでない文字列', 'not-json'],
    ['JSONが二つ連結', `${JSON.stringify(emptyFeed)}${JSON.stringify(emptyFeed)}`],
  ]) {
    it(`JSONとして解析できない入力はinvalid-jsonにする: ${name}`, () => {
      expect(parseAiFeedV2(encoder.encode(json))).toEqual({ ok: false, reason: 'invalid-json' })
    })
  }

  it('JSON文字列内の不正なUTF-8を置換文字へ変えずinvalid-jsonにする', () => {
    const feed = structuredClone(threeFeed)
    feed.articles[0]!.summary = 'utf8-marker'
    const [prefix, suffix] = JSON.stringify(feed).split('utf8-marker')
    const before = encoder.encode(prefix!)
    const after = encoder.encode(suffix!)
    // 2バイト文字の先頭にASCIIを続けた不正列。置換decodeなら有効なJSONと記事概要になる。
    const bytes = new Uint8Array(before.byteLength + 2 + after.byteLength)
    bytes.set(before)
    bytes.set([0xc3, 0x28], before.byteLength)
    bytes.set(after, before.byteLength + 2)
    expect(parseAiFeedV2(bytes)).toEqual({ ok: false, reason: 'invalid-json' })
    expect(parseAiFeedV2(toArrayBuffer(bytes))).toEqual({ ok: false, reason: 'invalid-json' })
  })

  it('文字列内で途中までのUTF-8列もinvalid-jsonにする', () => {
    const bytes = new Uint8Array([...encoder.encode('{"title":"'), 0xe3, 0x81])
    expect(parseAiFeedV2(bytes)).toEqual({ ok: false, reason: 'invalid-json' })
  })

  for (const schemaVersion of [1, 3, '2', null]) {
    it(`schemaVersionが2以外ならunsupported-versionにする: ${String(schemaVersion)}`, () => {
      const feed = { ...structuredClone(emptyFeed), schemaVersion }
      expect(parseAiFeedV2(encode(feed))).toEqual({ ok: false, reason: 'unsupported-version' })
    })
  }

  for (const value of [null, [], 'feed', 2]) {
    it(`feedオブジェクト以外のJSONを成功扱いしない: ${JSON.stringify(value)}`, () => {
      expect(parseAiFeedV2(encode(value)).ok).toBe(false)
    })
  }
})
