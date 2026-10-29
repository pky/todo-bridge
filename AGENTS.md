# TodoBridge エージェント向けガイド

Codex と Claude Code の共通ルール。CLAUDE.md はこのファイルを読み込む。README の説明や一般的なコーディング作法は書かず、このリポジトリ固有の判断基準だけを置く。

## 構成
- `web/`: Vue / Vite / Pinia / Firebase のフロントエンド
- `functions/`: Firebase Cloud Functions（TypeScript）
- `doc/`: テンプレート2件以外は .gitignore 対象のローカル専用資料
- `progress.txt`、`internal_docs/`: ローカル専用。コミットしない
- パッケージマネージャは npm。pnpm / yarn は使わない

## 実装上の制約
- 未完了タスクの取得に `limit()` を使わない。パフォーマンス最適化でも全件表示を優先する
- 型エラーを `as any` などのキャストで消さない。データフローか型境界を直す
- 依存は必要性が明確な場合だけ追加する
- 重要な挙動変更では、該当するドキュメントも更新する

## Firebase と秘密情報
- テストは Firebase Emulator を使う。ルールテストはデモ用プロジェクト `demo-rertm` で動く（`test:rules` に設定済み）
- Firebase / GCP / Gemini / Google Calendar のキー、トークン、secret、環境変数の値をコードやファイルに書かない
- Google Calendar の refresh token はサーバー側だけで扱い、ログやテスト出力に出さない
- エージェントは git push、デプロイ、rm、git reset、ブランチ削除、本番データに触れる操作を実行しない。人が行う

## 公開安全性
このリポジトリは公開されている。
- コミットしない: `.env`、`.env.*`、`*.local`、`.firebaserc`、`web/.firebaserc`、`.firebase/`、`functions/lib/`、ビルド成果物、テスト成果物、エクスポートデータ。`web/.env.test` はダミー値だけなら例外
- 実ユーザーのタスク、RTM エクスポート、カレンダー予定、実環境のプロジェクト ID、個人名、個人メール、実 URL、ローカル絶対パスをコード、テスト、ドキュメント、ログ例に入れない
- 公開ドキュメントに内輪の変更経緯や作業途中の事情を書かない
- 秘密情報らしき文字列を見つけたら値を表示せず、種類と場所だけを伝える
- 公開安全性や検証漏れを指摘されたら、同種のミスを防ぐ一般ルールをこのファイルに追加する。例に実名、実キー、実 URL、絶対パスを使わない

## 検証
web/:
- Lint: `cd web && npm run lint`
- 型チェック: `cd web && npm run type-check`
- テスト: `cd web && npm run test:run`
- ビルド: `cd web && npm run build`（test:auth、vue-tsc -b、vite build を実行）
- Firestore ルール（emulator に Java が必要）: `cd web && npm run test:rules`
- レスポンシブ UI: `cd web && npm run test:responsive`

functions/:
- Lint: `cd functions && npm run lint`
- テスト: `cd functions && npm test`（ビルド後に node --test）

完了と報告する前に、触ったパッケージの lint、型チェック、テスト、ビルドをすべて通す。テストを書き換えて通すのは禁止。リポジトリ直下の `npm run verify` が test:rules と test:responsive 以外の全ゲートを実行する。firestore.rules を変えたら test:rules、レスポンシブ UI を変えたら test:responsive も実行する。

コミット前に `git status --short` と `git diff --check` で、意図しない差分、未追跡ファイル、公開に向かない内容がないか確認する。

## バグ修正の報告
最後に次を書く。
- 根本原因（確定か推測か）
- 変更したファイル
- 実行したコマンド
- 検証できたこと、未検証のこと
- 残る回帰リスク

## Git と PR
- `feature/<topic>` ブランチで作業し、PR 経由で `main` にマージする。`main` に直接コミットしない。開発者は1人で、PR の作成、レビュー、マージも本人が行う
- コミットメッセージは簡潔な1行の日本語。`Co-Authored-By` は入れない。author / email は GitHub の公開用 noreply に統一する
- force push と履歴の書き換えはしない
- push 前のローカルゲート: リポジトリ直下の `npm run verify` は毎回通す。PR を開く前の push では、差分を書いていないレビュアー（Claude の fresh-reviewer エージェントまたは Codex CLI review）のレビューも通す。PR を開いた後、Codex の指摘を直すだけの push は `npm run verify` だけでよい。通ってから人が push する
- PR のゲート: GitHub Actions（.github/workflows/ci.yml）が web の lint / type-check / test:run / build、functions の lint / test、Firestore ルールテストを実行する。PR 作成時に Codex の自動レビューが走る。CI が green で、Codex の指摘がすべて修正済みか理由付きで回答済みのときだけマージする
- ローカル専用ファイル（web/.env.local、.firebaserc、doc/、progress.txt など）は .worktreeinclude に列挙してあり、git worktree にコピーされる

## コードレビュー
上から順に見る。指摘には必ず失敗シナリオ（どの入力でどう壊れるか）を付ける。
1. データ破壊: 上書き、削除、移動、マイグレーション、永続化の変更（Firestore のドキュメント構造、firestore.rules、storage.rules の変更を含む）
2. 認証と権限: 認可の抜け、権限チェックの緩和、セキュリティルールの緩和
3. 秘密情報の混入: 鍵、トークン、個人情報、実環境 ID、内部 URL のハードコード
4. テストの改変: 既存テストの削除、期待値の書き換え、スキップの追加
5. 頼んでいない変更: 依頼範囲外のリファクタ、整形、依存の追加

スタイルだけの指摘と、失敗シナリオが書けない指摘は出さない。

このリポジトリで blocker として扱うもの:
- 未完了タスクの取得に `limit()` を付ける変更（全件表示の要件を壊す）
- firestore.rules と storage.rules の allow 条件を広げる変更で、理由と対応するルールテストが無いもの
- 実環境のプロジェクト ID、実ユーザーのデータ、ローカル絶対パスがテストやドキュメントに入ったもの
