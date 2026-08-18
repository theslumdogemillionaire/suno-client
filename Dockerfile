FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc -p tsconfig.build.json

# Default target: everything needed to run the unit suite, the canary and the
# CLI. The image stays dev-capable on purpose - the canary is an operational
# tool, not a build artifact, and it needs tsx.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# All four tsconfigs: the dual ESM+CJS build reads tsconfig.esm.json and
# tsconfig.cjs.json, and without them `npm run build` fails inside the image
# with "The specified path does not exist" while working fine on the host.
COPY package.json tsconfig.json tsconfig.build.json tsconfig.esm.json tsconfig.cjs.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

CMD ["node", "dist/cli.js", "--help"]
