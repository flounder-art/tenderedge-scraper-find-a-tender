cat > Dockerfile << 'EOF'
FROM node:20-slim

WORKDIR /app

# Install system deps that Playwright needs
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    libx11-6 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# Install Playwright with all system deps
RUN npx playwright install --with-deps chromium

CMD ["npm", "start"]
RUN npx playwright install chromium
RUN npx playwright install-deps chromium
EOF
