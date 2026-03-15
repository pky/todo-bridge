# TodoBridge プロジェクト概要

## 1. プロジェクト概要

### 1.1 目的
Remember The Milk (RTM) のクローンアプリケーションを開発する。
既存のRTMデータをインポートし、Web版とiOS版の両方で利用できるタスク管理システムを構築する。

### 1.2 スコープ
- **Web版**: Vue 3 + TypeScript + Firebase
- **iOS版**: Swift + SwiftUI + Firebase
- **共通バックエンド**: Firebase (Firestore + Authentication)

### 1.3 開発順序
1. Web版を先行開発
2. Web版完成後、iOS版に着手
3. 両プラットフォームで同一のFirebaseバックエンドを共有

---

## 2. 技術スタック

### 2.1 Web版
| 領域 | 技術 |
|------|------|
| フレームワーク | Vue 3 (Composition API) |
| 言語 | TypeScript |
| ビルドツール | Vite |
| 状態管理 | Pinia |
| ルーティング | Vue Router |
| UI | Tailwind CSS |
| データベース | Firebase Firestore |
| 認証 | Firebase Authentication |
| ホスティング | Firebase Hosting |
| テスト | Vitest + Playwright |

### 2.2 iOS版
| 領域 | 技術 |
|------|------|
| 言語 | Swift 5.9+ |
| UI | SwiftUI |
| アーキテクチャ | MVVM |
| データベース | Firebase Firestore |
| 認証 | Firebase Authentication |
| 依存管理 | Swift Package Manager |
| 最小OS | iOS 17.0 |

---

## 3. 機能要件

### 3.1 コア機能（MVP）

#### タスク管理
- [ ] タスクの作成・編集・削除
- [ ] タスクの完了/未完了切り替え
- [ ] 優先度設定（1: 高, 2: 中, 3: 低, 4: なし）
- [ ] 期限日・開始日の設定
- [ ] タグの追加・削除
- [ ] ノート（メモ）の追加

#### リスト管理
- [ ] リストの作成・編集・削除
- [ ] デフォルトリスト（Inbox）
- [ ] タスクのリスト間移動

#### スマートリスト
- [ ] フィルター条件によるタスク抽出
- [ ] 標準スマートリスト（今日、明日、今週、期限切れ）
- [ ] カスタムスマートリストの作成

#### 検索
- [ ] タスク名での全文検索
- [ ] フィルター条件での絞り込み

#### データインポート
- [ ] RTMエクスポートJSON読み込み
- [ ] データ変換・マッピング
- [ ] バッチインポート

#### 認証
- [ ] Googleログイン（唯一の認証方式）
- [ ] ログアウト

**認証方針**: Googleログインのみ。理由：セキュリティ最優先。既存デバイス（スマホ/Mac）があればログイン可能。

### 3.2 拡張機能（将来）

| 機能 | 説明 | 優先度 |
|------|------|--------|
| リピートタスク | 繰り返し設定 | 中 |
| リマインダー | プッシュ通知 | 中 |
| 場所連携 | 位置情報ベースのリマインダー | 低 |
| 共有リスト | 他ユーザーとの共有 | 低 |
| オフライン対応 | ローカルキャッシュ | 中 |
| ウィジェット | iOS/Webウィジェット | 低 |

---

## 4. 非機能要件

### 4.1 パフォーマンス
- 初期読み込み: 3秒以内
- タスク操作レスポンス: 500ms以内
- 1000件以上のタスクでもスムーズに動作

### 4.2 セキュリティ
- Firebase Security Rulesによるアクセス制御
- ユーザーは自分のデータのみアクセス可能
- HTTPS通信必須

### 4.3 可用性
- Firebase SLAに準拠（99.95%）

### 4.4 スケーラビリティ
- 個人利用を想定（1ユーザー数千タスク）
- 将来的なマルチユーザー対応を考慮した設計

---

## 5. プロジェクト構造

```
TodoBridge/
├── doc/                          # ドキュメント
│   ├── 00_PROJECT_OVERVIEW.md    # 本ファイル
│   ├── 01_DATA_MODEL.md          # データモデル設計
│   ├── 02_SCREEN_DESIGN.md       # 画面設計
│   ├── 03_API_DESIGN.md          # API/サービス設計
│   └── 04_DEVELOPMENT_PLAN.md    # 開発計画
│
├── web/                          # Web版（Vue 3）
│   ├── src/
│   │   ├── components/
│   │   ├── views/
│   │   ├── stores/
│   │   ├── services/
│   │   ├── types/
│   │   ├── utils/
│   │   └── router/
│   └── ...
│
├── ios/                          # iOS版（SwiftUI）
│   └── TodoBridge/
│       ├── App/
│       ├── Models/
│       ├── Views/
│       ├── ViewModels/
│       ├── Services/
│       └── Utils/
│
└── firebase/                     # Firebase設定
    ├── firestore.rules
    ├── firestore.indexes.json
    └── firebase.json
```

---

## 6. 開発フェーズ

### Phase 1: 基盤構築（Web版）
- プロジェクトセットアップ
- Firebase設定
- 認証機能
- 基本UI構造

### Phase 2: コア機能（Web版）
- タスクCRUD
- リスト管理
- タグ管理

### Phase 3: 高度機能（Web版）
- スマートリスト
- 検索機能
- RTMデータインポート

### Phase 4: iOS版開発
- プロジェクトセットアップ
- 認証・基本UI
- タスク/リスト管理
- スマートリスト・検索

### Phase 5: 最適化・リリース
- パフォーマンス最適化
- テスト
- デプロイ

---

## 7. 参考資料

- [RTMエクスポートデータ](./rememberthemilk_export_*.json)
- [Firebase Documentation](https://firebase.google.com/docs)
- [Vue 3 Documentation](https://vuejs.org/)
- [SwiftUI Documentation](https://developer.apple.com/documentation/swiftui)
