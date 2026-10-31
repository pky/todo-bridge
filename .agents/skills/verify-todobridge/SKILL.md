---
name: verify-todobridge
description: TodoBridge の web UI をデモ用 Firebase Emulator と e2e で検証し、操作・保存結果の証跡を残す。画面変更の確認、モバイルニュースの回帰確認、検証用スクリーンショットの取得に使う。
---

# TodoBridge の web 検証

## Read first

[e2e skill](../../../web/node_modules/e2e/skills/e2e/SKILL.md) を読む（`cd web && npm run verify:e2e:guide` でも取得可）。設定は `web/e2e.config.ts`、対象は `mobile-web`、テストは `web/verification/tests/**/*.e2e.ts`。[機能マップ](features/README.md) から選ぶ。

## Launch

以降は `web/` で実行する。ブラウザ・Emulator の起動、ネットワークや権限を要する依存導入は、コマンドを示してその都度承認を得る。未導入のブラウザは `npm run verify:e2e:browser-install` で導入する。検証用 npm script はテレメトリを無効化し、e2e CLI はローカルの固定版だけを使う。JDK 21 以上の `java` が PATH 上で実行できることを確認する。必要なら実行時に PATH と JAVA_HOME を指定する。個別環境のパスを設定ファイルへ書かない。

`app.command` が `node verification/start.mjs {port}` を実行する。Vite が test モードでビルドし、専用 Auth（19099）・Firestore（18080）・Hub（14400）・Logging（14500）を `demo-rertm` で起動してから、動的ポートの `127.0.0.1` で preview を公開する。URL が応答すれば起動完了。既存ポートへ接続せず、別の検証と同時実行しない。

`envDir: false` で `.env`、`.env.local` などの環境ファイルを読まず、`verification/environment.mjs` のダミー設定だけを使う。Functions は起動しない。CSP とテストの許可リストでブラウザの接続先をローカルだけに制限する。実プロジェクト、本番データ、Google アカウントを使わない。

`verification/tests/fixture.ts` が Auth Emulator に匿名アカウントを作り、既存 `e2e/responsive.spec.ts` と同じ `mock-auth-state` を使う。Firestore のルールは SDK の認証も必要なので、同一 UID の Emulator 認証をブラウザの永続化ストレージへ準備する。Emulator REST API で架空の記事集約と空の対応済み状態を作る。ニュースの内部ストアやキャッシュにデータは注入しない。

## Doctor

```bash
npm run verify:e2e:list
npm run verify:e2e:smoke
```

両方 exit 0 が必要。`list` は起動せず設定と2件のペアを確認する。スモークは認証準備を含み、「モバイルニュース」と Emulator から読んだ検証記事を確認する。何かおかしければ Doctor を実行し、失敗時は trace と `.e2e/logs/app.log` を読む。

## Drive

ライブ操作は Claude Code 用のルート `.mcp.json` に登録した `e2e` を使う。Codex 用の設定は作らない。`open_session { test: "verification/tests/smoke.e2e.ts" }` で認証・データ準備済みの画面を開き、`observe`、`locate` で名前を確認してから `tap` や `run_code` を使う。catalog にある `observe`、`locate`、`run_code`、`test_lines`、`screenshot` と操作動詞が利用できる。資格情報、独自ツール、LLM は未設定。単なる `open_session` は未認証画面になる。

スクリプト検証は次の通り。モデルを使わず、role・名前・既存 test id を指定する。Emulator の共有ポートと集約文書を使うため、実行前に MCP セッションを `close_session` する。

```bash
npm run verify:e2e:mobile-news
```

## Evidence

通常は `.e2e/report.json`、`.e2e/results/<test>/trace.md`、attempt 配下の動画・画面が残る。次回実行は results を消すため、残す検証は上記の `--output .e2e/proof/<name>` を使う。Doctor は `.e2e/proof/doctor/`、ニュース検証は `.e2e/proof/mobile-news/` にレポート、全ステップの trace、動画、名前付き画面を残す。[running](../../../web/node_modules/e2e/skills/e2e/references/running.md) を参照。

MCP のロケータ確認は `.e2e/proof/mcp/locators.json` に操作・照合結果を残す。

表示→対応済み→一覧→戻すを実際のボタンで操作し、4段階の画面を保存する。`users/<匿名UID>/newsState/mobileActionItems` の `resolved` を Emulator REST API で読み、対応済み時の `done` と復元時のキー消失を照合する。対応済み後はニュースキャッシュだけを消して再読み込みし、保存状態の再取得も確認する。外部への要求が0件であることをテスト終端で検証する。トークンは出力しない。証跡は Git 管理外に置き、共有前に内容を確認する。

## Bug bash

バグ探し（`e2e explore`）はモデルを設定したときだけ使う。この設定にはモデルが無い。charter は [機能マップ](features/README.md) を参照する。探索にはモデルと実施範囲の別途合意が必要。

## Cleanup

runner が自分の preview と Emulator を停止する。MCP は `close_session` で停止する。匿名ユーザー・seed 文書は専用 Emulator のメモリにのみあり、停止時に破棄される。export は作らない。失敗時も同じ停止処理を行い、他のプロセスを名前で終了しない。

停止後も `.e2e/proof/doctor/` と `.e2e/proof/mobile-news/` の report、trace、動画、画面が残ることを確認する。`.e2e/` は全体が gitignore 対象。証跡を削除しない。

## Helpers

`verification/start.mjs` は runner 専用（ポート引数が必要）。`verification/serve.mjs` はその子プロセス。手動で重ねて起動せず、Doctor または上記の機能テストを使う。

`npm run verify:e2e:mcp-locate` はルート `.mcp.json` と同じ登録を使い、認証済みスモークから各ロケータを `locate` し、対応済み・復元を `run_code` で操作してセッションを閉じる。ブラウザ・Emulator が起動するため、他の検証を止めてその都度承認を得て実行する。専用の証跡は `.e2e/proof/mcp/locators.json`。

## Gotchas

起動スクリプトが強制終了されると専用 Emulator（18080、19099）が残ることがある。そのときは自分が起動したプロセスだけを止める。
