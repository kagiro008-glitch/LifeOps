$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$runtimeRoot = Join-Path $env:LOCALAPPDATA "LifeOps\node"
$currentPathFile = Join-Path $runtimeRoot "current-node-path.txt"
if (Test-Path $currentPathFile) {
  $cachedNode = [IO.File]::ReadAllText($currentPathFile).Trim()
  if (Test-Path $cachedNode) {
    $cachedVersion = & $cachedNode --version
    if ($cachedVersion -match "^v(\d+)\." -and [int]$Matches[1] -ge 18) {
      Write-Output $cachedNode
      exit 0
    }
  }
}

$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$archiveArchitecture = switch ($architecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { throw "Automatic Node.js setup does not support Windows architecture '$architecture'." }
}

$distributionUrl = "https://nodejs.org/dist"
$releases = Invoke-RestMethod -Uri "$distributionUrl/index.json"
$archiveSuffix = "win-$archiveArchitecture-zip"
$release = $releases | Where-Object { $_.lts -and $_.files -contains $archiveSuffix } | Select-Object -First 1
if (-not $release -or $release.version -notmatch "^v\d+\.\d+\.\d+$") {
  throw "Could not find a supported Node.js LTS release for Windows $archiveArchitecture."
}

$archiveName = "node-$($release.version)-win-$archiveArchitecture.zip"
$releaseUrl = "$distributionUrl/$($release.version)"
$staging = Join-Path ([IO.Path]::GetTempPath()) ("lifeops-node-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $staging $archiveName
$expandedPath = Join-Path $staging "expanded"
$installPath = Join-Path $runtimeRoot $release.version
$nodePath = Join-Path $installPath "node.exe"

try {
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  New-Item -ItemType Directory -Path $expandedPath -Force | Out-Null

  Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archiveName" -OutFile $archivePath
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHASUMS256.txt").Content
  $checksumPattern = "(?m)^([a-fA-F0-9]{64})\s+\*?$([regex]::Escape($archiveName))\s*$"
  $checksumMatch = [regex]::Match($checksums, $checksumPattern)
  if (-not $checksumMatch.Success) {
    throw "The official Node.js checksum list did not include $archiveName."
  }

  $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  if ($actualChecksum -ine $checksumMatch.Groups[1].Value) {
    throw "The Node.js download failed SHA-256 verification."
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath
  $extractedFolder = Get-ChildItem -LiteralPath $expandedPath -Directory | Select-Object -First 1
  if (-not $extractedFolder) {
    throw "The Node.js archive did not contain the expected runtime folder."
  }
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  if (Test-Path $installPath) {
    Remove-Item -LiteralPath $installPath -Recurse -Force
  }
  Move-Item -LiteralPath $extractedFolder.FullName -Destination $installPath

  $installedVersion = & $nodePath --version
  if ($LASTEXITCODE -ne 0 -or $installedVersion -ne $release.version) {
    throw "The installed Node.js runtime did not report the expected version."
  }
  [IO.File]::WriteAllText($currentPathFile, $nodePath, [Text.UTF8Encoding]::new($false))
  Write-Output $nodePath
}
finally {
  if (Test-Path $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
