# TodoBridge 開発ガイド（Claude Code）

共通ルールは AGENTS.md に集約している。

@AGENTS.md

## Claude Code 固有
- PR を開く前の差分レビューは fresh-reviewer エージェントに任せる。実装したコンテキストで自己採点しない
- `claude --worktree <name>` で作った worktree には .worktreeinclude のローカル専用ファイルがコピーされる
