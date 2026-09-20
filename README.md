# bridge

bridgeは、主軸となる会話から別のエージェントへ必要な補助作業を依頼し、結果を主軸へ
戻すプラグインです。デスクトップアプリで使え、やり取りを各アプリの標準メッセージUIで
読めることを目指します。宛先の選択と通信はエージェントが担当します。

## 主軸の会話から補助作業を依頼する

主軸はCodex・Claudeのどちらにも置ける設計です。指定がなければ、利用者が現在作業している会話を
主軸とします。アプリごとに役割を固定せず、主軸が作業全体の判断と最終回答を
担当し、補助会話には目的・必要な背景・欲しい結果・終了条件を絞って1回依頼します。
補助会話が1回回答したら主軸へ戻り、主軸が結果を使って作業を進めます。
宛先は主軸側で文脈を照合して選び、利用者が毎回互いの会話IDを指定する運用を前提にしません。

追加の問い合わせは、主軸が未解決の問題と必要性を判断して行う別の依頼です。
受領のお礼、同じ確認の繰り返し、相手の回答をそのまま送り返す処理で会話を継続させません。
補助側は結果や不足情報を返信して終了し、自律的に別の会話へ依頼を連鎖させません。
作業中の相手にも依頼は1回だけ送り、受付後は同じ依頼の結果を待ちます。
返信待ちの状態確認は本文の再送や相手への追加発言ではありません。

これはエージェントの利用手順です。プログラムに自動対話ループはありませんが、主軸が
新しい送信ツールを何回呼ぶかや、合計トークン数を機械的に制限する機能はありません。
依頼には必要な文脈だけを含め、結果の長さを先に指定します。実機試験のように本文の完全保持が
必要な場合は、省略・要約しません。中継役が転送を判断する処理にも、その役を担う
CodexまたはClaudeのトークンを使います。MCPツール内での受信待機自体はモデルを生成しません。
状態確認の結果を主軸のエージェントが読む処理にも、モデルの利用が伴う場合があります。

## デスクトップ対応の実現状況

2026-09-10の実機試験と2026-09-11に提供された画面・会話情報、新規実装の状態を分けて記載します。

| 項目 | 状態 |
| --- | --- |
| Codexを主軸にClaude Desktopへ補助依頼を送り、回答を回収する | 実機確認済み。起動中の端末中継が必要 |
| Claude側の標準メッセージUI | 中継からの受信カードと、Claudeの通常回答を確認済み |
| Codex側の標準メッセージUI | 主軸Codexが回収した回答を通常回答に掲載する経路は確認済み。既存Codex補助タスクへの受信表示は、下記の待受経路で実機検証が必要 |
| Claudeなどを主軸に既存Codexへ補助依頼を送る | Codex内の専用待受タスクを使う経路を実装済み。実機未検証。外部からの直接再開は検証対象で `host_owns_thread` により拒否された |
| プラグイン導入だけで準備を終える | 未達。現在の中継は初回に端末操作と開発用確認が必要 |

双方の画面で結果を読めることと、双方へ相手発信の新規メッセージを配送できることは
別の評価です。どちらを主軸にしても使えることを完成条件とし、新しいCodex待受経路の
実機往復と表示を確認するまでは、その条件を達成したとは扱いません。

## ツール

通常の送受信はチャットで依頼し、エージェントが次のツールを呼び出します。

| ツール | 機能 |
| --- | --- |
| `bridge_capabilities` | 利用できる経路と未対応範囲の診断 |
| `bridge_list` | 作業ディレクトリに属するCodexタスクの一覧 |
| `bridge_read` | 指定したタスクの履歴取得 |
| `bridge_send` | 指定した既存タスクに1ターン送信し、その返信を取得 |
| `bridge_discover` | プロジェクト横断の候補検索 |
| `bridge_bind` | 選定したタスクと作業フォルダを照合し宛先を固定 |
| `bridge_continue` | 固定した宛先への継続送信 |
| `bridge_claude_sessions` | 公式CLIで既存Claudeセッションを一覧取得（配送可否とは別） |
| `bridge_claude_discover` | 設定済みClaude Channels受信先の識別情報を照合して一覧化 |
| `bridge_claude_send` | 選択したpeerId・sessionIdへの送信と返信取得。`forwardTo` で中継先の既存Claudeセッションを指定 |
| `bridge_claude_submit` | 本文を1回送って受付番号を取得。相手が作業中でも、その依頼への返信を後から待てる |
| `bridge_claude_wait` | 受付番号を指定し、同じ依頼の返信とセッションの状態を確認。本文の再送はしない |
| `bridge_claude_reply` | 中継経由で受け取った本文の封筒行にある `message_id` と `reply_to` を使い、送信元へ返信を返す |
| `bridge_codex_discover` | 設定済みCodex待受先を照合。`ready` は受信待機中だけ有効 |
| `bridge_codex_submit` | 待受タスク経由で選定済み既存Codex補助タスクへ1回依頼し、受付番号を取得 |
| `bridge_codex_wait` | 同じ受付番号の回答を確認。本文の再送や別ターンの完了で代用しない |
| `bridge_codex_reply` | Codex補助タスクが封筒行の受付番号を使い、元の依頼へ1回答を返す |
| `bridge_codex_receive` | 利用者が指定したCodex待受タスクで、1件の依頼を期限付きで受け取る |
| `bridge_codex_report` | 待受タスクが標準送信機能の配送結果を記録。補助タスクの回答とは別 |

共通スキル `messaging` は候補の文脈照合と返信先の維持を行う手順です。Codex同士・Claude Code同士では利用可能な標準の一覧・送信機能を優先します。意味に基づく宛先選択はエージェントが担当し、語句検索だけで送信先を決めません。

宛先ハンドルは1時間またはMCPプロセス終了まで有効です。他のセッションへ渡す返信アドレスや送信者の認証情報ではありません。アプリが保持しているタスクではApp Serverの再開が競合する場合があります。その場合は本文を送らず終了します。

例：「bridgeで、作業フォルダ○○にあるタスクID○○へ『この3行だけ返してください…』と送ってください」。
送信には明示的な依頼が必要です。本文の改行・記号を保持します。
App Server直送では、アクセス可能な既存の待機中タスクを対象とし、threadIdとturnIdで応答を照合します。
中継経由では作業中の既存タスクにも1回送り、同じmessageIdの回答を待ちます。
宛先は特定の検証タスクに固定していません。
新規作成・アーカイブ解除・自動再送はしません。送信結果不明の場合は履歴を確認してください。

**Claude Desktop既存会話との往復は、2026-09-10に画面操作なしで実機確認済みです**
（後述の中継セッション経由）。Codexの結果は `status: "replied"` で返信本文を持ち、
Desktop会話には封筒行付きの本文がセッション間メッセージとして表示されました。
このTEST-4ではDesktop側が返信用スクリプトを使いました。その後、同日の
BRIDGE-PLUGIN-WAIT-1/2で、新しいDesktop会話 `bridge-36` を3候補からID・名前・cwdと
初回の回答内容で選び、同じ会話への2回の送信と `bridge_claude_reply` による返信を確認しました。
試験1では `submit` 1回の後、同じ受付番号の `wait` が2回 `pending`、3回目に `replied` となりました。
両試験とも宛先での受信と返信ツール呼び出しは各1件で、返信4行は改行・記号を含めて一致しました。
試験1の送信側は導入済み新版へのMCPクライアント接続、試験2はこのCodex会話に読み込まれた
従来の送信ツールです。2026-09-11に利用者が提供した「Bridge接続確認」の会話情報で、
両試験の中継からの受信メッセージと、返信4行を含む通常回答を確認しました。
WAIT-2は添付画像上でも受信カードと返信4行を確認しました。試験名の文字列自体を
成功の証拠とはせず、送受信結果・返信ツールの実行記録・この表示を照合しています。
Codexを補助先とする新しい待受経路の実機往復は未確認です。
Computer Useは運用上の依存から外しました。通常の送受信や失敗時の代替には使用せず、
利用者の作業中のウインドウを切り替えません。目標は既存セッションを選び、
画面操作なしで双方向に送受信し、双方の標準UIに本文と返信を残すことです。

完成判定には、次のすべての実機確認が必要です。自動試験の合格だけでは完成としません。

- 複数の既存会話から、依頼の文脈と会話ID・作業フォルダを照合して宛先を選べる。
- Codexから既存Claude DesktopのCode会話へ、画面操作なしで本文を配送できる。
- Claudeから選定した既存Codexタスクへ配送でき、継続時も同じ宛先へ戻れる。
- 本文と返信が双方の標準メッセージUIに残り、改行・記号を保持する。
- 通信中に利用者のアクティブウインドウを変更しない。
- 主軸が必要な補助依頼を行い、回答後は主軸へ戻る。相互の自動対話を既定にしない。
- 主軸をCodex・Claudeのどちらにも置け、宛先となるアプリに応じて配送経路を選べる。
- 拒否時に停止し、結果不明時に自動再送しない。別のCLI会話の作成・再開や
  画面入力によって、未達の配送を成功扱いしない。

## Codex待受タスク経由の配送（実装済み・実機未検証）

Claudeなどの主軸からCodexへ依頼するときは、Codex内に利用者が認めた専用の
**待受タスク**を1つ置きます。待受タスクと、実際に補助作業を行う既存タスクは別です。
Codexが主軸の場合のClaude中継経路も維持し、主軸をどちらかのアプリに固定しません。

1. 待受タスクが、自身のIDと標準の一覧・履歴・送信ツールを確認し、
   `bridge_codex_receive` で1件待ちます。受信待機中だけ探索結果が `ready: true` になります。
2. 主軸が補助タスクのID・作業フォルダと文脈を照合し、`bridge_codex_discover` で待受先を
   確認して `bridge_codex_submit` を1回呼びます。補助タスクが作業中でも同じ手順です。
3. 待受タスクが依頼の期限と宛先を標準の `read_thread` で再照合し、
   `send_message_to_thread` で `forwardBody` を1回そのまま送ります。
   標準機能が `delivered` / `queued` を明示した場合だけ `bridge_codex_report` に記録します。
   タスクIDだけが返った場合は配送状態を断定せず、報告ツールを呼ばずに終了します。
   どちらの場合も補助作業や次の受信を始めず、再送しません。
4. 補助タスクが封筒行 `[bridge codex message_id="…" reply_to="…"]` に対応する
   `bridge_codex_reply` を1回呼び、同じ回答を自身の通常回答にも表示します。
5. 主軸が `bridge_codex_wait` で同じ受付番号の回答を取得し、通常回答へ反映して作業を続けます。

配送状態の報告がなくても、補助タスクから同じ受付番号への返信が届けば回答を取得できます。

待受タスクは自身へ転送しません。送信先が変わった場合、期限切れ、標準送信機能がない場合は
送らず終了します。受信側に新しい返信ツールが読み込まれていない場合も、別のCLI会話や
返信スクリプトへ切り替えません。`wait_threads` が返した別の先行作業の完了を、この依頼への
回答とは扱わず、必ず `messageId` に対応する返信で判定します。

接続設定は既存の所有者専用 `~/.config/bridge/peers.json` に追加します。Codex用の項目の雛形は [`relay/codex-peers.example.json`](relay/codex-peers.example.json) です。
`protocol: "bridge-codex-inbox-v1"`、`id` と `sessionId` は例えば `codex-relay-1`、
`url` は `http://127.0.0.1:8791` とし、32バイト以上のランダムな秘密の `token` を持たせます。
Claude中継の項目とポートを共用しません。これはbridge自身の受信口であり、Codexアプリの
非公開ソケットへは接続しません。トークンを回答・コマンド行・Gitに載せません。

待受の依頼例は「このタスクをbridgeの待受役にしてください。`codex-relay-1` で10分間、
1件だけ受け付け、選定された既存補助タスクへ標準機能で転送したら終了してください」です。
`receive` のサーバー側の既定は10分、最大1時間です。ただし、アプリ側のツール実行制限が
先に到達する場合は待受が中止されます。通常のCodex MCPの既定制限は
[60秒](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options) であり、
プラグイン経由での90秒待受は実機確認が必要です。長時間の待受を保証していません。
依頼なしで期限を迎えた場合も終了し、
休止中の自動起動や無限の受信待機は行いません。再び受け付けるには待受開始の依頼が必要です。
1件の処理中は新規受付を行いません。待受終了後も、既に受け付けた依頼の回答は
MCPプロセスが動いていれば取得できます。依頼と回答はメモリ内だけに保持し、依頼期限は
既定30分・最大1時間、完了結果の保持は5分です。プロセス終了後の復元はできません。

標準送信によって補助タスクへユーザーターンを届ける設計で、外部の送信者バッジを作りません。
`accepted` は待受口への受付、`delivered` / `queued` は標準送信の配送結果、`replied` は
同じ受付番号への回答取得です。どれも画面表示の証拠とは別です。実機検証では、補助タスクの
受信ターンと通常回答、主軸で取得した回答、改行・記号の一致を照合します。

既存Claude Desktop会話へのバックグラウンド配送は、中継セッション経由で実機確認済みです
（2026-09-10、TEST-4）。残る運用上の前提は、中継セッションを端末で起動しておくことです。
公式のセッション一覧は宛先の存在を確認する機能であり、配送APIではありません。
公式の[受信ソケットの説明](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)
にはスクリプトによる投稿と認証行がありますが、bridgeで使う本文送信形式の公開仕様は
未確認のため、ソケットへの直接投稿は実装しません。Channelsには次に示すホスト側の
オプトインが必要で、Desktopが起動するCLIにはそのオプションが付きません（2026-09-09、
v2.1.260の起動引数で確認）。そのため、以下の「中継セッション」で公式機能だけをつなぎます。

## 中継セッション経由のDesktop配送（0.5.0）

公式に文書化された3つの機能だけを直列につなぎます。ソケットの書式推測や画面操作は
使いません。

1. Codexのbridgeが、端末で起動した**中継Claudeセッション**へ公式Channels形式で本文を渡す。
2. 中継セッションのClaudeが、公式の`ListAgents`/`SendMessage`（[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)）で
   指定された既存Desktop会話へ本文をそのまま転送する。公式Desktop文書は、端末セッションから
   Desktop会話への配送をこの機能の対象と明記しています。Desktop会話は受信ソケットを
   持ち、`claude agents --json` に名前・sessionId・cwd付きで列挙されます（実測済み）。
3. 中継は `SendMessage` が配送済みと報告した時点で `outcome: "delivered"` を記録し、
   Codexの要求は返信待ちのまま保持する。Desktop会話は返信に `SendMessage` を使えず
   （Desktopアプリが起動時に `--disallowedTools SendMessage` を渡していることを
   2026-09-10に確認）、当時Codexアプリが保持していた検証対象への外部からの `thread/resume` は
   `host_owns_thread` で拒否された（同日実測）ため、Desktop側は届いた本文の1行目
   `[bridge relay message_id="…" reply_to="…"]` を使って `bridge_claude_reply` を呼ぶ。
   これが中継の受信口 `POST /replies` に届き、待機中の `bridge_claude_send` が
   `status: "replied"` と返信本文を受け取る。期限内に返信がなければ、中継が報告した
   `delivered` または `queued` で終わる。どちらも宛先での画面表示を証明しません。
   中継自身の回答では転送要求を完了できず、宛先は返信用ツールを使う必要があります。

送信側は `bridge_claude_sessions` で宛先の `name`・`sessionId`・`cwd` を選び、
`bridge_claude_send` に `forwardTo: {name, sessionId, cwd}` を渡します。送信直前に
公式CLIの一覧と再照合し、名前やcwdが変わっていれば送らずに失敗を返します。中継にも
転送直前のID・名前・cwdの再照合を指示します。この確認と標準送信操作は別々であり、
途中のセッション交代まで原子的に防ぐ仕組みではありません。中継先で
候補が0件または複数なら、中継は `outcome: "undeliverable"` で失敗を返し、再送しません。

初回は `relay/peers.example.json` を参考に、32バイト以上のランダムなトークンを含む
所有者専用（0600）の `~/.config/bridge/peers.json` を用意します。`id` が `relay-1` の
項目を中継と送信側で共用します。導入済みの設定があれば作り直す必要はありません。

中継セッションの起動（bridgeフォルダ内で端末から実行。開発用フラグの確認画面に
自分で答えます）。秘密の環境変数の手入力や `relay.env` の読み込みは不要です:

```bash
claude --name relay-1 --strict-mcp-config --mcp-config relay/mcp.relay.json --allowedTools "ListAgents,SendMessage,mcp__bridge__bridge_claude_sessions,mcp__bridge__bridge_channel_reply" --dangerously-load-development-channels server:bridge
```

起動画面の `Channels (experimental) messages from server:bridge inject directly in this session`
に加え、`/mcp` のbridge接続とCodex側の `bridge_claude_discover` による `relay-1` の
検出を確認します。Channelsの案内だけでは受信口が起動した証拠になりません。
中継と送信側は同じ `~/.config/bridge/peers.json` を読みます。別の場所に置く場合だけ
両方に `BRIDGE_CHANNEL_PEERS_FILE` を指定します。

`Failed to reconnect to bridge` の場合はMCPの起動記録を調べます。2026-09-10には
`Channel token must contain at least 32 bytes` により起動直後に終了していました。
旧設定の環境変数による受け渡しを、上記の所有者専用ファイルからの読み込みへ変更しました。
設定変更は実行中セッションに反映されない場合があるため、中継を通常の手順で終了して
から同じ起動コマンドで起動し直します。配送の再送や権限設定の変更では解決しません。

配布物の更新と、起動中の会話への読み込みは別です。2026-09-10、端末の中継では
MCP再接続後の転送を確認しましたが、既存Desktop会話の `/mcp disable bridge` は
`Reconnect, enable, and disable aren't available in this session.` と拒否されました。
端末向けの接続切り替え手順をDesktop会話にも使えるとは案内しません。
公式の [`/reload-plugins` の説明](https://code.claude.com/docs/en/discover-plugins#apply-plugin-changes-without-restarting)
も、DesktopではプラグインMCPサーバーの接続変更を適用しないとしています。
新版が読み込まれたかは `bridge_capabilities` の `buildRevision` と返信ツールの有無で
確認し、既存会話の更新が確認できないまま完了扱いにしたり、宛先を新規会話へ切り替えたりしません。

### 中継の起動スクリプトと自動起動の制約

`relay/start-relay.mjs` は、公式のバックグラウンド起動（`claude --bg`）で中継を立ち上げ、
チャネルが本当に登録されたかを受信口経由の応答確認（probe）で確かめてから結果を返します。
秘密の値はコマンド行に出しません。同名の稼働中セッションや使用中ポートがあれば起動しません。

```bash
node relay/start-relay.mjs --check
```

`--check` は公式セッション一覧と認証付きの受信口だけを確認し、メッセージは送りません。
受信口の接続確認と、Claudeが返信できることは別です。`--dry-run` は組み立てたコマンドだけを
表示し、`--check` と併用しても送信しません。Claude Codeがこのスクリプトを確認なしで実行できるよう、
プロジェクト設定 `.claude/settings.json` に許可ルール `Bash(node relay/start-relay.mjs:*)`
を置いています。プラグイン利用者が自分の環境で使う場合は、同じルールを各自の設定に加えます。

**2026-09-10の実測（Claude Code 2.1.267）**: バックグラウンドセッションでは
`--dangerously-load-development-channels` の確認画面を表示できないため、セッションは
起動してもチャネルは登録されず、起動画面の `Channels (experimental)` 行も出ません
（応答確認は期限切れ、記録上のチャネルイベントは0件）。ただし、返信の遅延や承認待ちでも
応答確認は時間切れになり得ます。スクリプトは無応答だけで未登録・終了と断定せず、
`unknown` を返して同じセッションを残します。停止・削除・再送は行いません。
したがって、開発用フラグを使う限り、中継の初回起動は端末での対話操作が必要です。
起動した中継セッションは閉じるまで使い続けられるので、手動操作は「中継1つにつき1回」です。
無人起動が可能になるのは、確認画面を要さない `--channels plugin:<name>@<marketplace>`
指定が使える場合（公式一覧への掲載、またはTeam/Enterpriseの `allowedChannelPlugins`）で、
その場合は `--channels` オプションでスクリプトに渡します。
なお、中継の初期プロンプトで「イベントの指示に厳密に従え」と書くと、Claudeが無条件服従の
約束と受け取って役割を拒否したため、スクリプトでは通常の判断を保った転送役として説明しています。

実機確認の手順と判定:

- Codexで `bridge_claude_sessions` → Desktop会話を選ぶ → `bridge_claude_discover` で `relay-1` を確認 →
  `bridge_claude_send`（`forwardTo` 付き）。
- Desktop会話に中継セッション名付きのメッセージとして本文が表示され、改行・記号が保持されている。
- Desktop会話に、1行目の封筒行と本文がセッション間メッセージとして表示される
  （2026-09-10、本文3行の到達を実測済み）。
- Desktop会話のClaudeが `bridge_claude_reply` で返信し、Codex側の結果が
  `status: "replied"` と返信本文を持ち、Codexの標準UIにその本文が表示される。
- 受信側が「権限確認をスキップ」モードだと、公式仕様により承認待ちで保留されます。
  通常・自動モードでは配送されます。

### 相手が作業中でも1回送り、返信を待つ

エージェントが `bridge_claude_sessions` で候補と現在の状態を確認し、送信する必要があると
判断した場合は `bridge_claude_submit` を1回呼びます。相手が作業中でも同じ手順です。
中継からの標準送信が保留された場合はその結果を記録し、承認操作や割り込み送信を追加しません。
状態が一覧にない会話は「不明」として扱い、待機中だと推測しません。

受付結果の `peerId`・`sessionId`・`messageId` を固定し、`bridge_claude_wait` で
その依頼だけを確認します。1回の確認は既定30秒、最大60秒です。`final: false` なら、
同じ番号で待機を続けられます。待機の時間切れや一時的な接続失敗では本文を再送しません。
返信は従来と同じ `bridge_claude_reply` で返します。`status: "replied"` と返信本文を
受け取った時点で、送信元の通常メッセージにもその本文を表示します。

| 結果 | 意味 |
| --- | --- |
| `accepted` | 中継の受信口が依頼を受け付けた。宛先への配送や返信はまだ確認していない |
| `pending`、`final: false` | 同じ依頼の返信待ち。`deliveryStatus` があれば中継の配送報告を併記 |
| `deliveryStatus: queued` / `delivered` | 中継が保留／配送と報告した。宛先の画面表示や返信の証明ではない |
| `replied`、`final: true` | この受付番号に対応する返信を取得した |
| `unknown` | 通信切断・要求期限・記録消失などで結果を確定できない。自動再送しない |

`sessionObservation` は確認時点の会話の状態で、返信の状態とは別です。返信の後に
次の作業が始まる場合もあるため、「作業中」の表示だけで取得済みの返信を無効にしません。
`final: true` は要求の待機終了を示し、成功の意味ではありません。要求期限に達した場合も
終了します。返信取得の成功は `status: "replied"` と返信本文で確認します。
待機要求の期限は送信時の `timeoutMs`（既定30分、最大1時間）で指定します。
要求と返信は中継プロセスのメモリ内だけに保持し、完了結果は5分間・最大64件です。
中継の再起動や結果の保存期間超過後は復元できません。恒久的なキューや台帳は作りません。
従来の `bridge_claude_send` は、1回の呼び出しで返信を待ち切る互換経路として残します。

Codex内のタスク同士では標準の `send_message_to_thread` と `wait_threads` を優先します。
Codex待受経由の依頼では、上記のとおり受付番号に対応する `bridge_codex_wait` を使います。
外部からの直接再開が `host_owns_thread` で拒否された経路を再試行しません。

この経路は中継のClaudeが転送を担うため、本文の完全一致は指示だけでは保証できません。
開発用フラグは研究プレビュー中の公式手段ですが、承認済みプラグイン以外の恒久的な
配布経路ではありません。TEST-4のスクリプト返信に加え、BRIDGE-PLUGIN-WAIT-1/2では
宛先の新しい返信ツールによる実機往復を確認しました。これらの試験本文では一致していますが、
任意の本文の完全一致を保証するものではありません。自動テストはプログラム内の文字列保持を
検証します。Claudeの転送を含む全経路の完全一致には、実際の送信本文・転送本文・返信を
照合する必要があります。

公式Channels形式の受信・返信処理は実装済みで、既定では無効です。有効化した中継
セッションでの受信と転送は2026-09-10に実機確認しました。`BRIDGE_CLAUDE_CHANNEL=1` と
`BRIDGE_CHANNEL_PEER_ID=relay-1` をMCP起動環境に指定すると、所有者専用の接続設定から
そのIDのセッション名・トークン・固定ポートを読み、127.0.0.1に認証付き受信口を開きます。
別のIDへ自動的に切り替えず、設定が見つからない場合は起動を止めます。
`BRIDGE_CHANNEL_PEER_ID` を指定しない場合に限り、従来の
`BRIDGE_CHANNEL_SESSION_ID`、32バイト以上の `BRIDGE_CHANNEL_TOKEN`、
`BRIDGE_CHANNEL_PORT`（未指定は空きポート）を使用できます。これらの設定だけでは
Claude側のChannelsオプトインは有効になりません。

受信口の `POST /messages` は `{sessionId, body, forwardTo?, timeoutMs?}` を受け取り、公式MCP通知で転送します。
`forwardTo` は通知の `forward_name` / `forward_session_id` / `forward_cwd` 属性になり、
本文は転送手順を書いた前置きと `-----BEGIN BODY-----` / `-----END BODY-----` の
区切りで包んで届けます。2026-09-09の中継記録で、中継側にMCPサーバーの
`instructions` が見当たらず、`SendMessage` と返信ツールが読み込み前（遅延ツール）の
状態だったため、通知本文そのものに手順を含める方式にしました。
Claudeが `bridge_channel_reply` を呼ぶまで成功とせず、タイムアウトは結果不明として
扱います。本文・改行は保持し、宛先不一致、認証なし、ブラウザ由来のOrigin付き要求を
拒否します。処理待ちはプロセス内だけに保持し、旧キューや台帳には書き込みません。
送信側は所有者専用ファイル（0600）のJSON配列から候補を読みます。既定の場所は
`~/.config/bridge/peers.json` で、`BRIDGE_CHANNEL_PEERS_FILE` で上書きできます。各要素は `id`, `sessionId`, `url`, `token` と任意の
`title` を持ちます。`url` は `http://127.0.0.1:ポート` のみ受け付けます。
これは接続設定であり来歴台帳ではありません。トークンをGitへ保存しないでください。
探索時に認証付きで識別情報を照合し、エージェントにはトークンを返しません。
送信時はpeerIdとsessionIdを再照合します。自動的な全Claudeセッションの発見や、
実行中DesktopへのChannels有効化は実装していません。
原典: https://code.claude.com/docs/en/channels-reference （2026-09-09確認）。

フック・旧キュー・常駐brokerは使用しません。ホストがMCPサーバーを管理し、Codex待受口は
明示した受信ツール呼び出し時に開きます。履歴取得などのApp Server用ツールは実行時に
公式Codex App Serverへ接続します。Node.js 20以上とログイン済みのCodexが必要です。

既存ホストが公開するApp Serverソケットへ接続する場合は、MCPプロセスの環境変数
`BRIDGE_CODEX_PROXY_SOCKET` にその絶対パスを指定できます。公式CLIの
`codex app-server proxy --sock` を同じJSONLクライアントで使用します。
未指定では従来の直接起動です。ソケットやdaemonは作成せず、接続失敗時も直接起動へ
切り替えません。ホストがソケットを公開していない場合、この設定では解決できません。
ソケット接続だけで標準UIへの表示や送信者表示を保証するものではありません。

Codex用の定義は `.codex-plugin/plugin.json`、Claude Code用は `.claude-plugin/plugin.json` にあります。
この環境ではCodexに `bridge@personal` として登録しています。新たに読み込んだタスクから利用できます。
Claude Codeにも `bridge@skills-dir` として導入し、公式CLIでスキルとMCPサーバーの認識を確認しています。起動中のDesktop会話は旧版サーバーを保持するため、新ツールは新しい会話から使えます。
Claude Codeの `/reload-plugins` はDesktopでも利用できますが、DesktopではMCPサーバーを
接続・切断しないと公式文書に記載されています。スキルの再読込だけで新しい返信ツールが
使えるとは判断せず、会話内のツール一覧と `bridge_capabilities` の `buildRevision` を確認します。
原典: https://code.claude.com/docs/en/discover-plugins#apply-plugin-changes-without-restarting

開発時は `npm ci`、`npm run build`、`npm run test:bridge` を実行します。
配布物 `dist/` は依存コードを同梱しており、インストール先でnpmを実行する必要はありません。
通信処理の原典と変更理由は `mcp/vendor/`、同梱ライセンスは `dist/licenses/` を参照してください。
MCP定義は[公式SDK](https://github.com/modelcontextprotocol/typescript-sdk) 2.0.0、
Codex設定の相対パスは[OpenAI公式プラグイン](https://github.com/openai/plugins/blob/main/plugins/openai-developers/.mcp.json)を参考にしています。

以下のAgent Skills資料は既存リポジトリ由来の参考資料として保持しています。bridgeの仕様ではありません。

---

# Agent Skills

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/MKPE9g8aUy)

A standardized way to give AI agents new capabilities and expertise.

## What are Agent Skills?

Agent Skills are a lightweight, open format for extending AI agent capabilities with specialized knowledge and workflows.

At its core, a skill is a folder containing a `SKILL.md` file. This file includes metadata (`name` and `description`, at minimum) and instructions that tell an agent how to perform a specific task. Skills can also bundle scripts, reference materials, templates, and other resources.

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

## Why Agent Skills?

Agents are increasingly capable, but often don't have the context they need to do real work reliably. Skills solve this by packaging procedural knowledge and company-, team-, and user-specific context into portable, version-controlled folders that agents load on demand. This gives agents:

- **Domain expertise**: Capture specialized knowledge — from legal review processes to data analysis pipelines to presentation formatting — as reusable instructions and resources.
- **Repeatable workflows**: Turn multi-step tasks into consistent, auditable procedures.
- **Cross-product reuse**: Build a skill once and use it across any skills-compatible agent.

## How do Agent Skills work?

Agents load skills through **progressive disclosure**, in three stages:

1. **Discovery**: At startup, agents load only the name and description of each available skill, just enough to know when it might be relevant.

2. **Activation**: When a task matches a skill's description, the agent reads the full `SKILL.md` instructions into context.

3. **Execution**: The agent follows the instructions, optionally executing bundled code or loading referenced files as needed.

Full instructions load only when a task calls for them, so agents can keep many skills on hand with only a small context footprint.

## Where can I use Agent Skills?

Agent Skills are supported by a large number of AI tools and agentic clients — see the [Client Showcase](https://agentskills.io/clients) to explore some of them!

## Getting started

- **[Documentation](https://agentskills.io)** — Guides and tutorials
- **[Specification](https://agentskills.io/specification)** — Format details
- **[Example Skills](https://github.com/anthropics/skills)** — See what's possible
- **[Discord](https://discord.gg/MKPE9g8aUy)** — Share what you're building!

## Open development

The Agent Skills format was originally developed by [Anthropic](https://www.anthropic.com/), released as an open standard, and has been adopted by a growing number of agent products. The standard is open to contributions from the broader ecosystem — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get involved.

## License

Code in this repository is licensed under [Apache 2.0](LICENSE). Documentation is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). See individual directories for details.
