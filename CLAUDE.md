# TodoBridge 開発ガイド

このファイルは、AI コーディングエージェントを使って TodoBridge を開発するときのプロジェクト固有ガイドです。公開リポジトリに置く前提で、README と重複する説明ではなく、作業時の判断基準と確認手順だけを残します。

## 前提

- `web/` は Vue / Vite / Pinia / Firebase を使うフロントエンド
- `functions/` は Firebase Cloud Functions のバックエンド
- `doc/` は公開して問題ない設計資料だけを置く
- `progress.txt` はローカル専用メモで、リポジトリには含めない
- 実データ、実環境 ID、個人名、個人メール、ローカル絶対パスはコード・ドキュメント・ログ例に書かない

## 作業フロー

- 変更前に、対象機能に関係する `doc/`、テスト、既存実装を最小範囲で確認する
- 仕様や不具合の前提が曖昧な場合は、先に現状の挙動を確認する
- 複数ファイルにまたがる変更では、短い作業計画を立ててから編集する
- 前提が崩れたら、いったん作業計画を更新してから続ける
- 編集後は `git diff` を見て、意図しない差分や公開に向かない内容がないか確認する

## 実装方針

- 根本原因の修正を優先する
- 変更は最小差分で行う
- UI の症状だけをつぎはぎで直さない
- 既存の状態管理、データ取得、Firebase 連携の責務を崩さない
- 未完了タスク取得で `limit()` を使わない
- パフォーマンス最適化時も、全データが表示されることを優先する
- 重要な挙動変更時は、リポジトリ内の該当ドキュメントも更新する

## Firebase / GCP

- テストは原則として Firebase Emulator を使う
- Firestore ルールの確認では `demo-rertm` のようなデモ用プロジェクトを使う
- Firebase / GCP / Gemini / Google Calendar の実キーやトークンをファイルに書かない
- Cloud Functions の secret や環境変数はコードに埋め込まない
- Google Calendar の refresh token などの認証情報はサーバー側だけで扱い、ログやテスト出力に出さない
- デプロイや本番データに影響する操作は、明示的に依頼された場合だけ実行する

## 公開安全性

- `.env`、`.env.*`、`*.local`、`.firebaserc`、`web/.firebaserc` はコミットしない。ただし `web/.env.test` はテスト用のダミー値だけなら例外
- `.firebase/`、`functions/lib/`、ビルド成果物、テスト成果物、エクスポートデータはコミットしない
- 実ユーザーのタスク、RTM エクスポート、カレンダー予定、URL、ID をテストやドキュメントに混ぜない
- 公開用ドキュメントには、変更履歴の内輪向け説明や作業途中の事情を書かない
- 秘密情報らしき文字列を見つけた場合は値を表示せず、種類と場所だけを伝える

## 検証

影響範囲の小さい確認から実行する。

```bash
cd web
npm run test:run
npm run type-check
npm run build
```

Firestore ルールを変更した場合:

```bash
cd web
npm run test:rules
```

レスポンシブ UI を変更した場合:

```bash
cd web
npm run test:responsive
```

Cloud Functions を変更した場合:

```bash
cd functions
npm test
```

公開前や公開向け差分では、少なくとも次を確認する。

```bash
git status --short
git ls-files --others --exclude-standard
git diff --check
```

## 再発防止

- 公開安全性、個人情報、検証漏れを指摘された場合は、同じ種類のミスを防ぐ一般ルールをこのファイルに追加する
- 追加するルールには、実名、個人メール、実キー、実 URL、ローカル絶対パスを例として書かない
- 同じ確認を手作業で繰り返す必要が出た場合は、既存スクリプトやテストに寄せられないか検討する

## Git 運用

- コミットメッセージは簡潔な1行の日本語にする
- `Co-Authored-By` は入れない
- author / email は GitHub の公開用 noreply に統一する
- 公開リポジトリの履歴を書き換える操作や force push は、明示的に依頼された場合だけ実行する
