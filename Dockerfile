FROM node:24-slim

WORKDIR /app

# Install openssl for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

RUN npm run build

# Fail the build if the Prisma query engine for this platform is missing (linux-arm64-openssl on arm64),
# so an image that cannot start is never published.
RUN set -e; \
    case "$(uname -m)" in \
      aarch64) engine=linux-arm64-openssl-3.0.x ;; \
      x86_64) engine=debian-openssl-3.0.x ;; \
      *) echo "unsupported architecture $(uname -m)"; exit 1 ;; \
    esac; \
    ls node_modules/.prisma/client/ | grep -q "libquery_engine-${engine}.so.node" \
      || { echo "Prisma query engine ${engine} is missing"; ls node_modules/.prisma/client/; exit 1; }

COPY scripts ./scripts/
COPY src ./src/
COPY keys ./keys/

# Local builds without a private key generate a throwaway pair. Release images are built with
# GENERATE_KEYS=0 so no private key is baked into a layer: the deployment mounts keys/ (or sets KEYS_DIR)
# with private.pem and public.pem, and the pilots' login key stays the same across releases.
ARG GENERATE_KEYS=1
RUN if [ "$GENERATE_KEYS" = "1" ] && [ ! -f keys/private.pem ]; then npm run keys:generate; fi

# Set after install/build so devDependencies (prisma CLI) are available above;
# keeps /auth/dev-login (development only) disabled at runtime.
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
