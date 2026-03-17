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

  $bundleDirectory = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
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