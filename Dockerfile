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
COPY keys ./keys/

RUN if [ ! -f keys/private.pem ]; then npm run keys:generate; fi

EXPOSE 3000

CMD ["npm", "start"]
