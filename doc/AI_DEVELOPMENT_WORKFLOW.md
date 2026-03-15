# AI 開発ワークフロー

## 目的

TodoBridge では、AI コーディングエージェントを設計補助、実装補助、検証補助に利用しています。目的は開発速度そのものより、変更の整理、論点の明確化、検証漏れの削減です。

## 基本方針

- AI には調査、設計の叩き台、コード修正案、テスト観点の洗い出しを担当させる
- 実際の採用可否は、人間がコードと挙動を見て判断する
- バグ修正では、表面的なガード追加より根本原因の特定を優先する
- 変更は最小差分で行い、関係ないファイルは触らない

## 実装フロー

1. 変更対象の責務と影響範囲を確認する
2. 必要なら設計資料や既存コードから前提を整理する
3. AI に実装案やテスト観点を出させる
4. 人間が差分の妥当性を確認し、必要なら方針を修正する
5. 対象を絞ったテスト、型チェック、ビルドで検証する

## AI に期待すること

- 論点の分解
- 調査範囲の絞り込み
- 根本原因の候補整理
- 小さくレビューしやすい差分の提案
- 変更後に必要な検証コマンドの提案

## 人間が責任を持つこと

- 要件と優先順位の決定
- 設計判断
- 差分の採否
- セキュリティ判断
- 最終的な検証とデプロイ

## このリポジトリで重視している点

- 最小差分
- 根本原因の修正
- 影響範囲の小さい検証から始めること
- 作業用メモや内部資料と、公開資料を分けて管理すること

## 関連ファイル

- [README.md](../README.md)
- [AGENTS.md](../AGENTS.md)
- [CLAUDE.md](../CLAUDE.md)
- [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md)
- [REQUIREMENTS_TEMPLATE.md](./REQUIREMENTS_TEMPLATE.md)
- [RETROSPECTIVE_REQUIREMENTS_EXAMPLE.md](./RETROSPECTIVE_REQUIREMENTS_EXAMPLE.md)
- [FEATURE_IMPLEMENTATION_TEMPLATE.md](./FEATURE_IMPLEMENTATION_TEMPLATE.md)
- [EXAMPLE_FEATURE_PLAN.md](./EXAMPLE_FEATURE_PLAN.md)
