FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:22-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install
RUN useradd -m -u 9999 pluginrunner
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist/ ./dist/
RUN mkdir -p /plugins && mkdir -p /tmp/plugins
EXPOSE 3003
CMD ["node", "dist/index.js"]
