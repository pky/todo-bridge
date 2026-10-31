# 認証済み画面

## Sub-features

- 認証後のモバイルニュース画面を直接開く。
- UI と Auth Emulator の UID をそろえ、Firestore ルールに従って読む。

## How to get to it (user POV)

通常は `/login` から認証後に移動する。検証では実アカウントを使わず、fixture が匿名認証を準備して `/news/mobile` を開く。

## Driving it with e2e

`web/verification/tests/smoke.e2e.ts` を `cd web && npm run verify:e2e:smoke` で実行し、「モバイルニュース」の heading と `important-title` を検証する。ライブはこのテストを指定して `open_session`→`observe`→`locate` を行う。

## Proof

ログインへ戻されず、認証済み見出しと Emulator に seed した記事が表示される。Google 認証フロー自体は未検証。

## Charters

```text
auth-navigation|mobile-web|skeptic|Emulatorの検証ユーザーで /news/mobile を再読み込みし、認証済み画面が維持されるか調べる
```

## Gotchas

mock-auth-state だけでは SDK は認証されない。保存処理の検証には同一 UID の Auth Emulator 認証が必要。
