# CompanyClaw UIA element probe (read-only).
#
# Reads the UI Automation control tree for one target window and returns JSON.
# Performs no input injection and no state mutation.
#
# Inputs (environment variables, set by the broker):
#   CC_TARGET_PROCESS  - executable base name without .exe (required)
#   CC_TARGET_TITLE    - window title substring (optional)
#   CC_MAX_DEPTH       - tree depth to walk, default 4
#   CC_MAX_ELEMENTS    - cap on returned elements, default 200
#
# Output: { window: {...}, elements: [ { name, automationId, controlType,
#           className, isEnabled, processId, depth } ] }

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$procName = $env:CC_TARGET_PROCESS
if ([string]::IsNullOrWhiteSpace($procName)) {
    Write-Output '{"error":"missing-target-process"}'
    exit 0
}

$titleFilter = $env:CC_TARGET_TITLE
$maxDepth = 4
if ($env:CC_MAX_DEPTH) { [void][int]::TryParse($env:CC_MAX_DEPTH, [ref]$maxDepth) }
$maxElements = 200
if ($env:CC_MAX_ELEMENTS) { [void][int]::TryParse($env:CC_MAX_ELEMENTS, [ref]$maxElements) }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
)
$allWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)

function Get-ProcessBaseName([int]$processId) {
    try {
        $p = Get-Process -Id $processId -ErrorAction Stop
        return $p.ProcessName
    } catch {
        return ""
    }
}

$target = $null
foreach ($candidate in $allWindows) {
    try {
        $base = Get-ProcessBaseName -processId $candidate.Current.ProcessId
        if ($base -ne $procName) { continue }
        if (-not [string]::IsNullOrWhiteSpace($titleFilter)) {
            if ($candidate.Current.Name -notlike "*$titleFilter*") { continue }
        }
        $target = $candidate
        break
    } catch {
        continue
    }
}

if ($null -eq $target) {
    Write-Output '{"error":"target-window-not-found"}'
    exit 0
}

$elements = New-Object System.Collections.ArrayList
$walkerCondition = [System.Windows.Automation.Condition]::TrueCondition

function Add-Elements($element, [int]$depth) {
    if ($depth -gt $maxDepth) { return }
    if ($elements.Count -ge $maxElements) { return }
    try {
        $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, $walkerCondition)
    } catch {
        return
    }
    foreach ($child in $children) {
        if ($elements.Count -ge $maxElements) { return }
        try {
            [void]$elements.Add([pscustomobject]@{
                name         = [string]$child.Current.Name
                automationId = [string]$child.Current.AutomationId
                controlType  = [string]$child.Current.ControlType.ProgrammaticName
                className    = [string]$child.Current.ClassName
                isEnabled    = [bool]$child.Current.IsEnabled
                processId    = [int]$child.Current.ProcessId
                depth        = $depth
            })
        } catch {
            continue
        }
        Add-Elements $child ($depth + 1)
    }
}

Add-Elements $target 1

$payload = [pscustomobject]@{
    window = [pscustomobject]@{
        name      = [string]$target.Current.Name
        processId = [int]$target.Current.ProcessId
    }
    elements = @($elements)
}
$payload | ConvertTo-Json -Compress -Depth 5
