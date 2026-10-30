# --- build the TypeScript ---
FROM node:22-slim AS build
WORKDIR /app
# Only package.json is copied, on purpose: a package-lock.json created on another OS (Windows/macOS)
# can be missing the Linux build of TypeScript, and the build then fails.
# The versions in package.json are exact, so builds still come out the same.
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- small runtime image ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Music: yt-dlp fetches the audio, ffmpeg turns it into Opus for Discord.
# The bot also updates yt-dlp by itself every 12 hours, because YouTube keeps changing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in arm64) f=yt-dlp_linux_aarch64 ;; *) f=yt-dlp_linux ;; esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$f" \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && yt-dlp --version

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public ./public
# messages, alert settings, log settings, uploaded images (and a cookies.txt if you need one) live here
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
