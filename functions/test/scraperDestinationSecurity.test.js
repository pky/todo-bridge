// 期待する純粋API: news/scraper の isPublicScrapeAddress(address: string): boolean。
// DNSはnode:dns.lookup、通信はaxios.getを置換し、実際の名前解決・通信を行わない。
const test = require('node:test')
const assert = require('node:assert/strict')
const dns = require('node:dns')
const axios = require('axios')
const { isPublicScrapeAddress, scrapeArticle } = require('../lib/news/scraper')

for (const address of [
  '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '0.0.0.0',
  '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
]) {
  test(`記事取得先として保護対象アドレスを拒否する: ${address}`, () => {
    assert.equal(isPublicScrapeAddress(address), false)
  })
}

// 実在する公開IPの代わりに、保護対象の私設範囲に該当しない文書用IPを対照にする。
for (const address of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '2001:db8::1']) {
  test(`私設範囲に該当しない文書用アドレスを許可する: ${address}`, () => {
    assert.equal(isPublicScrapeAddress(address), true)
  })
}

function stubDns(t, resolveAddresses) {
  return t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const addresses = resolveAddresses(hostname)
    if (options?.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

function runLookup(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses)
    })
  })
}

function stubTransport(t, hostnames = ['example.com']) {
  const configurations = []
  t.mock.method(axios, 'get', async (_url, config) => {
    configurations.push(config)
    if (typeof config.lookup === 'function') {
      for (const hostname of hostnames) await runLookup(config.lookup, hostname)
    }
    return { status: 200, data: '<html><body></body></html>' }
  })
  return configurations
}

for (const protocol of ['http', 'https']) {
  test(`${protocol}で私設IPへ名前解決されるとlookup経由で取得失敗を返す`, async t => {
    const resolver = stubDns(t, () => [{ address: '10.0.0.1', family: 4 }])
    const configs = stubTransport(t)
    const out = await scrapeArticle(`${protocol}://example.com/private`)
    assert.equal(typeof configs[0]?.lookup, 'function', 'axiosにlookupが必要')
    assert.ok(resolver.mock.callCount() > 0, 'lookupがDNS判定を実行する')
    assert.deepEqual(out, { content: '', ogImage: null, fetchFailed: true })
  })

  test(`${protocol}で許可アドレスへ名前解決されると取得に成功する`, async t => {
    stubDns(t, () => [{ address: '192.0.2.1', family: 4 }])
    const configs = stubTransport(t)
    const out = await scrapeArticle(`${protocol}://example.com/public`)
    assert.equal(typeof configs[0]?.lookup, 'function', 'axiosにlookupが必要')
    assert.equal(out.fetchFailed, false)
  })
}

test('名前解決結果に許可アドレスと私設アドレスが混在したら取得失敗にする', async t => {
  stubDns(t, () => [
    { address: '192.0.2.1', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ])
  const configs = stubTransport(t)
  const out = await scrapeArticle('https://example.com/mixed')
  assert.equal(typeof configs[0]?.lookup, 'function', 'axiosにlookupが必要')
  assert.equal(out.fetchFailed, true)
})

test('リダイレクト相当の二度目の名前解決にも私設IP拒否が効く', async t => {
  let resolutions = 0
  stubDns(t, () => [{ address: ++resolutions === 1 ? '192.0.2.1' : '10.0.0.1', family: 4 }])
  const configs = stubTransport(t, ['example.com', 'example.com'])
  const out = await scrapeArticle('https://example.com/redirect')
  assert.equal(typeof configs[0]?.lookup, 'function', 'axiosにlookupが必要')
  assert.equal(resolutions, 2)
  assert.equal(out.fetchFailed, true)
})

for (const url of ['ftp://example.com/article', 'file://example.com/article', 'javascript:alert(1)']) {
  test(`http/https以外の記事URLを通信せず取得失敗にする: ${url}`, async t => {
    const get = t.mock.method(axios, 'get', async () => ({ status: 200, data: '' }))
    const out = await scrapeArticle(url)
    assert.equal(get.mock.callCount(), 0)
    assert.deepEqual(out, { content: '', ogImage: null, fetchFailed: true })
  })
}

test('私設IPへの拒否後も別記事の取得を継続できる', async t => {
  let resolutions = 0
  stubDns(t, () => [{ address: ++resolutions === 1 ? '10.0.0.1' : '192.0.2.1', family: 4 }])
  stubTransport(t)
  const rejected = await scrapeArticle('https://example.com/private')
  const accepted = await scrapeArticle('https://example.com/independent')
  assert.equal(rejected.fetchFailed, true)
  assert.equal(accepted.fetchFailed, false)
})
