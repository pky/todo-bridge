# 表示テーマ

## Sub-features

設定画面のアカウントタブで「ライト」「ダーク」「端末に合わせる」を選ぶ。選択は端末に保存され、再読み込み後も反映される。「端末に合わせる」は端末の配色変更にも追従する。

## How to get to it (user POV)

認証後に `/settings` を開き、アカウントタブの「表示」を使う。

## Driving it with e2e

`npm run verify:e2e:theme` を使う。既存の認証済みEmulator fixtureを利用し、カレンダーの設定取得はローカル応答に置き換える。radioはアカウント領域の「テーマ」グループから表示名で選ぶ。

## Proof

初期値ライト、ダーク選択時のhtml属性・body背景色・localStorage、再読み込み後の選択維持、ライトへの復帰、端末設定への追従を確認する。別ケースでアプリの外部JavaScriptを遮断し、未マウントでも保存済みダークの属性が付くことを確認する。画像と実行証跡の保存先は `.e2e/proof/theme/`。状態は untested。

## Gotchas

端末設定のエミュレーションには `browser.emulateMedia`、アプリJavaScriptの遮断には `browser.route` を使う。外部JavaScriptを遮断したケースでは設定画面の操作は行わず、初期化スクリプトの結果だけを確認する。
