FROM node:20-slim

# Install simple dependencies only (no Chromium needed for Baileys)
RUN apt-get update \
    && apt-get install -y dumb-init \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies
RUN npm install

# Copy source code
COPY . .

# Build Frontend (needs vite from devDeps)
RUN npm run build

# Expose port (Render sets PORT env var, default 10000)
EXPOSE ${PORT:-10000}

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start command
CMD ["node", "server/index.cjs"]
