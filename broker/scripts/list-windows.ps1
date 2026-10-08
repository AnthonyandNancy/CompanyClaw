# CompanyClaw UIA probe (read-only).
#
# Enumerates top-level windows via Windows UI Automation and returns JSON.
# This script performs no input injection and no state mutation: it is the
# read-only probe the broker uses for `list-windows`.
#
# Output: JSON array of { name, processId, automationId }.

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
)

$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
$result = @()
foreach ($window in $windows) {
    try {
        $result += [pscustomobject]@{
            name         = [string]$window.Current.Name
            processId    = [int]$window.Current.ProcessId
            automationId = [string]$window.Current.AutomationId
        }
    } catch {
        # A window can disappear mid-enumeration; skip it rather than failing.
    }
}

# ConvertTo-Json needs -AsArray on PowerShell 7 but rejects it on Windows
# PowerShell 5.1, so wrap the array in an object instead: the shape is stable
# across both hosts.
$payload = [pscustomobject]@{ windows = @($result) }
$payload | ConvertTo-Json -Compress -Depth 4
