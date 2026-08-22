#!/usr/bin/env bash
set -euo pipefail

# spanical installer
# Usage: curl -fsSL https://raw.githubusercontent.com/bhagyamudgal/spanical/main/install.sh | bash

REPO="bhagyamudgal/spanical"
INSTALL_DIR="${SPANICAL_INSTALL_DIR:-${HOME}/.local/bin}"
BINARY_NAME="spanical"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info() { echo -e "  $1" >&2; }
success() { echo -e "${GREEN}$1${NC}" >&2; }
error() { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

main() {
    echo ""
    echo -e "${BOLD}Installing spanical...${NC}"
    echo ""

    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"

    case "$ARCH" in
        x86_64|amd64) ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            error "Unsupported architecture: $ARCH (supported: x64, arm64)"
            ;;
    esac

    case "$OS" in
        darwin|linux) ;;
        *)
            error "Unsupported OS: $OS (supported: darwin, linux)"
            ;;
    esac

    ASSET_NAME="spanical-${OS}-${ARCH}"

    # sha256sum ships with coreutils on Linux; macOS only has shasum.
    if command -v sha256sum >/dev/null 2>&1; then
        SHA_TOOL="sha256sum"
    elif command -v shasum >/dev/null 2>&1; then
        SHA_TOOL="shasum -a 256"
    else
        error "Neither sha256sum nor shasum found; cannot verify the download."
    fi

    BASE_URL="https://github.com/${REPO}/releases/latest/download"

    mkdir -p "$INSTALL_DIR"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    info "Downloading ${DIM}${ASSET_NAME}${NC} from ${DIM}github.com/${REPO}${NC}..."
    curl -fsSL "${BASE_URL}/${ASSET_NAME}" -o "${TMP_DIR}/${BINARY_NAME}" \
        || error "Download failed. Check that a release exists at https://github.com/${REPO}/releases"

    info "Downloading SHA256SUMS..."
    curl -fsSL "${BASE_URL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS" \
        || error "Checksum list download failed."

    EXPECTED="$(grep " ${ASSET_NAME}\$" "${TMP_DIR}/SHA256SUMS" | awk '{print $1}')"
    [ -n "$EXPECTED" ] || error "SHA256SUMS has no entry for ${ASSET_NAME}. Refusing to install unverified."

    ACTUAL="$(${SHA_TOOL} "${TMP_DIR}/${BINARY_NAME}" | awk '{print $1}')"
    if [ "$ACTUAL" != "$EXPECTED" ]; then
        error "Checksum mismatch for ${ASSET_NAME}: expected ${EXPECTED}, got ${ACTUAL}. The download was not installed."
    fi
    success "Checksum verified."

    INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"
    mv "${TMP_DIR}/${BINARY_NAME}" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"

    echo ""
    success "Installed ${INSTALL_PATH}"

    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        echo ""
        info "${YELLOW}Warning:${NC} ${INSTALL_DIR} is not in your PATH."
        info "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
        echo ""
        info "${DIM}export PATH=\"\${HOME}/.local/bin:\${PATH}\"${NC}"
        echo ""
    fi

    VERSION="$("$INSTALL_PATH" --version 2>/dev/null | tail -1)"
    echo ""
    success "${BOLD}Done!${NC} ${VERSION:-spanical} — run ${BOLD}spanical --help${NC} to get started."
    echo ""
}

main
