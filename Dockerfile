FROM node:20-slim

# Install Chromium (lighter than google-chrome-stable)
RUN apt-get update \
    && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 dumb-init \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (need devDeps like vite for build)
RUN npm install

# Copy source code
COPY . .

# Build Frontend (needs vite from devDeps)
RUN npm run build

# Remove dev dependencies to save space
RUN npm prune --omit=dev 2>/dev/null || true

# Expose port
EXPOSE 4000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start command
CMD ["node", "server/index.cjs"]
