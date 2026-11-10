const test = require('node:test')
const assert = require('node:assert/strict')
const { isPublicScrapeAddress } = require('../lib/news/scraper')

for (const address of [
  'fec0::1',
  '64:ff9b::7f00:1',
  '64:ff9b::a00:1',
  '2002:7f00:1::',
  '2002:a00:1::',
]) {
  test(`サイトローカルまたは内部IPv4を埋め込んだIPv6を拒否する: ${address}`, () => {
    assert.equal(isPublicScrapeAddress(address), false)
  })
}

for (const address of ['64:ff9b::5db8:d822', '2002:5db8:d822::', '2001:db8::1']) {
  test(`公開IPv4を埋め込んだIPv6と通常のIPv6を許可する: ${address}`, () => {
    assert.equal(isPublicScrapeAddress(address), true)
  })
}
