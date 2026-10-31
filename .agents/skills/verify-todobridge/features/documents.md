# 書類一覧と追加

## Sub-features

- 一覧から書類詳細を開く。
- PDF・画像を追加し、サムネイルを確認する。
- ごみ箱への移動と復元を行う。

## How to get to it (user POV)

認証後、ナビゲーションの「書類」または `/documents`。有効なスペースのメンバー権限が必要。

## Driving it with e2e

新しい e2e テストは未追加。既存 `web/e2e/documents-live.spec.ts` を参照し、必要な Functions・ストレージの隔離方法を決めてから `observe` と `locate` で検証する。

## Proof

一覧・詳細・サムネイルと Emulator のメタデータが一致し、移動・復元が保存される。今回の設定は Functions とストレージを起動せず、この機能は未検証。

## Charters

```text
document-restore|mobile-web|skeptic|専用Emulatorの書類環境を別途準備して /documents の架空書類をごみ箱へ移動・復元し、一覧とメタデータが一致するか調べる
```

## Gotchas

現在のニュース検証環境で書類追加が動くとは扱わない。本番ストレージや外部 OCR へ接続しない。
