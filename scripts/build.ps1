param(
	[switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$zoteroCompatibility = $manifest.applications.zotero
foreach ($requiredField in @("id", "update_url", "strict_max_version")) {
	if ([string]::IsNullOrWhiteSpace($zoteroCompatibility.$requiredField)) {
		throw "manifest.json requires applications.zotero.$requiredField for Zotero 9"
	}
}
$version = $manifest.version
$distDirectory = Join-Path $projectRoot "dist"
$zipPath = Join-Path $distDirectory "zotero-split-screen-$version.zip"
$xpiPath = Join-Path $distDirectory "zotero-split-screen-$version.xpi"

$relativeFiles = @(
	"manifest.json",
	"bootstrap.js",
	"split-screen.js",
	"workspace.css",
	"icon.svg"
)
$sourceFiles = $relativeFiles | ForEach-Object { Join-Path $projectRoot $_ }

foreach ($sourceFile in $sourceFiles) {
	if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
		throw "Missing plugin file: $sourceFile"
	}
}

if (-not $SkipChecks) {
	$node = Get-Command node -ErrorAction SilentlyContinue
	if ($node) {
		& $node.Source --check (Join-Path $projectRoot "bootstrap.js")
		if ($LASTEXITCODE -ne 0) { throw "bootstrap.js syntax check failed" }
		& $node.Source --check (Join-Path $projectRoot "split-screen.js")
		if ($LASTEXITCODE -ne 0) { throw "split-screen.js syntax check failed" }
		& $node.Source (Join-Path $projectRoot "tests\core.test.js")
		if ($LASTEXITCODE -ne 0) { throw "core tests failed" }
	}
}

if (-not (Test-Path -LiteralPath $distDirectory -PathType Container)) {
	New-Item -ItemType Directory -Path $distDirectory | Out-Null
}

# Each removal targets one explicit archive path; no recursive or wildcard deletion is used.
if (Test-Path -LiteralPath $zipPath) {
	Remove-Item -LiteralPath $zipPath
}
if (Test-Path -LiteralPath $xpiPath) {
	Remove-Item -LiteralPath $xpiPath
}

Compress-Archive -LiteralPath $sourceFiles -DestinationPath $zipPath -CompressionLevel Optimal
Move-Item -LiteralPath $zipPath -Destination $xpiPath

Write-Host "Built $xpiPath"
