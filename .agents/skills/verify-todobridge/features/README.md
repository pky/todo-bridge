# TodoBridge の機能マップ

| 機能 | ルート | e2e テスト | 状態 |
| --- | --- | --- | --- |
| [認証済み画面](authentication.md) | `/news/mobile` | `web/verification/tests/smoke.e2e.ts` | tested |
| [モバイルニュースの確認優先欄](mobile-news.md) | `/news/mobile` | `web/verification/tests/mobile-news.e2e.ts` | tested |
| [AIニュースの固定JSONと管理操作](ai-news.md) | `/news/ai` | `web/verification/tests/ai-news.e2e.ts` | untested |
| [タスク件数と背景復帰](tasks.md) | `/` | `web/verification/tests/task-counts.e2e.ts` | tested |
| [タスク一覧と並べ替え](tasks.md) | `/` | 未追加 | untested |
| [表示テーマ](theme.md) | `/settings` | `web/verification/tests/theme.e2e.ts` | tested |
| [書類一覧と追加](documents.md) | `/documents` | 未追加 | untested |

`tested` はこの skill のテストが成功したものだけに付ける。既存の `web/e2e/responsive.spec.ts` と `test:responsive` は独立した検証として維持する。バグ探し（`e2e explore`）はモデルを設定したときだけ使う。この設定にはモデルが無い。
