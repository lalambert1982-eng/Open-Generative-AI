FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
COPY packages/studio/package*.json ./packages/studio/
RUN npm ci --ignore-scripts --no-audit --no-fund

# Build the application directly from workspace source
FROM deps AS builder
COPY . .
RUN npm run build

# Production runner
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/studio ./packages/studio

EXPOSE 3000
CMD ["npm", "start"]
