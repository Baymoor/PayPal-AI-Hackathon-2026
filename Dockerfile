# Outings — portable container image (web app; run the worker with `npm run worker`).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
# Node sizes its heap from the machine's RAM (about a quarter), which is too small for the
# TypeScript check on a 2 GB server. A higher ceiling lets the build use swap instead of crashing.
# Build stage only: the runtime image keeps Node's defaults.
ARG BUILD_NODE_HEAP_MB=1536
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=${BUILD_NODE_HEAP_MB}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app ./
EXPOSE 3000
# Apply migrations, then serve. `exec` hands PID 1 to npm so `docker stop` (SIGTERM) reaches Next.js
# and in-flight requests can finish. Use the same image with CMD ["npm","run","worker"] for the worker.
CMD ["sh", "-c", "npm run db:migrate && exec npm start"]
