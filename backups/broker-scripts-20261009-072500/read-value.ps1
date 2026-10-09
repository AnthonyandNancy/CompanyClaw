# CompanyClaw UIA read-value probe (read-only).
#
# Reads the current value/name of one target element. Performs no input
# injection and no state mutation, so the broker can run it without a ticket.
#
# Env: CC_TARGET_PROCESS (required), CC_TARGET_TITLE, CC_SEL_* (selector),
#      CC_MAX_DEPTH (default 8), CC_MAX_VISITED (default 4000)
#
# Output: { window, element: {...}, value, valueReadable }

. "$PSScriptRoot\_uia-common.ps1"

$processName = Get-CcEnv "CC_TARGET_PROCESS"
$titleFilter = $env:CC_TARGET_TITLE
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

# ValuePattern is optional; when absent the caller gets `valueReadable = false`
# rather than a fabricated empty value.
$valuePattern = Get-CcSupportedPattern $element "ValuePattern"
$value = $null
$valueReadable = $false
if ($null -ne $valuePattern) {
    try {
        $value = [string]$valuePattern.Current.Value
        $valueReadable = $true
    } catch {
        $valueReadable = $false
    }
}

Write-CcJson ([pscustomobject]@{
    window = [pscustomobject]@{
        name      = [string]$window.Current.Name
        processId = [int]$window.Current.ProcessId
    }
    element       = New-CcElementSummary $element
    value         = $value
    valueReadable = $valueReadable
})
