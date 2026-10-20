FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:26-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client curl build-essential python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.14
# The standalone Python from python-build-standalone has OpenSSL compiled to look for
# CA certs at /etc/ssl/cert.pem, which doesn't exist on Debian. Symlink to the actual bundle.
RUN ln -sf /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem
# Plugin directories are owned by per-plugin system users, but git commands run as root.
RUN git config --global --add safe.directory '*'
RUN chmod 700 /root
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist/ ./dist/
RUN mkdir -p /plugins
EXPOSE 3003
CMD ["node", "dist/index.js"]
