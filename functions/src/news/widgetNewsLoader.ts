import type { FeedDoc, WidgetFeedInput, WidgetTopic } from './widgetFeed'

async function loadLatestDocs(collection: FirebaseFirestore.CollectionReference): Promise<{
  date: string | null
  docs: FeedDoc[]
}> {
  const latestSnapshot = await collection.orderBy('date', 'desc').limit(1).get()
  const date: unknown = latestSnapshot.docs[0]?.data().date
  if (typeof date !== 'string' || !date) return { date: null, docs: [] }

  const snapshot = await collection.where('date', '==', date).get()
  return { date, docs: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) }
}

const URL_IN_LIMIT = 30

// 今日の候補記事に関係する記録だけを、ID と url で引いて読む。全件は読まない。
async function loadRelatedInteractions(
  db: FirebaseFirestore.Firestore,
  uid: string,
  topic: WidgetTopic,
  candidates: FeedDoc[]
): Promise<FeedDoc[]> {
  if (candidates.length === 0) return []
  const path = `users/${uid}/newsInteractions`

  const ids = [...new Set(candidates.map((article) => article.id))]
  const refs = ids.flatMap((id) => [db.doc(`${path}/${topic}_${id}`), db.doc(`${path}/${id}`)])

  const urls = [...new Set(
    candidates.map((article) => article.url).filter((url): url is string => typeof url === 'string' && url !== '')
  )]
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += URL_IN_LIMIT) chunks.push(urls.slice(i, i + URL_IN_LIMIT))

  const [byId, ...byUrl] = await Promise.all([
    db.getAll(...refs),
    ...chunks.map((chunk) => db.collection(path).where('url', 'in', chunk).get()),
  ])

  const found = new Map<string, FeedDoc>()
  const docs = [...byId.filter((doc) => doc.exists), ...byUrl.flatMap((snapshot) => snapshot.docs)]
  for (const doc of docs) {
    if (!found.has(doc.id)) found.set(doc.id, { id: doc.id, ...doc.data() })
  }
  return [...found.values()]
}

export async function loadWidgetFeedInputs(
  db: FirebaseFirestore.Firestore,
  uid: string,
  topic: WidgetTopic
): Promise<WidgetFeedInput> {
  const [personal, shared] = await Promise.all([
    loadLatestDocs(db.collection(`users/${uid}/newsFeed/${topic}/articles`)),
    loadLatestDocs(db.collection(`topics/${topic}/articles`)),
  ])
  const interactions = await loadRelatedInteractions(db, uid, topic, [...personal.docs, ...shared.docs])
  return {
    topic,
    personalDate: personal.date,
    personalDocs: personal.docs,
    sharedDate: shared.date,
    sharedDocs: shared.docs,
    interactions,
  }
}
