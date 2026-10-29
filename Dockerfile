# POST_FG backend image: the compiled Node app plus Python for the OCR (ocr-service/), which
# the app runs as a child process (src/modules/ocr/ocr-runner.ts), and Chromium for the
# Flipkart Seller Hub and Myntra Partner Portal robots. Built and pushed to ECR by
# .github/workflows/deploy.yml; run on the instance by deploy/deploy.sh, which mounts the
# .env (read by dotenv from /app/.env) and the storage folder (/app/storage).

# ---- build: TypeScript -> dist/ ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHON_BIN=/opt/venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Python venv with the OCR's packages, pinned in requirements-ocr.txt.
COPY requirements-ocr.txt /tmp/requirements-ocr.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-ocr.txt \
 && rm /tmp/requirements-ocr.txt

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Chromium + its system libraries for the portal robots (src/modules/intransit/sources/): the headless shell for the
# Flipkart Seller Hub robot, the full browser + Xvfb (a screen of its own) for the Myntra Partner Portal robot, whose
# login refuses headless browsers. The version installed is the one package-lock pins.
RUN npx playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright

COPY --from=build /app/dist ./dist

# The OCR scripts (ocr-service/dev/scripts, part of this repository).
COPY ocr-service ./ocr-service

RUN mkdir -p storage && chown node:node storage
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + (process.env.API_PREFIX || '/api/v1') + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/server.js"]
