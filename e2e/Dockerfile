FROM videodl-bot:ci
USER root
COPY e2e/yt-dlp /usr/local/bin/yt-dlp
COPY e2e/telegram.mjs /app/e2e/telegram.mjs
RUN chmod 755 /usr/local/bin/yt-dlp
USER node
