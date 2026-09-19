# MyAtras — Claude Code 引き継ぎ

## 目的とユーザーの希望
日本科学未来館のジオ・コスモスのように、青い海と白い雲の地球をブラウザ（特にAndroid Chrome）で操作して、実際の雲の流れを見たい。静止画像を単に回す演出ではなく、SSECの異なる観測時刻を再生することが主目的。

GitHubへの公開コード登録はユーザーが了承済み。GitHub Pagesでの公開も了承済みで、`.github/workflows/pages.yml` が main への push ごと、`dist/` を公開する。観測の更新は自動では行わず、ワークフローを手動起動したときだけ `scripts/fetch-observations.cjs` で取得する（`fetch`・`frames`・`every` を指定。ランナーはSSECに到達できるが、エージェントのコンテナとスマホは到達できない）。取得に失敗したら同梱の観測をそのまま公開する。既定では取得物をcommitせず公開だけするので、実行が終われば同梱の観測に戻る。`commit` を真にすると取得した24枚を同梱として確定させる（約5MB）。いずれの場合も `records/published-observations.json` に公開した観測の時刻・SHA-256・取得元を記録する。毎日取得しないのは、1日分＝地球一周分で当初の目的を満たすため。公開先は https://ryo-tanohata.github.io/MyAtras/ で、ユーザーはこのURLをAndroid Chromeで開いて確認する。公式の未来館製品と表示しない。展示名「ジオ・コスモス」をサイト名や見出しに使わず、着想元として本文で触れるだけにする（画面上の名称は MYATRAS）。

## 起動
フレームワークやnpmインストールは不要。Python 3で `python -m http.server 8000 --directory dist` を実行し、ブラウザで http://localhost:8000 を開く。
単体HTMLは `python scripts/export-html.py` で生成。出力 `dist/myatras-clouds.html` はGit管理外。
`scripts/export-inline-earth.py` はChatGPT内表示専用で、Pillowと固定の `/workspace` 出力先を使用する。通常のブラウザ起動には不要。
ヘッドレスでの自動確認は `node tools/check-webgl.cjs`（`--shots` で画面保存、`--unity` で `dist/unity/` を確認、`--desktop` でPC幅）。npm依存はなく、Chromiumがあれば動く。

## 実装済み
- 生のWebGLで地球、ドラッグ・ピンチ、回転、照明を描画。
- 2026-09-18 01:00 〜 09-19 00:00 UTCの24枚（1時間ごと、地球一周分）の全球赤外線観測を順に再生。公開ワークフローの手動実行（`commit` 指定）で取得し同梱にしたもの（`9b8b930`）。最初の同梱（2026-09-16の13枚）は履歴にある。日時は日本時間で表示。データは保存時点の観測であり常時最新ではない。
- 地表参考画像に観測輝度から白い層を合成。チェックボックス「元の白黒観測を表示」で元の観測に戻せる。地球回転は初期OFF。
- 最新取得、再生速度、時刻選択、キャッシュ、取得失敗時の保持。
- 「読み込む観測の数」は「最新を取得」で読み直すときの時刻数で、24（1日分・既定）か12（軽い）。SSECの一覧は直近24時間・1時間ごとなので24が上限。SSECが列挙した時刻しか使わず、足りない分を作り出さない。変更すると再生は止まる。
- 観測の切り替わりは380ms以下の溶け込み（`dist/observation-fade.js`）。画面上の2枚はどちらも実観測で、閾値は各観測に個別に適用し、描画結果だけを混ぜる。中間時刻の観測は作らない。日時は溶け込み先の観測を指す。溶け込むのは1時間後の観測へ進むときだけで、最新から最古へ戻るとき（12時間の飛び）や、時刻選択・再取得のときは即座に切り替える。「観測の切り替わりをなめらかに」で解除できる。Unity版も同じ規則（`unity/MyAtras/Assets/Scripts/ObservationPlayback.cs`）。
- 別モード「立体の模型」はSSEC AMV風向・風速を使う簡易移流。雲の形や量は模型で、実際の雲分布・気象予報ではない。

## 主要ファイル
- `dist/app.js`: 地球シェーダー・入力・表示統合。白い雲の合成と透かし保持もここ。
- `dist/data-sources.js`: 同梱データの取得。配信時はJSONを読み、単体HTMLでは埋め込み済みの `window.GEO_*` をそのまま使う。
- `dist/weather.js`: 観測API、時刻、読み込み、エラー処理。
- `dist/weather-playback.js`: 時系列再生。
- `dist/weather/sequence/manifest.json`: 観測ファイル・時刻・取得元URL・SHA256。`dist/weather/snapshot.json` も同じ形式。
- `dist/cloud-model.js`, `dist/cloud-simulation.js`: 数値風による模型。`dist/data/amv.json` が同梱の観測風。
- `dist/index.html`, `dist/style.css`: UI。
- `scripts/export-html.py`: 単体HTML生成。埋め込み時にSHA256を再照合し、不一致ならビルドを止める。
- `scripts/build-amv.cjs`: 取得したAMV GeoJSONから `dist/data/amv.json` を作る。
- `scripts/fetch-observations.cjs`: 同梱観測を最新に入れ替える。時系列・両製品のスナップショット・`--wind` で観測風。枚数は `--frames N`（既定13）、間隔は `--every M`（分）。SSECが出している間隔を実行時に表示するので、細かい観測があるかを見てから決められる。1枚約200KBで、ページは全枚数を読み込んでから再生を始める。画像の `RE-Time` ヘッダと要求時刻が一致しなければ停止し、別時刻として保存しない。古いフレームは削除。**SSECに到達できる機械で実行**（エージェントのコンテナからは403で不可）。実行後は `python scripts/export-html.py` と `node tools/check-webgl.cjs` を通して `dist/` をcommit。
- `tests/harness.cjs`: テスト用の最小DOMと通信スタブ。観測の中身は偽装しない。

## Unity版の方針
ユーザーの決定により、Unity版はWebGL（Unity 6の表示名は「Web」、実体は `BuildTarget.WebGL`）で作り、ビルド成果物を `dist/unity/` にcommitして同じPagesサイトの `/unity/` で公開する。JS版はルートのまま残す（併存）。
エージェントのコンテナにはUnity Editorもライセンスも無いためビルドはできない。ビルドはユーザーのローカルで行い、成果物をcommitする。詳細と必要なPlayer設定は `unity/README.md`。
2026-09-18、Windows（SHINYLABRY0）に Unity 6000.4.8f1 と Web Build Support を Unity Hub のCLIで導入し、初ビルドに成功（エラー0・警告0、約4MB）。Hub をVS Code拡張のシェルから起動すると `ELECTRON_RUN_AS_NODE=1` のせいで Node として動き `Cannot find module '--headless'` で失敗するので、この変数を外して起動する。
ビルドコマンド：`Unity.exe -batchmode -nographics -quit -projectPath unity/MyAtras -executeMethod MyAtras.WebGlBuild.Build -logFile <log>`。確認は `node tools/check-webgl.cjs --unity`（`dist/` を配信して `/unity/` を開く＝Pagesと同じ配置）。
Unity版は独自のWebGLテンプレート（`unity/MyAtras/Assets/WebGLTemplates/MyAtras`）でJS版と同じページ・同じ `style.css` の中に描画する。文字はすべてHTML側で、Unity内にフォントは持たない。操作はSendMessage、状態は `MyAtrasBridge.jslib` 経由でページへ渡す。
Unity版だけの機能として、各観測時刻の実際の太陽の位置で昼夜を描き（`SolarPosition.cs`、天文年鑑の簡易式、`SolarPositionCheck.cs` で春分・秋分・夏至を検証）、夜側にNASA Black Marble 2016の街明かりを表示する。街明かりは固定画像で現在の観測ではないとページに明記している。大気はその太陽光のレイリー散乱とミー散乱の一次散乱を計算して描く（Nishita の方法、厚さ6倍・濃さ1/6で真上の光学的厚さは実際どおり、多重散乱は省略）。青い縁・夕焼け・太陽が裏にあるときの橙と青の輪は計算から出ており、色は指定していない。背景の星はエール輝星星表の6等星まで（`scripts/build-stars.py` で `dist/assets/stars.png` を生成、入力のSHA-256を照合）を恒星時で回して正しい位置に置き、明るい8星が予測画素に写ることを確認済み。雲の立体感と影は赤外線の明るさから推定した相対的な高さを10倍に誇張した演出で、実際の高さではないとページに明記している。夜側では街明かりが光のにじみとともに灯り（薄い雲の下も雲を照らす）、陸と海の境目が分かるよう Natural Earth の海岸線（`scripts/build-land.py` → `dist/assets/land.png`）を補助線として描く。観測風（`dist/data/amv.json`、JS版と同じファイル）を `WindField.cs` で1°格子にし（観測点から2.5°以内のみ、`WindFieldCheck.cs` で検証）、流れの筋として描く。風は1時刻だけの観測で、再生中の各時刻の風ではないとページに明記している。スマホでのカクつき対策として、太陽方向の光学的厚さは起動時に作る参照表（`AirDepthTable.cs`、`AirDepthCheck.cs` で検証）を引き、ページへの状態報告は変化時だけJSONを作り、フレーム時間に応じて描画解像度を自動で下げる（下限50%、ページに表示）。
2026-09-19、ユーザーの希望で「それっぽく見える」模型の方向へ振った。Unity版の既定は「風で流す模型」で、毎時の実観測の間を、前の観測を風で前へ・次の観測を風で後ろへ動かして重ねる動き補償の補間でつなぐ（シェーダーの `Pair`、`ObservationPlayback.cs` の `Model`）。風は観測のある所はAMV、ない所は典型的な大気循環（貿易風・偏西風・極東風、東西成分のみ）。毎時必ず実観測に戻るので雲の配置は観測から離れない。間の動きは推定で観測ではないとページに常に明記し、「実観測だけ」に切り替えられる。一時停止はその場で止まる。効果は控えめで、同じ瞬間での模型ON/OFFの画素差は地球部分の1.6〜2.3%（1時間で約1°、観測画像の1〜2画素、主に雲の縁）。風（`dist/data/amv.json`）は雲の日の中央 2026-09-18 12:00 UTC に更新（3,180点）。SSECはAMVも1時間ごとに出しているので、毎時の風を使うのが次の改善候補。
このPC（SHINYLABRY0）からはSSECに到達でき、Unityのビルドも回せる。エージェントのクラウドのコンテナからはどちらもできない。
Unity版は観測を独自取得せず、`dist/weather/` と `dist/data/` の同じファイルを読む。SHA-256マニフェストを唯一の正とし、両版が同じ観測を表示する状態を保つ。

## 科学的な限界
白い層は未校正の赤外線輝度閾値0.38–0.82による簡易合成。冷たい地表を雲として含み、暖かい低層雲を見落とす。未来館と同じカラー合成を再現したものではない。地表参考画像はNASA Blue Marbleの雲のない地表で、雪氷は固定。球面に見える雲はすべて観測由来。観測範囲外や欠測を晴天と断定しない。

## 最初に行う作業
1. READMEと本書を読み、現在の表示を起動する。
2. 既存の3テストを実行し、Android幅で地球・操作・時刻の表示と再生を確認する。
3. ユーザーの次の希望を確認する。改善候補は低層雲や冷たい地表の誤判定を減らす合成と、観測間の滑らかな遷移。補間を導入するときは観測そのものと区別する。
4. 単なるテクスチャ平行移動や生成した雲を実観測として見せない。出典とロゴを維持する。

## 検証済みと未検証
`node tests/weather.test.cjs`（9件）、`node tests/weather-playback.test.cjs`（15件）、`node tests/cloud-model.test.cjs`（9件）、`node tests/cloud-simulation.test.cjs`（10件）、`node tests/observation-fade.test.cjs`（8件）、`node tests/fetch-observations.test.cjs`（9件・API模擬サーバー）はこの環境で成功。同梱3,333ベクトルすべてが3時間後まで有限であることも確認済み。
Windows上のChrome（`--headless=new` + SwiftShader）で実描画を確認：配信版の合成表示・13時刻の再生、白黒観測モード、立体の模型モード（3,333地点）、および単体HTMLのfile://単体起動。地球・雲模型のGLSLは実ブラウザでコンパイル・リンク成功。
2026-09-17、Linuxコンテナの同梱Chromium（SwiftShader）とAndroid幅412×915のタッチ操作エミュレーションでも再確認：地球描画、13時刻が一巡してループ、一時停止で時刻が止まること、白黒観測トグル、可視光への切替（追加取得は失敗し、設計どおり表示中の観測を保持）、立体の模型（3,333地点の移流）、昼夜モード。約56fps。
Android実機でのUI QA、実機のタッチ操作、実ネットワークでの「最新を取得」は未検証。エミュレーションのタッチは実機の代わりにならない。
解決済：立体の模型の「↺ 戻す」。実装を読み実機で確認したところ、`elapsed` は正しく0になっていた。再生中は次のフレームから計算が進むため、毎秒5〜10分の速さでは目で追う前に数分に戻って見えていた。「戻す」は計算開始位置で停止するようにし（`dist/cloud-simulation.js`）、`tests/cloud-simulation.test.cjs` 10件で固定した。

2026-09-17、溶け込みを実ブラウザで確認：進捗0.4の瞬間の画面は前の観測とも次の観測とも異なり（画素差7.8%と8.6%、両端同士は9.7%）、溶け込みが実際に描画されている。トグルOFFで進捗は1に固定。

出典・第三者データは `THIRD_PARTY_NOTICES.md` を参照。
