# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base

FROM base AS dependencies
WORKDIR /app
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.21.0
RUN npm install --global pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS downloader
# renovate: datasource=repology depName=debian_12/ca-certificates versioning=deb
ARG CA_CERTIFICATES_VERSION=20250419~deb12u2
# renovate: datasource=repology depName=debian_12/curl versioning=deb
ARG CURL_VERSION=7.88.1-10+deb12u15
# Each release asset keeps its own digest so Renovate updates both architectures.
ARG YT_DLP_AMD64=2026.11.23@249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d
ARG YT_DLP_ARM64=2026.11.23@fb847a2e4a9ddc8cf5fcfb4bb7f42ba8969ecf72068def0278074f9d300bd13c
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=${CA_CERTIFICATES_VERSION} curl=${CURL_VERSION} \
    && case "$(dpkg --print-architecture)" in \
      amd64) asset=yt-dlp_linux; release="$YT_DLP_AMD64" ;; \
      arm64) asset=yt-dlp_linux_aarch64; release="$YT_DLP_ARM64" ;; \
      *) echo 'Supported image architectures: amd64, arm64.' >&2; exit 1 ;; \
    esac \
    && version="${release%@*}" && checksum="${release#*@}" \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/$version/$asset" -o /yt-dlp \
    && echo "$checksum  /yt-dlp" | sha256sum -c - \
    && chmod 755 /yt-dlp

FROM base AS runtime
# renovate: datasource=repology depName=debian_12/ffmpeg versioning=deb
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
# renovate: datasource=repology depName=debian_12/ca-certificates versioning=deb
ARG CA_CERTIFICATES_VERSION=20250419~deb12u2
ARG APP_UID=1000
ARG APP_GID=1000
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg=${FFMPEG_VERSION} ca-certificates=${CA_CERTIFICATES_VERSION} \
    && rm -rf /var/lib/apt/lists/* \
    && test "$APP_UID" -gt 0 && test "$APP_GID" -gt 0 \
    && groupmod -g "$APP_GID" node \
    && usermod -u "$APP_UID" -g "$APP_GID" node \
    && mkdir -p /downloads /state \
    && chown "$APP_UID:$APP_GID" /downloads /state /home/node
LABEL org.opencontainers.image.source="https://github.com/edge33/videodl-bot" \
      org.opencontainers.image.description="Private Telegram bot for persistent YouTube downloads"
ENV NODE_ENV=production DOWNLOAD_DIR=/downloads STATE_DIR=/state XDG_CACHE_HOME=/tmp/videodl-cache
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
