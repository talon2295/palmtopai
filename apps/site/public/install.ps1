# Installs palmtop, the checklist for AI coding: https://palmtop.mtwa.it
#
#   irm https://palmtop.mtwa.it/install.ps1 | iex
#
# Downloads palmtop into %USERPROFILE%\.palmtopai\bin, checks it against the published SHA-256,
# then runs `palmtop setup`: on a terminal it asks which agents to set up, whether to add palmtop
# to your PATH and whether to pair a device; without one (an agent, a script) it asks nothing and
# prints the steps left. Running it again updates palmtop. Options are passed to `palmtop setup`:
#
#   & ([scriptblock]::Create((irm https://palmtop.mtwa.it/install.ps1))) --force-agents-install
#
# It needs Windows PowerShell 5.1 or newer and Node.js 22 or newer. It never asks for
# administrator rights and writes only under %USERPROFILE%\.palmtopai, plus what `palmtop setup`
# tells you. It never calls `exit`: that would close your PowerShell window.

# Everything is inside a function, called on the last line: a download cut halfway runs nothing.
function Install-Palmtop {
    $ErrorActionPreference = 'Stop'
    # The progress bar of Windows PowerShell 5.1 makes a download many times slower.
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 does not use TLS 1.2 unless it is asked to.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $base = if ($env:PALMTOP_INSTALL_URL) { $env:PALMTOP_INSTALL_URL.TrimEnd('/') } else { 'https://palmtop.mtwa.it' }
    $dir = Join-Path $env:USERPROFILE '.palmtopai\bin'

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Failure 'palmtop needs Node.js 22 or newer: install it from https://nodejs.org (or run: winget install OpenJS.NodeJS), open a new PowerShell window, then run this again.'
        return
    }
    $nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
    if ([int]($nodeVersion.Split('.')[0]) -lt 22) {
        Write-Failure "palmtop needs Node.js 22 or newer (found $nodeVersion): update it from https://nodejs.org (or run: winget upgrade OpenJS.NodeJS), open a new PowerShell window, then run this again."
        return
    }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $download = Join-Path $dir '.palmtop.mjs.download'
    $releaseFile = Join-Path $dir '.version.json.download'
    try {
        Write-Step "Downloading palmtop from $base"
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/version.json" -OutFile $releaseFile
        } catch {
            Write-Failure "could not download $base/version.json"
            return
        }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/palmtop.mjs" -OutFile $download
        } catch {
            Write-Failure "could not download $base/palmtop.mjs"
            return
        }

        # Size and SHA-256 of the download against version.json.
        $release = Get-Content -Raw -Path $releaseFile | ConvertFrom-Json
        $size = (Get-Item -Path $download).Length
        # .NET itself, not Get-FileHash: a Windows PowerShell started from PowerShell 7 can lack the cmdlet.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($download)
        try {
            $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
        } finally {
            $stream.Dispose()
            $sha.Dispose()
        }
        if ($size -ne $release.size -or $hash -ne $release.sha256) {
            Write-Failure 'the download does not match its SHA-256: nothing was installed.'
            return
        }

        # A running palmtop (the daemon) can hold the file for a moment: try again for a little.
        $target = Join-Path $dir 'palmtop.mjs'
        for ($attempt = 1; ; $attempt++) {
            try {
                Move-Item -Force -Path $download -Destination $target
                break
            } catch {
                if ($attempt -ge 6) {
                    Write-Failure "could not replace $target (is palmtop busy? run: palmtop stop)"
                    return
                }
                Start-Sleep -Milliseconds (100 * $attempt)
            }
        }
        Write-Step "palmtop $($release.version) installed in ~\.palmtopai\bin (SHA-256 verified)"
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue -Path $download, $releaseFile
    }

    # `palmtop setup` writes palmtop.cmd next to the bundle, asks about the PATH and the agents.
    & $node.Source $target setup @args
}

function Write-Step([string]$Message) {
    Write-Host 'OK ' -NoNewline -ForegroundColor Green
    Write-Host $Message
}

function Write-Failure([string]$Message) {
    Write-Host "x $Message" -ForegroundColor Red
    $global:LASTEXITCODE = 1
}

Install-Palmtop @args
