
set -e

# ── Config ────────────────────────────────────────────────────────────────────
PACKAGE_JSON="package.json"
OUT_DIR="out"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[build]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail() { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ── Checks ────────────────────────────────────────────────────────────────────
command -v node  >/dev/null 2>&1 || fail "node is not installed"
command -v npm   >/dev/null 2>&1 || fail "npm is not installed"
command -v vsce  >/dev/null 2>&1 || {
  warn "vsce not found globally — installing..."
  npm install -g @vscode/vsce
}

[ -f "$PACKAGE_JSON" ] || fail "Run this script from the extension root directory"

# ── Bump patch version in package.json ───────────────────────────────────────
log "Bumping patch version..."
npm version patch --no-git-tag-version > /dev/null

# ── Read new version ──────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
VSIX_FILE="${NAME}-${VERSION}.vsix"

log "Building ${NAME} v${VERSION}"

# ── Clean previous output ─────────────────────────────────────────────────────
log "Cleaning ${OUT_DIR}/"
rm -rf "$OUT_DIR"

# ── Install dependencies ──────────────────────────────────────────────────────
log "Installing dependencies..."
npm install

# ── TypeScript compile ────────────────────────────────────────────────────────
log "Compiling TypeScript..."
npm run compile

# ── Package VSIX ─────────────────────────────────────────────────────────────
log "Packaging VSIX..."
vsce package --no-git-tag-version --out "$VSIX_FILE"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
log "Done! Output: ${VSIX_FILE}"
echo ""
echo "  Install locally:"
echo "    code --install-extension ${VSIX_FILE}"
echo ""
