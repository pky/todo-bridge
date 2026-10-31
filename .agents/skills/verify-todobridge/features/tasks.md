# タスク一覧と並べ替え

## Sub-features

- リストのタスクを表示する。
- 名前順・作成日順の切替、選択、サブタスク表示を行う。

## How to get to it (user POV)

認証後の `/` で対象リストを選ぶ。

## Driving it with e2e

新しい e2e テストは未追加。既存 `web/e2e/responsive.spec.ts` のモック認証と「作成日」の button を参照し、`observe` と `locate` からロケータを確定する。

## Proof

ソート順と表示順が一致し、選択したタスクのサブタスクが表示される。保存を伴う検証は Emulator の tasks と照合する。今回の fixture はタスクが空で、この機能は未検証。

## Charters

```text
task-sort|mobile-web|skeptic|Emulatorに架空のタスクを用意して / の並べ替えとサブタスク表示を切り替え、表示順と親子関係が維持されるか調べる
```

## Gotchas

既存 responsive テストはスクリーンショット確認が中心で、永続化成功を意味しない。
