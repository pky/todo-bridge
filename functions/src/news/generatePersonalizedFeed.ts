// functions/src/news/generatePersonalizedFeed.ts
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { summarizeArticle } from './geminiService'
import type { NewsArticle, NewsPreferences, NewsTopic } from './types'

// ひらがな・カタカナを含む場合のみ日本語と判定（漢字のみはCJK全般に含まれるため除外）
function isJapanese(text: string): boolean {
  return /[\u3040-\u30FF]/.test(text)
}

const db = admin.firestore()

// 日本語テキストに混在する英語技術用語も含めて抽出（3文字以上、ストップワード除外）
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how',
  'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did',
  'let', 'put', 'say', 'she', 'too', 'use',
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'more', 'also',
  'into', 'they', 'been', 'were', 'what', 'when', 'which', 'about', 'their',
  'than', 'then', 'them', 'some', 'just', 'like', 'other', 'over', 'only',
  'news', 'said', 'says', 'show', 'shows', 'using', 'used', 'make', 'made',
  'http', 'https', 'year', 'week', 'time', 'data', 'model', 'models',
])

function extractKeywords(text: string): string[] {
  // 小文字化して英字シーケンスを正規表現で直接抽出
  // 日本語テキスト内の "Claude" "LLM" "RAG" なども拾える
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  return words.filter(w => !STOP_WORDS.has(w))
}

interface ClickData {
  titleEn?: string
  summaryJa?: string
  tags?: string[]
}

function learnKeywordsFromClicks(clicks: ClickData[]): string[] {
  const freq = new Map<string, number>()
  for (const click of clicks) {
    // 1. Geminiが抽出したタグがあればそれを最優先で学習
    if (click.tags && click.tags.length > 0) {
      for (const tag of click.tags) {
        const kw = tag.toLowerCase()
        freq.set(kw, (freq.get(kw) ?? 0) + 1)
      }
    }
    // 2. 従来通り、タイトルと要約からも補完的にキーワードを抽出
    const text = [click.titleEn, click.summaryJa].filter(Boolean).join(' ')
    for (const kw of extractKeywords(text)) {
      freq.set(kw, (freq.get(kw) ?? 0) + 1)
    }
  }
  // 2回以上出現したキーワードを嗜好として採用
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .map(([word]) => word)
}

function calcDisplayScore(
  article: NewsArticle,
  preferences: NewsPreferences,
  maxHnScore: number,
  maxGithubScore: number,
  learnedKeywords: string[]
): number {
  // 1. 人気スコア (0-100)
  let popularityScore: number
  if (article.source === 'hn' && article.score !== null && maxHnScore > 0) {
    popularityScore = Math.min((article.score / maxHnScore) * 100, 100)
  } else if (article.source === 'github' && article.score !== null && maxGithubScore > 0) {
    // GitHub: 本日のスター獲得数をバッチ内最大値で正規化、50-100 の範囲に
    popularityScore = 50 + Math.min((article.score / maxGithubScore) * 50, 50)
  } else {
    popularityScore = 40 // RSSベースライン
  }

  // 2. 嗜好マルチプライヤー (1.0 - 2.5)
  // titleJa/summaryJaはGemini翻訳後に設定されるため、未翻訳時はtitle/descriptionで代用
  const text = `${article.titleJa ?? ''} ${article.summaryJa ?? ''} ${article.title} ${article.description ?? ''}`.toLowerCase()
  let preferenceMultiplier = 1.0

  // 手動設定キーワード
  for (const kw of preferences.keywords) {
    if (text.includes(kw.word.toLowerCase())) {
      preferenceMultiplier = Math.max(preferenceMultiplier, kw.weight)
    }
  }

  // クリック履歴から学習したキーワード
  for (const kw of learnedKeywords) {
    if (text.includes(kw)) {
      preferenceMultiplier = Math.max(preferenceMultiplier, 1.5)
    }
  }

  return popularityScore * preferenceMultiplier
}

function calcMobileDisplayScore(
  article: NewsArticle,
  preferences: NewsPreferences,
  learnedKeywords: string[]
): number {
  const text = `${article.titleJa ?? ''} ${article.summaryJa ?? ''} ${article.title} ${article.description ?? ''}`.toLowerCase()
  const preferredPlatforms = preferences.platforms ?? ['ios', 'android']

  if (article.platform && article.platform !== 'cross' && !preferredPlatforms.includes(article.platform)) {
    return -1
  }

  if (preferences.officialOnly === true && article.isOfficial !== true) {
    return -1
  }

  if (preferences.includeCommunity === false && article.sourceTier === 'community-rss') {
    return -1
  }

  if (preferences.actionRequiredOnly === true && article.actionRequired !== true) {
    return -1
  }

  let score = 0

  switch (article.sourceTier) {
    case 'official':
      score += 60
      break
    case 'official-rss':
      score += 50
      break
    case 'community-rss':
      score += 20
      break
    default:
      score += article.isOfficial ? 50 : 20
      break
  }

  if (article.actionRequired) {
    score += 40
  }

  switch (article.importantLevel) {
    case 'urgent':
      score += 35
      break
    case 'review':
      score += 18
      break
    case 'reference':
      score += 0
      break
  }

  if (article.requiredByDate) {
    score += 20
  }

  switch (article.actionType) {
    case 'sdk_requirement':
      score += 30
      break
    case 'policy':
    case 'play_policy':
      score += 30
      break
    case 'security':
      score += 25
      break
    case 'beta':
      score += 15
      break
    case 'release':
      score += 10
      break
    default:
      break
  }

  for (const kw of preferences.keywords) {
    if (text.includes(kw.word.toLowerCase())) {
      score *= Math.max(kw.weight, 1)
    }
  }

  for (const kw of learnedKeywords) {
    if (text.includes(kw)) {
      score += 15
    }
  }

  const ageMs = Date.now() - article.publishedAt.toDate().getTime()
  const ageDays = Math.max(ageMs / (24 * 60 * 60 * 1000), 0)
  score -= Math.min(ageDays * 5, 20)

  return score
}

function isInteractionForTopic(topic: NewsTopic, data: FirebaseFirestore.DocumentData): boolean {
  const interactionTopic = data.topic as NewsTopic | undefined
  return !interactionTopic ? topic === 'ai' : interactionTopic === topic
}

export const generatePersonalizedFeed = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '256MB', secrets: ['GEMINI_API_KEY'] })
  .pubsub.schedule('30 6 * * *').timeZone('Asia/Tokyo')  // collectArticlesの30分後（JST 6:30）
  .onRun(async () => {
    console.log('[generatePersonalizedFeed] Starting...')
    const topic: NewsTopic = 'ai'

    // JST日付を使用（UTC 21:xx は JST 翌朝6:xx）
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // 1. 今日の記事を共有プールから取得
    const articlesSnap = await db.collection(`topics/${topic}/articles`)
      .where('date', '==', today)
      .get()

    if (articlesSnap.empty) {
      console.log('[generatePersonalizedFeed] No articles for today')
      return
    }

    // URL重複を排除
    const seenUrls = new Set<string>()
    const articles = articlesSnap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as NewsArticle) }))
      .filter(a => {
        if (seenUrls.has(a.url)) return false
        seenUrls.add(a.url)
        return true
      })

    // HN・GitHubの最大スコアを算出（人気スコア正規化用）
    const maxHnScore = articles
      .filter(a => a.source === 'hn' && a.score !== null)
      .reduce((max, a) => Math.max(max, a.score!), 1)
    const maxGithubScore = articles
      .filter(a => a.source === 'github' && a.score !== null)
      .reduce((max, a) => Math.max(max, a.score!), 1)

    // 2. 全ユーザーのnewsPreferencesを取得
    const usersSnap = await db.collection('users').get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const [prefDoc, interactionsSnap] = await Promise.all([
          db.doc(`users/${uid}/newsPreferences/${topic}`).get(),
          db.collection(`users/${uid}/newsInteractions`).get(),
        ])

        const preferences: NewsPreferences = prefDoc.exists
          ? (prefDoc.data() as NewsPreferences)
          : { keywords: [] }

        // 除外済み記事IDと除外済みURL、クリック済み記事データを収集
        const dismissedIds = new Set<string>()
        const excludedUrls = new Set<string>()  // dismissed + clicked のURL（翌日再収集対策）
        const shownCountByUrl = new Map<string, number>()
        const clicks: ClickData[] = []

        for (const intDoc of interactionsSnap.docs) {
          const data = intDoc.data()
          if (!isInteractionForTopic(topic, data)) continue

          const interactionArticleId = typeof data.articleId === 'string' ? data.articleId : intDoc.id
          if (data.dismissed === true) {
            dismissedIds.add(interactionArticleId)
            if (data.url) excludedUrls.add(data.url as string)
          }
          if (data.clickedAt) {
            // クリック済みURLも翌日以降は除外（同URLが再収集された場合もブロック）
            if (data.url) excludedUrls.add(data.url as string)
            clicks.push({
              titleEn: data.titleEn as string | undefined,
              summaryJa: data.summaryJa as string | undefined,
              tags: data.tags as string[] | undefined,
            })
          }
          if (data.url && typeof data.shownCount === 'number') {
            shownCountByUrl.set(
              data.url as string,
              (shownCountByUrl.get(data.url as string) ?? 0) + data.shownCount
            )
          }
        }

        for (const [url, shownCount] of shownCountByUrl.entries()) {
          if (shownCount >= 2) {
            excludedUrls.add(url)
          }
        }

        // クリック履歴からキーワードを学習
        const learnedKeywords = learnKeywordsFromClicks(clicks)
        if (learnedKeywords.length > 0) {
          console.log(`[generatePersonalizedFeed] Learned keywords for ${uid}:`, learnedKeywords.slice(0, 10))
        }

        // 3. 除外済みを取り除いてスコア計算（IDベース + URLベースの両方でフィルタ）
        const scored = articles
          .filter(a => !dismissedIds.has(a.id) && !excludedUrls.has(a.url))
          .map(article => ({
            article, // 記事オブジェクト全体を保持
            displayScore: calcDisplayScore(article, preferences, maxHnScore, maxGithubScore, learnedKeywords),
            source: article.source,
            sourceName: article.sourceName,
          }))

        // B案: HN(10) + GitHub(8) + Zenn/Qiita(12) + その他RSS(10) = 40件
        const sort = (arr: typeof scored) => arr.sort((a, b) => b.displayScore - a.displayScore)

        const hnTop = sort(scored.filter(a => a.source === 'hn')).slice(0, 10)
        const githubTop = sort(scored.filter(a => a.source === 'github')).slice(0, 8)
        const japaneseTop = sort(
          scored.filter(a => a.sourceName.startsWith('Zenn') || a.sourceName.startsWith('Qiita'))
        ).slice(0, 12)
        const otherRssTop = sort(
          scored.filter(a => a.source !== 'hn' && a.source !== 'github'
            && !a.sourceName.startsWith('Zenn') && !a.sourceName.startsWith('Qiita'))
        ).slice(0, 10)

        // 合算して再ソート（計40件）
        const ranked = [...hnTop, ...githubTop, ...japaneseTop, ...otherRssTop]
          .sort((a, b) => b.displayScore - a.displayScore)
          .slice(0, 40)

        // 3.5. 英語記事は翻訳 + 要約、日本語記事もタグ抽出のため Gemini を通す
        const translationBatch = db.batch()
        let translatedCount = 0
        let skippedCount = 0

        for (const item of ranked) {
          const article = item.article
          const articleRef = db.doc(`topics/${topic}/articles/${article.id}`)

          if (isJapanese(article.title)) {
            // 日本語記事: タグ未抽出、または要約未生成なら Gemini で補完する
            if (!article.titleJa || !article.summaryJa || !article.tags || article.tags.length === 0) {
              try {
                const { titleJa, summaryJa, tags } = await summarizeArticle(
                  article.title,
                  article.content ?? article.description ?? ''
                )
                translationBatch.update(articleRef, { titleJa, summaryJa, tags })
                article.titleJa = titleJa || article.title
                article.summaryJa = summaryJa || (article.description ?? '').slice(0, 300)
                article.tags = tags
                translatedCount++
              } catch (err) {
                console.error(`[generatePersonalizedFeed] Tagging failed for ${article.url}:`, err)
                const fallbackSummary = article.summaryJa ?? (article.description ?? '').slice(0, 300)
                translationBatch.update(articleRef, {
                  titleJa: article.titleJa ?? article.title,
                  summaryJa: fallbackSummary,
                  tags: article.tags ?? []
                })
                article.titleJa = article.titleJa ?? article.title
                article.summaryJa = fallbackSummary
                article.tags = article.tags ?? []
              }
            } else {
              // 日本語記事: 既存データが揃っていればそのまま使う
              skippedCount++
            }
          } else if (!article.titleJa || !isJapanese(article.titleJa)) {
            // 日本語以外の記事: 未翻訳、または以前の処理で日本語以外のtitleJaがセットされた場合も再翻訳
            try {
              const { titleJa, summaryJa, tags } = await summarizeArticle(
                article.title,
                article.content ?? article.description ?? ''
              )
              translationBatch.update(articleRef, { titleJa, summaryJa, tags })
              article.titleJa = titleJa
              article.summaryJa = summaryJa
              article.tags = tags
              translatedCount++
            } catch (err) {
              console.error(`[generatePersonalizedFeed] Translation failed for ${article.url}:`, err)
              const fallbackSummary = (article.description ?? '').slice(0, 300)
              translationBatch.update(articleRef, {
                titleJa: article.title,
                summaryJa: fallbackSummary,
                tags: []
              })
              article.titleJa = article.title
              article.summaryJa = fallbackSummary
              article.tags = []
            }
          } else {
            skippedCount++ // 翻訳済み
          }
        }

        await translationBatch.commit()
        console.log(`[generatePersonalizedFeed] Translated ${translatedCount} articles, skipped ${skippedCount}`)

        // 4. ユーザーのフィードに保存
        const feedRef = db.collection(`users/${uid}/newsFeed/${topic}/articles`)
        const batch = db.batch()

        // 既存の今日のフィードを削除
        const existingSnap = await feedRef.where('date', '==', today).get()
        existingSnap.docs.forEach(doc => batch.delete(doc.ref))

        // 新しいフィードを保存（記事の全データを含める）
        ranked.forEach(item => {
          const docRef = feedRef.doc(item.article.id)
          batch.set(docRef, {
            ...item.article,
            displayScore: item.displayScore,
          })
        })

        await batch.commit()
        console.log(`[generatePersonalizedFeed] Saved feed for user ${uid} (dismissed: ${dismissedIds.size}, learned: ${learnedKeywords.length})`)
      } catch (err) {
        console.error(`[generatePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }
  })

export const generateMobilePersonalizedFeed = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '256MB', secrets: ['GEMINI_API_KEY'] })
  .pubsub.schedule('40 6 * * *').timeZone('Asia/Tokyo')
  .onRun(async () => {
    console.log('[generateMobilePersonalizedFeed] Starting...')
    const topic: NewsTopic = 'mobile'
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const articlesSnap = await db.collection(`topics/${topic}/articles`)
      .where('date', '==', today)
      .get()

    if (articlesSnap.empty) {
      console.log('[generateMobilePersonalizedFeed] No articles for today')
      return
    }

    const seenUrls = new Set<string>()
    const articles = articlesSnap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as NewsArticle) }))
      .filter(a => {
        if (seenUrls.has(a.url)) return false
        seenUrls.add(a.url)
        return true
      })

    const usersSnap = await db.collection('users').get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const [prefDoc, interactionsSnap] = await Promise.all([
          db.doc(`users/${uid}/newsPreferences/${topic}`).get(),
          db.collection(`users/${uid}/newsInteractions`).get(),
        ])

        const preferences: NewsPreferences = prefDoc.exists
          ? (prefDoc.data() as NewsPreferences)
          : { keywords: [], platforms: ['ios', 'android'], officialOnly: false, includeCommunity: true }

        const dismissedIds = new Set<string>()
        const excludedUrls = new Set<string>()
        const shownCountByUrl = new Map<string, number>()
        const clicks: ClickData[] = []

        for (const intDoc of interactionsSnap.docs) {
          const data = intDoc.data()
          if (!isInteractionForTopic(topic, data)) continue

          const interactionArticleId = typeof data.articleId === 'string' ? data.articleId : intDoc.id
          if (data.dismissed === true) {
            dismissedIds.add(interactionArticleId)
            if (data.url) excludedUrls.add(data.url as string)
          }
          if (data.clickedAt) {
            if (data.url) excludedUrls.add(data.url as string)
            clicks.push({
              titleEn: data.titleEn as string | undefined,
              summaryJa: data.summaryJa as string | undefined,
              tags: data.tags as string[] | undefined,
            })
          }
          if (data.url && typeof data.shownCount === 'number') {
            shownCountByUrl.set(
              data.url as string,
              (shownCountByUrl.get(data.url as string) ?? 0) + data.shownCount
            )
          }
        }

        for (const [url, shownCount] of shownCountByUrl.entries()) {
          if (shownCount >= 2) {
            excludedUrls.add(url)
          }
        }

        const learnedKeywords = learnKeywordsFromClicks(clicks)
        const scored = articles
          .filter(a => !dismissedIds.has(a.id) && !excludedUrls.has(a.url))
          .map(article => ({
            article,
            displayScore: calcMobileDisplayScore(article, preferences, learnedKeywords),
          }))
          .filter(item => item.displayScore >= 0)
          .sort((a, b) => b.displayScore - a.displayScore)
          .slice(0, 40)

        const translationBatch = db.batch()
        for (const item of scored) {
          const article = item.article
          const articleRef = db.doc(`topics/${topic}/articles/${article.id}`)

          if (isJapanese(article.title)) {
            if (!article.titleJa || !article.summaryJa || !article.tags || article.tags.length === 0) {
              try {
                const { titleJa, summaryJa, tags } = await summarizeArticle(
                  article.title,
                  article.content ?? article.description ?? ''
                )
                translationBatch.update(articleRef, { titleJa, summaryJa, tags })
                article.titleJa = titleJa || article.title
                article.summaryJa = summaryJa || (article.description ?? '').slice(0, 300)
                article.tags = tags
              } catch (err) {
                console.error(`[generateMobilePersonalizedFeed] Tagging failed for ${article.url}:`, err)
              }
            }
          } else if (!article.titleJa || !isJapanese(article.titleJa)) {
            try {
              const { titleJa, summaryJa, tags } = await summarizeArticle(
                article.title,
                article.content ?? article.description ?? ''
              )
              translationBatch.update(articleRef, { titleJa, summaryJa, tags })
              article.titleJa = titleJa
              article.summaryJa = summaryJa
              article.tags = tags
            } catch (err) {
              console.error(`[generateMobilePersonalizedFeed] Translation failed for ${article.url}:`, err)
              const fallbackSummary = (article.description ?? '').slice(0, 300)
              translationBatch.update(articleRef, {
                titleJa: article.title,
                summaryJa: fallbackSummary,
                tags: article.tags ?? [],
              })
              article.titleJa = article.title
              article.summaryJa = fallbackSummary
              article.tags = article.tags ?? []
            }
          }
        }
        await translationBatch.commit()

        const feedRef = db.collection(`users/${uid}/newsFeed/${topic}/articles`)
        const batch = db.batch()
        const existingSnap = await feedRef.where('date', '==', today).get()
        existingSnap.docs.forEach(doc => batch.delete(doc.ref))

        scored.forEach(item => {
          const docRef = feedRef.doc(item.article.id)
          batch.set(docRef, {
            ...item.article,
            displayScore: item.displayScore,
          })
        })

        await batch.commit()
        console.log(`[generateMobilePersonalizedFeed] Saved feed for user ${uid} (${scored.length} articles)`)
      } catch (err) {
        console.error(`[generateMobilePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }
  })
