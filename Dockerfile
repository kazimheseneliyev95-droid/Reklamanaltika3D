FROM node:20-slim

# Install system dependencies that Chromium needs (but NOT chromium itself)
# Puppeteer will download its own compatible Chromium
RUN apt-get update \
    && apt-get install -y \
      wget \
      ca-certificates \
      fonts-ipafont-gothic \
      fonts-wqy-zenhei \
      fonts-thai-tlwg \
      fonts-kacst \
      fonts-freefont-ttf \
      libxss1 \
      libx11-xcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxi6 \
      libxtst6 \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libxrandr2 \
      dumb-init \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Do NOT skip Chromium download — let Puppeteer use its own bundled version
# This ensures version compatibility between Puppeteer and Chromium
# ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true   ← REMOVED
# ENV PUPPETEER_EXECUTABLE_PATH=...           ← REMOVED

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (Puppeteer will download Chromium here)
RUN npm install

# Copy source code
COPY . .

# Build Frontend (needs vite from devDeps)
RUN npm run build

# Expose port
EXPOSE 4000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start command
CMD ["node", "server/index.cjs"]
