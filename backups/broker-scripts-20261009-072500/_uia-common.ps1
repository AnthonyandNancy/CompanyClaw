# CompanyClaw UIA shared helpers.
#
# Dot-sourced by the operation scripts so window/element lookup and JSON output
# stay identical across read and write probes. Every helper is read-only except
# where explicitly named; the mutating parts live in the operation scripts so
# they are easy to audit.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Write-CcJson($payload) {
    $payload | ConvertTo-Json -Compress -Depth 6
}

function Write-CcError([string]$code) {
    Write-CcJson ([pscustomobject]@{ error = $code })
    exit 0
}

# Reads a required environment variable or emits a structured error.
function Get-CcEnv([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        Write-CcError "missing-$($name.ToLower() -replace '_','-')"
    }
    return $value
}

function Get-CcProcessBaseName([int]$processId) {
    try {
        return [string](Get-Process -Id $processId -ErrorAction Stop).ProcessName
    } catch {
        return ""
    }
}

# Returns the target window element, or $null. Matching is on the real process
# base name (never on window-title text), with an optional title substring.
function Find-CcWindow([string]$processName, [string]$titleFilter) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
    foreach ($candidate in $windows) {
        try {
            $base = Get-CcProcessBaseName -processId $candidate.Current.ProcessId
            if ($base -ne $processName) { continue }
            if (-not [string]::IsNullOrWhiteSpace($titleFilter)) {
                if ($candidate.Current.Name -notlike "*$titleFilter*") { continue }
            }
            return $candidate
        } catch {
            continue
        }
    }
    return $null
}

# Selector fields arrive as individual env vars so the broker can validate them
# before a script ever runs.
function Read-CcSelector {
    return [pscustomobject]@{
        automationId = [string]$env:CC_SEL_AUTOMATION_ID
        name         = [string]$env:CC_SEL_NAME
        controlType  = [string]$env:CC_SEL_CONTROL_TYPE
        className    = [string]$env:CC_SEL_CLASS_NAME
        index        = if ($env:CC_SEL_INDEX) { [int]$env:CC_SEL_INDEX } else { 0 }
    }
}

function Test-CcSelectorEmpty($selector) {
    return (
        [string]::IsNullOrWhiteSpace($selector.automationId) -and
        [string]::IsNullOrWhiteSpace($selector.name) -and
        [string]::IsNullOrWhiteSpace($selector.controlType) -and
        [string]::IsNullOrWhiteSpace($selector.className)
    )
}

function Test-CcElementMatches($element, $selector) {
    try {
        if (-not [string]::IsNullOrWhiteSpace($selector.automationId)) {
            if ($element.Current.AutomationId -ne $selector.automationId) { return $false }
        }
        if (-not [string]::IsNullOrWhiteSpace($selector.name)) {
            if ($element.Current.Name -ne $selector.name) { return $false }
        }
        if (-not [string]::IsNullOrWhiteSpace($selector.controlType)) {
            $expected = $selector.controlType
            if ($expected -notlike "ControlType.*") { $expected = "ControlType.$expected" }
            if ($element.Current.ControlType.ProgrammaticName -ne $expected) { return $false }
        }
        if (-not [string]::IsNullOrWhiteSpace($selector.className)) {
            if ($element.Current.ClassName -ne $selector.className) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# Depth-first search for the Nth element matching the selector.
# Plain loop state (no nested function) so the counters behave predictably.
function Find-CcElement($root, $selector, [int]$maxDepth, [int]$maxVisited) {
    $walkerCondition = [System.Windows.Automation.Condition]::TrueCondition
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([pscustomobject]@{ element = $root; depth = 0 })
    $matchCount = 0
    $visited = 0
    $depthLimited = New-Object System.Collections.Queue

    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        if ($node.depth -ge $maxDepth) { continue }
        $visited++
        if ($visited -gt $maxVisited) { return $null }

        try {
            $children = $node.element.FindAll(
                [System.Windows.Automation.TreeScope]::Children, $walkerCondition)
        } catch {
            continue
        }

        foreach ($child in $children) {
            if (Test-CcElementMatches $child $selector) {
                if ($matchCount -eq $selector.index) { return $child }
                $matchCount++
            }
            if (($node.depth + 1) -lt $maxDepth) {
                $queue.Enqueue([pscustomobject]@{ element = $child; depth = $node.depth + 1 })
            }
        }
    }
    return $null
}

function Get-CcSupportedPattern($element, [string]$patternName) {
    switch ($patternName) {
        "ValuePattern" {
            $p = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { return $p }
            return $null
        }
        "InvokePattern" {
            $p = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { return $p }
            return $null
        }
        "SelectionItemPattern" {
            $p = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { return $p }
            return $null
        }
        default { return $null }
    }
}

function New-CcElementSummary($element) {
    return [pscustomobject]@{
        name         = [string]$element.Current.Name
        automationId = [string]$element.Current.AutomationId
        controlType  = [string]$element.Current.ControlType.ProgrammaticName
        className    = [string]$element.Current.ClassName
        isEnabled    = [bool]$element.Current.IsEnabled
        processId    = [int]$element.Current.ProcessId
    }
}
