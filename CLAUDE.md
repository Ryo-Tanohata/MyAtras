# MyAtras — Claude Code 引き継ぎ

## 目的とユーザーの希望
日本科学未来館のジオ・コスモスのように、青い海と白い雲の地球をブラウザ（特にAndroid Chrome）で操作して、実際の雲の流れを見たい。静止画像を単に回す演出ではなく、SSECの異なる観測時刻を再生することが主目的。

GitHubへの公開コード登録はユーザーが了承済み。Webサイトの追加公開・デプロイは依頼されていないため実施しない。公式の未来館製品と表示しない。

## 起動
フレームワークやnpmインストールは不要。Python 3で `python -m http.server 8000 --directory dist` を実行し、ブラウザで http://localhost:8000 を開く。
単体HTMLは `python scripts/export-html.py` で生成。出力 `dist/geo-cosmos-clouds.html` はGit管理外。
`scripts/export-inline-earth.py` はChatGPT内表示専用で、Pillowと固定の `/workspace` 出力先を使用する。通常のブラウザ起動には不要。

## 実装済み
- 生のWebGLで地球、ドラッグ・ピンチ、回転、照明を描画。
- 2026-09-16 09:00–21:00 UTCの13枚の全球赤外線観測を順に再生。日時は日本時間で表示。データは保存時点の観測であり常時最新ではない。
- 地表参考画像に観測輝度から白い層を合成。地球回転は初期OFF。
- 最新取得、再生速度、時刻選択、キャッシュ、取得失敗時の保持。
- 別モード「立体の模型」はSSEC AMV風向・風速を使う簡易移流。雲の形や量は模型で、実際の雲分布・気象予報ではない。

## 主要ファイル
- `dist/app.js`: 地球シェーダー・入力・表示統合。
- `dist/weather.js`: 観測API、時刻、読み込み、エラー処理。
- `dist/weather-playback.js`: 時系列再生。
- `dist/weather/sequence/manifest.json`: 観測URL・時刻・SHA256。
- `dist/cloud-model.js`, `dist/cloud-simulation.js`: 数値風による模型。
- `dist/index.html`, `dist/style.css`: UI。

## 科学的な限界
白い層は未校正の赤外線輝度閾値0.38–0.82による簡易合成。冷たい地表を雲として含み、暖かい低層雲を見落とす。未来館と同じカラー合成を再現したものではない。地表参考画像に残る極域の雲・雪氷は固定。観測範囲外や欠測を晴天と断定しない。

## 最初に行う作業
1. READMEと本書を読み、現在の表示を起動する。
2. 既存の3テストを実行し、Android幅で地球・操作・時刻の表示と再生を確認する。
3. ユーザーの次の希望を確認する。改善候補は低層雲や冷たい地表の誤判定を減らす合成と、観測間の滑らかな遷移。補間を導入するときは観測そのものと区別する。
4. 単なるテクスチャ平行移動や生成した雲を実観測として見せない。出典とロゴを維持する。

## 検証済みと未検証
`node tests/weather.test.cjs`、`node tests/weather-playback.test.cjs`、`node tests/cloud-model.test.cjs` は元の環境で成功。地球と模型のGLSLはオフスクリーンGLESでコンパイル・リンク成功し、カラー地球の描画を確認。実ブラウザ・Android実機のUI QAは未完了。

出典・第三者ライセンスは `THIRD_PARTY_NOTICES.md` と `THREE-LICENSE.txt` を参照。
