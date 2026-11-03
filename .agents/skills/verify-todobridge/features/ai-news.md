# AIニュースの固定JSON取得と管理操作

## 対象

`/news/ai` でStorageの `news/v2/ai/latest.json` を取得し、原本順に表示する。「興味なし」で対象記事を隠し、「あとで読む」の成功後は「追加済み」を無効表示して記事を一覧に残す。

## 実行

`cd web && npm run verify:e2e:ai-news` を使う。`AIニュース` のheading、架空記事の本文、「興味なし」「あとで読む」「追加済み」のbuttonを操作する。実行前にJava 21以上とブラウザが必要。ほかのe2e/MCPとは同時に起動しない。

`ai-news.fixture.ts` は専用Auth Emulatorに匿名ユーザーを作り、`newsRole: curator` のcustom claimを設定して新しいトークンを取得する。Storage Emulatorに架空の原本を置き、画面内のニュースキャッシュにはデータを注入しない。接続先は専用Emulatorと検証アプリだけに限定する。

## 検証範囲と証跡

固定原本の実取得、表示、興味なしによる非表示、あとで読む成功応答後のラベル・無効化・記事維持を確認する。管理操作APIはローカルHTTP routeのfixtureで成功応答を返すため、Functionsの認可・タスク永続化はこのE2Eの対象外。送信した記事IDとaction、操作後のStorage再取得がないこと、外部要求が0件であることも照合する。

画面3枚、trace、動画を `.e2e/proof/ai-news/` に保存する。証跡はGit管理外。機能マップの状態は成功実行後にだけ `tested` にする。

## 起動の前提条件

`verification/start.mjs` のEmulator起動対象 `--only` に `storage` を含め、19199番も既存プロセス確認の対象にする必要がある。`verification/environment.mjs` からStorageの接続ポートを渡し、アプリのStorage SDKを専用Emulatorへ接続する。Functions用のHTTP送信先は15001番を使う。

## 閲覧専用ユーザー

| 対象 | 実行 | 確認する挙動 |
| --- | --- | --- |
| viewer のログインと閲覧 | `cd web && npm run verify:e2e:ai-news-viewer` | 記事表示、管理ボタン非表示、Home の直接表示を AI ニュースへ転送、`newsAction` への POST が0件 |

`ai-news-viewer.fixture.ts` は既存の AI ニュース fixture と同じ Auth・Storage Emulator の準備方法を使い、架空ユーザーへ `newsRole: viewer` を設定して再発行したトークンを SDK の認証ストレージへ渡す。`mock-auth-state` は使わず、通常の認証初期化を通す。既存の利用許可 API が呼ばれた場合は記録し、権限拒否を返す。

記事が実際に表示されることと Storage の取得を確認し、「あとで読む」「興味なし」「あとで読むを開く」が無いことを検証する。Home の URL を直接開いた場合も `/news/ai` で記事を表示する。管理操作の POST と外部通信が0件であることは fixture の終了時にも確認する。Functions の実処理と本番の権限設定は対象外。

証跡は `.e2e/proof/ai-news-viewer/` に保存する。状態は成功実行後にだけ `tested` にする。
