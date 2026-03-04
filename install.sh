#!/bin/sh
set -e

REPO="hn12404988/claude-tenet"
INSTALL_DIR="${TENET_INSTALL_DIR:-$HOME/.local/bin}"
BINARY="tenet"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS_TAG="darwin" ;;
  linux)  OS_TAG="linux" ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_TAG="x64" ;;
  arm64|aarch64) ARCH_TAG="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="tenet-${OS_TAG}-${ARCH_TAG}"

echo "Fetching latest release from ${REPO}..."
DOWNLOAD_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep "browser_download_url.*${ASSET}" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: no binary found for ${ASSET}" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# Remove existing binary if present
rm -f "${INSTALL_DIR}/${BINARY}"

echo "Downloading ${ASSET}..."
curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY}"
chmod +x "${INSTALL_DIR}/${BINARY}"

echo "Installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"

# Check PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Warning: ${INSTALL_DIR} is not in your PATH. Add it with:"
     echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
