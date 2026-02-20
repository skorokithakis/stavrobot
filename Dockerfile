FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist/ ./dist/
COPY system-prompt.txt ./
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install
RUN useradd --system --no-create-home pythonrunner
COPY entrypoint.sh ./
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/index.js"]
