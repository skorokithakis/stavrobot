FROM debian:bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV PYTHONUNBUFFERED=1
RUN uv python install

RUN useradd -m -u 9999 coder

USER coder
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/coder/.local/bin:${PATH}"

USER root
COPY entrypoint.sh server.py system-prompt.txt PLUGIN.md /app/
RUN chmod +x /app/entrypoint.sh

EXPOSE 3002
ENTRYPOINT ["/app/entrypoint.sh"]
