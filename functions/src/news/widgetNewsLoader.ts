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

export async function loadWidgetFeedInputs(
  db: FirebaseFirestore.Firestore,
  uid: string,
  topic: WidgetTopic
): Promise<WidgetFeedInput> {
  const [personal, shared, interactions] = await Promise.all([
    loadLatestDocs(db.collection(`users/${uid}/newsFeed/${topic}/articles`)),
    loadLatestDocs(db.collection(`topics/${topic}/articles`)),
    db.collection(`users/${uid}/newsInteractions`).get(),
  ])
  return {
    topic,
    personalDate: personal.date,
    personalDocs: personal.docs,
    sharedDate: shared.date,
    sharedDocs: shared.docs,
    interactions: interactions.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  }
}
