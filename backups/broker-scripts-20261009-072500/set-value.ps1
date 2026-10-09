# CompanyClaw UIA set-value probe (MUTATING — requires a broker ticket).
#
# Writes a value into one target element via ValuePattern. The broker only runs
# this after BrokerPolicy accepted a verified single-use ticket bound to this
# exact change; this script never decides for itself whether it may run.
#
# Env: CC_TARGET_PROCESS (required), CC_TARGET_TITLE, CC_SEL_* (selector),
#      CC_NEW_VALUE (required), CC_MAX_DEPTH, CC_MAX_VISITED
#
# Output on success: { window, element, previousValue, newValue, verified }
# `verified` is the read-back result — the broker reports success only when the
# read-back matches.

. "$PSScriptRoot\_uia-common.ps1"

$processName = Get-CcEnv "CC_TARGET_PROCESS"
$titleFilter = $env:CC_TARGET_TITLE
$newValue = Get-CcEnv "CC_NEW_VALUE"
$maxDepth = 8
if ($env:CC_MAX_DEPTH) { [void][int]::TryParse($env:CC_MAX_DEPTH, [ref]$maxDepth) }
$maxVisited = 4000
if ($env:CC_MAX_VISITED) { [void][int]::TryParse($env:CC_MAX_VISITED, [ref]$maxVisited) }

$selector = Read-CcSelector
if (Test-CcSelectorEmpty $selector) { Write-CcError "empty-selector" }

$window = Find-CcWindow -processName $processName -titleFilter $titleFilter
if ($null -eq $window) { Write-CcError "target-window-not-found" }

$element = Find-CcElement $window $selector $maxDepth $maxVisited
if ($null -eq $element) { Write-CcError "target-element-not-found" }

$valuePattern = Get-CcSupportedPattern $element "ValuePattern"
if ($null -eq $valuePattern) { Write-CcError "value-pattern-unsupported" }

$isReadOnly = $false
try { $isReadOnly = [bool]$valuePattern.Current.IsReadOnly } catch { $isReadOnly = $false }
if ($isReadOnly) { Write-CcError "element-is-read-only" }

$previousValue = $null
try { $previousValue = [string]$valuePattern.Current.Value } catch { $previousValue = $null }

try {
    $valuePattern.SetValue($newValue)
} catch {
    Write-CcError "set-value-failed"
}

# Read back through a fresh element handle so a cached value cannot mask a
# failed write.
$verifyWindow = Find-CcWindow -processName $processName -titleFilter $titleFilter
if ($null -eq $verifyWindow) { Write-CcError "verification-window-lost" }
$verifyElement = Find-CcElement $verifyWindow $selector $maxDepth $maxVisited
if ($null -eq $verifyElement) { Write-CcError "verification-element-lost" }

$verified = $false
$observedValue = $null
$verifyPattern = Get-CcSupportedPattern $verifyElement "ValuePattern"
if ($null -ne $verifyPattern) {
    try {
        $observedValue = [string]$verifyPattern.Current.Value
        $verified = ($observedValue -eq $newValue)
    } catch {
        $verified = $false
    }
}

Write-CcJson ([pscustomobject]@{
    window = [pscustomobject]@{
        name      = [string]$window.Current.Name
        processId = [int]$window.Current.ProcessId
    }
    element       = New-CcElementSummary $element
    previousValue = $previousValue
    newValue      = $newValue
    observedValue = $observedValue
    verified      = $verified
})
