FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV PYTHONUNBUFFERED=1

RUN uv python install

RUN useradd --system --no-create-home pythonrunner

COPY server.py /app/server.py

EXPOSE 3003

CMD ["python", "/app/server.py"]
