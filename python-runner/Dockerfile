FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV PYTHONUNBUFFERED=1

RUN uv python install 3.14
# The standalone Python from python-build-standalone has OpenSSL compiled to look for
# CA certs at /etc/ssl/cert.pem, which doesn't exist on Debian. Symlink to the actual bundle.
RUN ln -sf /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem

RUN useradd --system --no-create-home pythonrunner
RUN chmod 700 /root

COPY server.py /app/server.py

EXPOSE 3003

CMD ["python", "/app/server.py"]
