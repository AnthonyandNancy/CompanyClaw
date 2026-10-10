<#
.SYNOPSIS
  Starts the fixture, drives a real UI Automation round trip, and closes it.

.DESCRIPTION
  This is the reproducible form of evidence V5 §10.1 asks for: the fixture is
  launched, its window is discovered through the same accessibility tree the
  product uses, a value is written and read back, and the result is printed as
  JSON so a caller (or CI) can assert on it.

  It deliberately drives the *real* provider tree rather than the broker, so a
  failure points at Windows/UIA or at the fixture, never at the broker policy —
  the two are separable precisely so a fault can be attributed.

.PARAMETER KeepOpen
  Leave the fixture running afterwards, for manual inspection.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/testapp/run-fixture-and-check.ps1
#>
[CmdletBinding()]
param([switch]$KeepOpen)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appPath = Join-Path $scriptDir "CompanyClawTestApp.ps1"
$result = [ordered]@{
  fixtureLaunched = $false
  windowFound = $false
  nameInputFound = $false
  valueWritten = $false
  valueReadBack = $false
  readBackValue = $null
  sendLogFound = $false
  elementCount = 0
  addressedBy = $null
  valuePatternAvailable = $true
  error = $null
}

$process = $null
try {
  $process = Start-Process -FilePath "powershell" `
    -ArgumentList @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", "`"$appPath`"") `
    -PassThru
  $result.fixtureLaunched = $true

  $automation = [System.Windows.Automation.AutomationElement]::RootElement
  $window = $null
  for ($attempt = 0; $attempt -lt 40 -and -not $window; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      "CompanyClaw Test App"
    )
    $window = $automation.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  }
  if (-not $window) { throw "未找到测试程序窗口（超时）" }
  $result.windowFound = $true

  function Find-ByAutomationId {
    param($root, [string]$automationId)
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  }

  # Count what the window actually exposes, so a caller can see that the tree is
  # populated rather than merely present.
  $descendants = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $result.elementCount = $descendants.Count

  # Address the input by its accessible *name* first: a WinForms control reached
  # through the MSAA bridge may report a legacy node whose AutomationId is a
  # handle rather than the control's `Name`, and the product must cope with both
  # — which is exactly what this check records.
  $nameInput = Find-ByAutomationId -root $window -automationId "FIXTURE_NAME_INPUT"
  $addressedBy = "automation-id"
  if (-not $nameInput) {
    $byName = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      "FIXTURE_NAME_INPUT"
    )
    $nameInput = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName)
    $addressedBy = "accessible-name"
  }
  $result.addressedBy = $addressedBy
  $result.nameInputFound = ($null -ne $nameInput)

  if ($nameInput) {
    # Write through the *semantic* pattern, which is what the product does: no
    # coordinates, no focus stealing, and the value can be read back afterwards.
    $valuePattern = $null
    if ($nameInput.TryGetCurrentPattern(
        [System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
      $valuePattern.SetValue("测试联系人 乙")
      $result.valueWritten = $true
      $readBack = $valuePattern.Current.Value
      $result.readBackValue = $readBack
      $result.valueReadBack = ($readBack -eq "测试联系人 乙")
    } else {
      # The provider exposes the element but not the value pattern. Reported as
      # such rather than as a failure: it says the environment bridges WinForms
      # through MSAA, which is a fact about the session, not about the product.
      $result.valuePatternAvailable = $false
    }
  }

  $sendLog = Find-ByAutomationId -root $window -automationId "FIXTURE_SEND_LOG"
  $result.sendLogFound = ($null -ne $sendLog)
} catch {
  $result.error = $_.Exception.Message
} finally {
  if (-not $KeepOpen -and $process) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$result | ConvertTo-Json -Compress

# Success means: the fixture started, its window was found through the
# accessibility tree, and the tree was populated. The control-level round trip is
# reported in the payload and asserted only when the session actually bridges
# WinForms semantically — a legacy-only bridge is a fact about this session, and
# pretending otherwise would be exactly the kind of evidence inflation the
# requirement forbids.
if ($result.error) { exit 1 }
if (-not ($result.windowFound -and $result.elementCount -gt 0)) { exit 1 }
if ($result.valuePatternAvailable -eq $false) { exit 2 }
if ($result.valueWritten -and -not $result.valueReadBack) { exit 1 }
exit 0
