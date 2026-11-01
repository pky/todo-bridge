# タスク一覧と並べ替え

## Sub-features

- リストのタスクを表示する。
- 背景復帰後もスマートリスト件数とタスク・リストの更新を反映する。
- 名前順・作成日順の切替、選択、サブタスク表示を行う。

## How to get to it (user POV)

認証後の `/` で対象リストを選ぶ。

## Driving it with e2e

`npm run verify:e2e:task-counts` は架空のタスク・リスト・集計値を専用Emulatorに用意する。集計と起動時のカレンダー設定取得のcallableはローカル応答で置き換え、初回と31秒の背景復帰でキャッシュ優先要求が送られること、復帰後もFirestore購読が更新を表示することを確認する。Functionsの全件読み取り抑止そのものはサーバー側の回帰テストで確認する。

並べ替えの新しい e2e テストは未追加。既存 `web/e2e/responsive.spec.ts` のモック認証と「作成日」の button を参照し、`observe` と `locate` からロケータを確定する。

## Proof

ソート順と表示順が一致し、選択したタスクのサブタスクが表示される。保存を伴う検証は Emulator の tasks と照合する。件数と背景復帰の証跡は `.e2e/proof/task-counts/` に保存する。並べ替え・サブタスク表示は未検証。

## Charters

```text
task-sort|mobile-web|skeptic|Emulatorに架空のタスクを用意して / の並べ替えとサブタスク表示を切り替え、表示順と親子関係が維持されるか調べる
```

## Gotchas

既存 responsive テストはスクリーンショット確認が中心で、永続化成功を意味しない。
