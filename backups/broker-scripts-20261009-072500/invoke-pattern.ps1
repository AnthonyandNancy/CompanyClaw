# CompanyClaw UIA invoke-pattern probe (MUTATING — requires a broker ticket).
#
# Activates one target element through a semantic UI Automation pattern
# (Invoke / SelectionItem). Semantic activation is preferred over synthetic
# clicks because it does not depend on screen coordinates or focus.
#
# Env: CC_TARGET_PROCESS (required), CC_TARGET_TITLE, CC_SEL_* (selector),
#      CC_PATTERN (Invoke|SelectionItem, default Invoke),
#      CC_MAX_DEPTH, CC_MAX_VISITED
#
# Output: { window, element, pattern, invoked }

. "$PSScriptRoot\_uia-common.ps1"

$processName = Get-CcEnv "CC_TARGET_PROCESS"
$titleFilter = $env:CC_TARGET_TITLE
$patternName = if ($env:CC_PATTERN) { [string]$env:CC_PATTERN } else { "Invoke" }
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

$isEnabled = $false
try { $isEnabled = [bool]$element.Current.IsEnabled } catch { $isEnabled = $false }
if (-not $isEnabled) { Write-CcError "element-is-disabled" }

$invoked = $false
switch ($patternName) {
    "Invoke" {
        $pattern = Get-CcSupportedPattern $element "InvokePattern"
        if ($null -eq $pattern) { Write-CcError "invoke-pattern-unsupported" }
        try {
            $pattern.Invoke()
            $invoked = $true
        } catch {
            Write-CcError "invoke-failed"
        }
    }
    "SelectionItem" {
        $pattern = Get-CcSupportedPattern $element "SelectionItemPattern"
        if ($null -eq $pattern) { Write-CcError "selection-item-pattern-unsupported" }
        try {
            $pattern.Select()
            $invoked = $true
        } catch {
            Write-CcError "select-failed"
        }
    }
    default { Write-CcError "unsupported-pattern" }
}

Write-CcJson ([pscustomobject]@{
    window = [pscustomobject]@{
        name      = [string]$window.Current.Name
        processId = [int]$window.Current.ProcessId
    }
    element = New-CcElementSummary $element
    pattern = $patternName
    invoked = $invoked
})
