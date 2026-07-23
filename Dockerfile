# Secrets (JWT_ACCESS_SECRET, DATABASE_URL, DATABASE_SSL_CA_PATH) are never
# declared here as ARG/ENV — Railway injects them straight into the running
# container's process env at deploy time. Nothing here needs them; `nest
# build` is a pure TypeScript compile, no runtime config involved.

# ---- deps: full install (incl. dev — needed to run `nest build`) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript to dist/ ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod-deps: production-only install, no dev tooling in the final image ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: the image that actually ships ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY certs ./certs

RUN addgroup -S nodejs && adduser -S nestjs -G nodejs
USER nestjs

EXPOSE 3000
CMD ["node", "dist/main"]
