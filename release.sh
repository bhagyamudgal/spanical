#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# The CLI package carries the version, not the monorepo root.
PACKAGE_VERSION=$(grep '"version"' packages/cli/package.json | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
TAG="v${PACKAGE_VERSION}"

if [[ -z "$PACKAGE_VERSION" ]]; then
    echo -e "${RED}Could not read version from packages/cli/package.json${NC}"
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo -e "${RED}Working directory is not clean. Commit or stash changes first.${NC}"
    exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo -e "${RED}Tag ${BOLD}${TAG}${NC}${RED} already exists.${NC}"
    echo -e "  Update the version in ${DIM}packages/cli/package.json${NC} first."
    exit 1
fi

REMOTE_URL=$(git remote get-url origin)
REPO_SLUG=$(printf '%s' "$REMOTE_URL" | sed -E 's#.*github\.com[:/]##; s#\.git$##')

echo ""
echo -e "${BOLD}Releasing ${TAG}${NC}"
echo -e "  ${DIM}Version from packages/cli/package.json: ${PACKAGE_VERSION}${NC}"
echo ""

echo -e "${YELLOW}This will:${NC}"
echo "  1. Create git tag ${TAG} on the current commit"
echo "  2. Push tag to origin"
echo "  3. Trigger GitHub Actions to build + release"
echo ""

read -rp "Continue? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo -e "${DIM}Cancelled.${NC}"
    exit 0
fi

echo ""
echo -e "  Creating tag ${BOLD}${TAG}${NC}..."
git tag "$TAG" -m "$TAG"

echo -e "  Pushing tag to origin..."
git push origin "$TAG"

echo ""
echo -e "${GREEN}${BOLD}Done!${NC} Release ${TAG} is being built."
echo -e "  ${DIM}Watch progress: https://github.com/${REPO_SLUG}/actions${NC}"
echo ""
