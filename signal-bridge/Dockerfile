FROM debian:bookworm-slim

# Install dependencies for downloading signal-cli and running Python.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    qrencode && \
    pip3 install --break-system-packages mistune && \
    rm -rf /var/lib/apt/lists/*

# Download and install signal-cli native build.
ARG SIGNAL_CLI_VERSION=0.14.1
RUN curl -L "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" -o /tmp/signal-cli.tar.gz && \
    tar -xzf /tmp/signal-cli.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/signal-cli && \
    rm /tmp/signal-cli.tar.gz

# Copy the bridge script and supporting modules.
COPY . /app/
RUN chmod +x /app/bridge.py
RUN chmod 700 /root

WORKDIR /app

ENTRYPOINT ["python3", "/app/bridge.py"]
