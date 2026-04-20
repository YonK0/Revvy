# build.ps1 - Build and package the Revvy VS Code extension
# Usage: .\build.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Log  { param($msg) Write-Host "[build] $msg" -ForegroundColor Green }
function Warn { param($msg) Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Fail { param($msg) Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

# -- Checks -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node is not installed" }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Fail "npm is not installed" }
if (-not (Test-Path "package.json")) { Fail "Run this script from the extension root directory" }

if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
    Warn "vsce not found globally - installing..."
    npm install -g @vscode/vsce
}

# -- Bump patch version in package.json --------------------------------------
Log "Bumping patch version..."
npm version patch --no-git-tag-version | Out-Null

# -- Read new version from package.json ---------------------------------------
$version = node -p "require('./package.json').version"
$name    = node -p "require('./package.json').name"
$vsix    = "$name-$version.vsix"

Log "Building $name v$version"

# -- Clean previous output ----------------------------------------------------
Log "Cleaning out/"
if (Test-Path "out") { Remove-Item -Recurse -Force "out" }

# -- Install extension dependencies -------------------------------------------
Log "Installing extension dependencies..."
npm install

# -- Bundle extension ---------------------------------------------------------
Log "Bundling extension with esbuild..."
#npm run bundle

# -- Package VSIX -------------------------------------------------------------
Log "Packaging VSIX..."
vsce package --no-git-tag-version --out $vsix

# -- Done ---------------------------------------------------------------------
Write-Host ""
Log "Done! Output: $vsix"
Write-Host ""
Write-Host "  Install locally:"
Write-Host "    code --install-extension $vsix"
Write-Host ""
