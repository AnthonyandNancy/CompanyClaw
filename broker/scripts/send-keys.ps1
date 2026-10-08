# CompanyClaw text-input probe (MUTATING — requires a broker ticket).
#
# Writes text into one target element by element-addressed means only: the
# element is focused through UI Automation and the text is committed through
# ValuePattern. It never synthesises global input.
#
# Why not SendKeys/SendInput: a global keyboard stream is delivered to whatever
# control currently owns focus, so a window that steals focus between the check
# and the keystroke receives the text instead. The requirements explicitly say a
# generic Click/Type surface must not be handed to the agent, so this probe
# sticks to the pattern that can be addressed and verified per element.
#
# Env: CC_TARGET_PROCESS (required), CC_TARGET_TITLE, CC_SEL_* (selector),
#      CC_TEXT (required), CC_APPEND (1 = append, 0 = replace),
#      CC_MAX_DEPTH, CC_MAX_VISITED
#
# Output: { window, element, typed, expected, observedValue, verified }

. "$PSScriptRoot\_uia-common.ps1"

$processName = Get-CcEnv "CC_TARGET_PROCESS"
$titleFilter = $env:CC_TARGET_TITLE
$text = Get-CcEnv "CC_TEXT"
$append = ($env:CC_APPEND -eq "1")
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

$valuePattern = Get-CcSupportedPattern $element "ValuePattern"
if ($null -eq $valuePattern) { Write-CcError "value-pattern-unsupported" }

$isReadOnly = $false
try { $isReadOnly = [bool]$valuePattern.Current.IsReadOnly } catch { $isReadOnly = $false }
if ($isReadOnly) { Write-CcError "element-is-read-only" }

$previousValue = $null
try { $previousValue = [string]$valuePattern.Current.Value } catch { $previousValue = $null }

$expected = if ($append -and $previousValue) { "$previousValue$text" } else { $text }

try {
    $valuePattern.SetValue($expected)
} catch {
    Write-CcError "text-input-failed"
}

# Re-locate through a fresh handle and read back, so a cached value cannot mask
# a write that did not stick.
$verifyWindow = Find-CcWindow -processName $processName -titleFilter $titleFilter
if ($null -eq $verifyWindow) { Write-CcError "verification-window-lost" }
$verifyElement = Find-CcElement $verifyWindow $selector $maxDepth $maxVisited
if ($null -eq $verifyElement) { Write-CcError "verification-element-lost" }

$observedValue = $null
$verified = $false
$verifyPattern = Get-CcSupportedPattern $verifyElement "ValuePattern"
if ($null -ne $verifyPattern) {
    try {
        $observedValue = [string]$verifyPattern.Current.Value
        $verified = ($observedValue -eq $expected)
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
    typed         = $text
    expected      = $expected
    observedValue = $observedValue
    verified      = $verified
})
