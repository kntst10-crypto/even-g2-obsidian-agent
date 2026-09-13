# Vault Lens — Even G2 × Obsidian AI Agent

> **更新: 固定HTTPS中継版 0.2 を実装しました。現在の仕様・起動・配置手順は [PUBLIC-EDITION.md](PUBLIC-EDITION.md) を参照してください。G2 SDK統合、音声送信確認、PCコネクター、端末ペアリング、開発用 `.ehpk` を追加済みです。実ドメインへの公開配置・実機Beta・審査提出は未完了。以下は従来ローカル版0.1の説明です。**

Even G2から自分のノートを検索し、根拠を見ながら考え、確認して記録するための開発MVPです。

**これはブラウザとローカルサーバーで動く土台です。Even G2 SDK、G2音声入力、文字起こし、Even Hubパッケージはまだ接続・作成していません。公開済みプラグインではありません。**

## 現在できること

- Markdown本文・ファイル名のローカル検索（日本語の部分一致、上位5件、出典パスと行）。自然文の意味検索ではありません。
- OpenAI / Claude APIの切替と根拠抜粋付き回答。クラウド利用はサーバーの明示設定とリクエストごとの同意が必要です。
- LINE用文面の生成（送信機能はなし）。ローカルモードでは文面生成をせず、入力をそのまま表示します。
- Inbox / Daily Note / 指定ノートへの追記提案、確認、取消。
- 提案は5分で失効。競合検知と同じ提案の重複実行防止。Dailyは初期設定で日本時間。
- 日本語UIと短いページ単位の表示プレビュー。これは実機表示の忠実なシミュレーターではありません。

## 起動

Node.js 22以降を用意してください。ローカルサーバーはNode.js標準機能で動作します。G2接続準備用の公式SDK・CLI・Simulator・ビルド依存を追加済みです。`npm ci`で固定バージョンを導入できます。

1. `.env.example`を`.env`へコピーし、次のコマンドで生成したランダム値を`AGENT_TOKEN`へ設定。
2. 最初は同梱`demo-vault`で確認。本番Vaultはバックアップしたコピーから開始してください。
3. `npm test`、`npm run check`、`npm start`を実行。
4. `http://127.0.0.1:8788`を開き、接続トークンを入力。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm test
npm run check
npm start
```

API利用時だけ`.env`の`ALLOW_CLOUD=true`と、利用事業者のAPIキー・アクセス可能なモデルIDを設定してください。モデル名は固定していません。APIキーをUIやG2配布物へ入れないでください。ChatGPT / ClaudeのWebサービス契約を流用する実装ではありません。API課金・外部送信が別途発生します。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/vault.mjs` | 検索、安全なパス検証、追記提案・確認 |
| `src/providers.mjs` | ローカル・OpenAI Responses・Claude Messages |
| `src/server.mjs` | 認証HTTP API、同一Origin UI配信 |
| `src/g2-bridge.mjs` | G2接続アダプターの準備実装（UI未接続、実機未検証） |
| `public/` | G2連携前の操作・表示検証UI |
| `test/agent.test.mjs` | Vault、セキュリティ、APIアダプター、HTTP統合テスト |
| `demo-vault/` | 個人情報を含まないサンプル |

APIはすべて`POST /api/...`、`Content-Type: application/json`、`Authorization: Bearer <AGENT_TOKEN>`を使用。

| パス | 入力の例 |
| --- | --- |
| `search` | `{"query":"案件名"}` |
| `answer` | `{"question":"次の作業は？","query":"案件名","provider":"local","mode":"answer"}` |
| `proposals` | `{"destination":"inbox","content":"記録"}` / `{"destination":"note","path":"Projects/案件.md","content":"記録"}` |
| `confirm` | `{"id":"返された提案ID","confirm":true}` |
| `cancel` | `{"id":"返された提案ID"}` |

## セキュリティと制約

- サーバーは`127.0.0.1`にのみ待受。トークン必須、Host/Origin検証、認証済み60req/min・同時4件、リクエスト24KB上限。
- 外部通信は既定OFF。クラウドON時は質問と検索抜粋が事業者へ送信されるので、**完全ローカル処理ではありません**。検索はローカル、秘密鍵はサーバー側に保持。
- ノート内容は信頼できない資料として扱い、AIにはファイル操作ツールを渡しません。AIの出典番号は生成内容であり、個々の主張の根拠整合性を自動証明するものではありません。
- 検索は隠しファイル・リンクを除外。`.md`のみ。ファイル最大1MiB、走査5000件・深さ12まで。除外対象があるため網羅検索ではありません。
- 書込は追記のみで削除・既存本文上書きなし。相対パス検証、symlink/hardlink拒否、確認時ハッシュ検証を実施。
- 単一ユーザー・単一サーバープロセス向け。悪意ある同一PC上の別プロセスによるフォルダ差替え攻撃、外部アプリとの厳密な排他制御、書込途中の障害に対するトランザクション保証は対象外。Obsidian / Syncの同時編集を避け、バックアップを必ず用意してください。
- 書込提案はメモリ上のみ。再起動で失効。確認応答を取り逃した場合は、再提案前にノートで保存状況を確認してください。
- ブラウザのトークンは保存しません。監査ログ、端末ペアリング、資格情報失効管理、継続会話履歴、音声、意味検索は未実装。
- 外部への一般公開はしないでください。リモート実装段階では認証済み私設ネットワークとHTTPS中継を使い、`PUBLIC_ORIGIN`をHTTPS URLに合わせ、必要時のみ`CLIENT_ORIGIN`を実際のEvenアプリOriginに限定設定します。中継時のHostヘッダーも一致させます。

## 次に実装すること

提出指示を受けた2026-09-13の事前確認では、**公開接続先の設計決定が必要なため未提出**です。詳しくは`SUBMISSION-READINESS.md`を参照してください。

1. 利用PCのOS、Daily Noteの命名規則、Vaultと除外フォルダ、端末接続方針を確定。
2. Even公式SDKをバージョン固定し、ページ更新・タッチ入力・16kHz PCM音声をアダプターとして分離実装。
3. 文字起こし方式（ローカル / API）と音声保存・削除方針を決定。押して録音、文字起こしプレビュー、内容確認を実装。
4. 認証済みリモート接続、端末ごとのトークン、監査記録、除外範囲設定を追加。
5. 実機・切断復帰・日本語表示・二重送信・同時編集・プライバシーを検証。
6. Even Hubの現行要件に従いmanifest、通信許可先、プライバシーポリシー、アイコン、ストア説明を作成。限定テスト→審査。

## 調査とライセンス

2026-09-13に以下を閲覧しました。既存実装のコードはコピーしておらず、このMVPは独自実装です。公開ライセンス・著作権者・製品名はリリース前に決めてください。SDK導入時には依存ライセンスを別途確認してください。

- [Even Hub公式概要](https://hub.evenrealities.com/docs/get-started/overview) — Webアプリ、SDK、ハードウェア、テストから申請までの導線。
- [even-g2-obsidian](https://github.com/hiraghi/even-g2-obsidian) — 閲覧・編集・ミラーの参考。MIT表記あり。
- [Gbsidian](https://github.com/liyiyuian/g2sidian) — 音声キャプチャ・Daily追記・検索の参考。MIT表記あり。
- [OpenAI Text generation](https://developers.openai.com/api/docs/guides/text) — Responses APIのアダプター用。
- [Claude Create a Message](https://platform.claude.com/docs/en/api/messages/create) — Messages APIのアダプター用。

## 検証範囲

`npm test`では外部AIをモックに置き換えます。**実APIでの回答品質・課金・モデル対応、スマートフォンやG2の接続は未検証**です。リリース可能とみなす前にこれらの実機確認が必要です。
