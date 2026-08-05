$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $repoRoot

try {
  $env:UNIGIT_REQUIRE_SIGNING = "1"

  if (-not $env:UNIGIT_SIGN_SUBJECT) {
    $env:UNIGIT_SIGN_SUBJECT = "CN=UniGit Self Signed"
  }

  npm run tauri:build:nsis

  if ($LASTEXITCODE -ne 0) {
    throw "Windows release build failed with exit code $LASTEXITCODE."
  }

  # Resolve the actual cargo target directory (honors src-tauri/.cargo/config.toml
  # and CARGO_TARGET_DIR) instead of assuming src-tauri/target.
  $cargoMeta = cargo metadata --no-deps --format-version 1 --manifest-path (Join-Path $repoRoot "src-tauri\Cargo.toml") 2>$null | ConvertFrom-Json
  $targetDir = $cargoMeta.target_directory
  if (-not $targetDir) {
    $targetDir = Join-Path $repoRoot "src-tauri\target"
  }

  $bundleDirectory = Join-Path $targetDir "release\bundle\nsis"
  $bundles = Get-ChildItem $bundleDirectory -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending

  if ($bundles) {
    Write-Host "Built installer artifacts:"
    $bundles | ForEach-Object { Write-Host "  $($_.FullName)" }
  } else {
    Write-Host "Build completed, but no NSIS bundle files were found under $bundleDirectory"
  }
}
finally {
  Pop-Location
}