const { fetchOfficialMobileHtmlArticles } = require('../lib/news/fetchers/mobileOfficialFetcher')
const { fetchMobileRssArticles } = require('../lib/news/fetchers/mobileRssFetcher')

async function main() {
  const [htmlArticles, rssArticles] = await Promise.all([
    fetchOfficialMobileHtmlArticles(),
    fetchMobileRssArticles(),
  ])
  const allArticles = [...htmlArticles, ...rssArticles]
  const countsBySource = allArticles.reduce((acc, article) => {
    acc[article.sourceName] = (acc[article.sourceName] ?? 0) + 1
    return acc
  }, {})

  console.log('[verify-mobile-sources] official html:', htmlArticles.length)
  console.log('[verify-mobile-sources] rss/atom:', rssArticles.length)
  console.log('[verify-mobile-sources] by source:', JSON.stringify(countsBySource))

  for (const article of [...htmlArticles.slice(0, 3), ...rssArticles.slice(0, 3)]) {
    console.log(JSON.stringify({
      title: article.title,
      sourceName: article.sourceName,
      url: article.url,
      platform: article.platform,
      sourceTier: article.sourceTier,
      actionRequired: article.actionRequired,
      actionType: article.actionType,
    }))
  }
}

main().catch((err) => {
  console.error('[verify-mobile-sources] failed:', err)
  process.exitCode = 1
}).finally(() => {
  process.exit()
})
