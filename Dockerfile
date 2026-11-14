# syntax=docker/dockerfile:1
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base

FROM base AS dependencies
WORKDIR /app
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS downloader
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && case "$(dpkg --print-architecture)" in \
      amd64) asset=yt-dlp_linux; checksum=767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795 ;; \
      arm64) asset=yt-dlp_linux_aarch64; checksum=e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483 ;; \
      *) echo 'Supported image architectures: amd64, arm64.' >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/$asset" -o /yt-dlp \
    && echo "$checksum  /yt-dlp" | sha256sum -c - \
    && chmod 755 /yt-dlp

FROM base AS runtime
ARG APP_UID=1000
ARG APP_GID=1000
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 ca-certificates=20250419~deb12u2 \
    && rm -rf /var/lib/apt/lists/* \
    && test "$APP_UID" -gt 0 && test "$APP_GID" -gt 0 \
    && groupmod -g "$APP_GID" node \
    && usermod -u "$APP_UID" -g "$APP_GID" node \
    && mkdir -p /downloads /state \
    && chown "$APP_UID:$APP_GID" /downloads /state /home/node
ENV NODE_ENV=production DOWNLOAD_DIR=/downloads STATE_DIR=/state
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=downloader /yt-dlp /usr/local/bin/yt-dlp
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/videodl-entrypoint
RUN chmod 755 /usr/local/bin/videodl-entrypoint
USER node
ENTRYPOINT ["videodl-entrypoint"]
CMD ["node", "src/index.ts"]
