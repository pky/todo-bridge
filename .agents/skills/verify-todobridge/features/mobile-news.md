# モバイルニュースの確認優先欄

## Sub-features

- 要対応記事を「今日の重要事項」に表示する。
- 「対応済み」で確認優先欄から除いて対応済み一覧へ移す。
- 一覧を開き、「戻す」で確認優先欄へ戻す。

## How to get to it (user POV)

認証後にニュースのモバイル項目、または `/news/mobile` へ移動する。検証は同一 UID の mock-auth-state と Auth Emulator 匿名認証を使う。

## Driving it with e2e

`web/verification/tests/mobile-news.e2e.ts` を `cd web && npm run verify:e2e:mobile-news` で実行する。「今日の重要事項」の heading、`important-title` test id、「対応済み」「対応済み 1件」「戻す」の button、「検証用セキュリティ更新の確認」の link を使う。ライブはスモークを指定して `open_session` し、`observe`→`locate`→対応済み→一覧を開く→戻すを順に操作する。

## Proof

4段階の画面と全操作の trace・動画を保存する。Firestore の `resolved` に `done` が入り、ニュースキャッシュを消した後も一覧に残り、戻すとキーが消えて再表示される。外部要求は0件。

## Charters

```text
mobile-action-state|mobile-web|skeptic|Emulatorの検証ユーザーで /news/mobile の確認優先記事を対応済み・復元し、再読み込み前後の画面と保存状態が一致するか調べる
```

## Gotchas

- 確認優先欄の見出しは「今日の重要事項」。
- 外部記事は開かない。seed は架空の記事で、収集・通知・Functions は対象外。
- 共有集約を使うため、ほかの e2e/MCP と同時実行しない。
