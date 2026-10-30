import type { WidgetTopic } from './widgetFeed'

/** 「あとで読む」に入れる記事。タイトルと概要と原文URLは、サーバーが記事のデータから決める。 */
export interface ReadLaterArticle {
  id: string
  title: string
  summary: string
  url: string | null
}

export interface ReadLaterStoreDeps {
  db: FirebaseFirestore.Firestore
  /** Firestore のサーバー時刻を表す値を返す。 */
  serverTimestamp(): unknown
}

/**
 * Web の bookmarkArticle と同じタスクを、個人スペースの「あとで読む」リストに作り、記事をフィードから外す。
 * 保存先: users/{uid}/memberships が空なら users/{uid}、あれば spaces/personal_{uid}。
 * すでに同じ記事を入れていたら 'already'。
 */
export async function addReadLaterTask(
  _deps: ReadLaterStoreDeps,
  _uid: string,
  _topic: WidgetTopic,
  _article: ReadLaterArticle
): Promise<'created' | 'already'> {
  return 'already'
}

/** 同じ topic と記事IDで、すでに「あとで読む」に入れているか。 */
export async function isReadLaterAdded(
  _deps: ReadLaterStoreDeps,
  _uid: string,
  _topic: WidgetTopic,
  _articleId: string
): Promise<boolean> {
  return false
}
