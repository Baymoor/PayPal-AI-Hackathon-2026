# Outings — portable container image (web app; run the worker with `npm run worker`).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
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
