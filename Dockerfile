FROM node:22-slim

RUN apt-get update && apt-get install -y \
  chromium-browser \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright browsers
RUN npx playwright install

COPY src ./src
COPY tsconfig.json ./

CMD ["npm", "start"]
