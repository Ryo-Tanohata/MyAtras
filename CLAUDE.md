# MyAtras — Claude Code 引き継ぎ

## 目的とユーザーの希望
日本科学未来館のジオ・コスモスのように、青い海と白い雲の地球をブラウザ（特にAndroid Chrome）で操作して、実際の雲の流れを見たい。静止画像を単に回す演出ではなく、SSECの異なる観測時刻を再生することが主目的。

GitHubへの公開コード登録はユーザーが了承済み。Webサイトの追加公開・デプロイは依頼されていないため実施しない。公式の未来館製品と表示しない。展示名「ジオ・コスモス」をサイト名や見出しに使わず、着想元として本文で触れるだけにする（画面上の名称は MYATRAS）。

## 起動
フレームワークやnpmインストールは不要。Python 3で `python -m http.server 8000 --directory dist` を実行し、ブラウザで http://localhost:8000 を開く。
単体HTMLは `python scripts/export-html.py` で生成。出力 `dist/myatras-clouds.html` はGit管理外。
`scripts/export-inline-earth.py` はChatGPT内表示専用で、Pillowと固定の `/workspace` 出力先を使用する。通常のブラウザ起動には不要。

## 実装済み
- 生のWebGLで地球、ドラッグ・ピンチ、回転、照明を描画。
- 2026-09-16 09:00–21:00 UTCの13枚の全球赤外線観測を順に再生。日時は日本時間で表示。データは保存時点の観測であり常時最新ではない。
- 地表参考画像に観測輝度から白い層を合成。チェックボックス「元の白黒観測を表示」で元の観測に戻せる。地球回転は初期OFF。
- 最新取得、再生速度、時刻選択、キャッシュ、取得失敗時の保持。
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
- `tests/harness.cjs`: テスト用の最小DOMと通信スタブ。観測の中身は偽装しない。

## 科学的な限界
白い層は未校正の赤外線輝度閾値0.38–0.82による簡易合成。冷たい地表を雲として含み、暖かい低層雲を見落とす。未来館と同じカラー合成を再現したものではない。地表参考画像はNASA Blue Marbleの雲のない地表で、雪氷は固定。球面に見える雲はすべて観測由来。観測範囲外や欠測を晴天と断定しない。

## 最初に行う作業
1. READMEと本書を読み、現在の表示を起動する。
2. 既存の3テストを実行し、Android幅で地球・操作・時刻の表示と再生を確認する。
3. ユーザーの次の希望を確認する。改善候補は低層雲や冷たい地表の誤判定を減らす合成と、観測間の滑らかな遷移。補間を導入するときは観測そのものと区別する。
4. 単なるテクスチャ平行移動や生成した雲を実観測として見せない。出典とロゴを維持する。

## 検証済みと未検証
`node tests/weather.test.cjs`（9件）、`node tests/weather-playback.test.cjs`（10件）、`node tests/cloud-model.test.cjs`（9件）はこの環境で成功。同梱3,333ベクトルすべてが3時間後まで有限であることも確認済み。
Windows上のChrome（`--headless=new` + SwiftShader）で実描画を確認：配信版の合成表示・13時刻の再生、白黒観測モード、立体の模型モード（3,333地点）、および単体HTMLのfile://単体起動。地球・雲模型のGLSLは実ブラウザでコンパイル・リンク成功。
Android実機でのUI QA、タッチ操作（ドラッグ・ピンチ）、実ネットワークでの「最新を取得」は未検証。

出典・第三者データは `THIRD_PARTY_NOTICES.md` を参照。
