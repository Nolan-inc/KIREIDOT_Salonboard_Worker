# syntax=docker/dockerfile:1
#
# SalonBoard 同期 Worker (worker.ts) — ECS Fargate 用イメージ
#
# 重要: ベースイメージのタグと docker/package.json の playwright バージョンは
# 厳密一致させること。乖離すると playwright npm がイメージ同梱のブラウザ
# リビジョンを見つけられず起動に失敗する。
# (CI の "verify playwright version match" ステップで機械チェックしている)
ARG PLAYWRIGHT_VERSION=1.59.1

# ---- build: worker.ts を単一 ESM バンドルに (tsx をランタイムに持ち込まない) ----
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY worker.ts salonboard-selectors.ts salonboard-rescan.ts canary.ts ./
RUN npm install --no-save --no-audit --no-fund esbuild@0.25.5 \
 && npx esbuild worker.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:playwright \
      --outfile=dist/worker.mjs \
 && npx esbuild canary.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:playwright \
      --outfile=dist/canary.mjs

# ---- runtime ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG APP_VERSION=0.0.0-docker
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    HOME=/home/pwuser
WORKDIR /app

# playwright の npm パッケージのみインストール (バージョンは docker/package.json で固定)
COPY docker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && chown -R pwuser:pwuser /app /home/pwuser

COPY --from=build /build/dist/worker.mjs /build/dist/canary.mjs ./
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

# 非 root 実行 (--no-sandbox を避けられる)。storageState / debug capture は
# ~/.kireidot 配下 (タスクローカル。Phase 1 で S3 永続化に置換予定)
USER pwuser

# entrypoint が exec node するため PID 1 = node。ECS / Spot 中断の SIGTERM を
# worker.ts の既存ハンドラが直接受け、実行中ジョブを drain してから終了する
ENTRYPOINT ["/entrypoint.sh"]
