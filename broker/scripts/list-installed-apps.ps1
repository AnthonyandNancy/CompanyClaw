# CompanyClaw application discovery probe (read-only).
#
# Enumerates the applications the Start Menu can open, via `Get-StartApps`, and
# returns JSON. This script performs no input injection and no state mutation: it
# is the read-only probe the broker uses for `list-installed-apps`.
#
# Why this lives on the broker rather than in the vendored server: the pinned
# upstream release ships no tool that enumerates installed applications, so
# without this probe the capability has no implementation at all.
#
# Output: JSON { apps: [ { name, appId } ] }

$ErrorActionPreference = "Stop"

# The broker reads this output as UTF-8; without the explicit encoding the host
# writes the console code page instead, and every non-ASCII application name
# arrives as U+FFFD — which makes the Chinese names most employees see
# unopenable, since launch matches on the display name.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$apps = @()
try {
    # `Get-StartApps` is the same source the Start Menu itself uses, so it
    # includes packaged (UWP) and classic applications alike.
    $rows = Get-StartApps | Select-Object Name, AppID
    foreach ($row in $rows) {
        $name = [string]$row.Name
        $appId = [string]$row.AppID
        if ($name -and $appId) {
            $apps += [pscustomobject]@{ name = $name; appId = $appId }
        }
    }
} catch {
    # Fall through to the shortcut scan below rather than failing the probe.
    $apps = @()
}

if ($apps.Count -eq 0) {
    # Fallback: scan the Start Menu shortcut folders. Works on trimmed-down
    # images where `Get-StartApps` is unavailable.
    $startMenuPaths = @(
        (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"),
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
    )
    foreach ($basePath in $startMenuPaths) {
        if (-not $basePath -or -not (Test-Path -LiteralPath $basePath)) {
            continue
        }
        $shortcuts = Get-ChildItem -LiteralPath $basePath -Filter *.lnk -Recurse -ErrorAction SilentlyContinue
        foreach ($shortcut in $shortcuts) {
            $name = [System.IO.Path]::GetFileNameWithoutExtension($shortcut.Name)
            if ($name) {
                $apps += [pscustomobject]@{ name = $name; appId = $shortcut.FullName }
            }
        }
    }
}

$payload = [pscustomobject]@{ apps = @($apps) }
$payload | ConvertTo-Json -Compress -Depth 4
