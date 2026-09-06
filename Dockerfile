FROM node:24-slim

WORKDIR /app

# Install openssl for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

RUN npm run build

COPY scripts ./scripts/
COPY src ./src/

RUN npm run keys:generate

EXPOSE 3000

CMD ["npm", "start"]
