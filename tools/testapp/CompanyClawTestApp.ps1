<#
.SYNOPSIS
  CompanyClaw generic desktop test fixture.

.DESCRIPTION
  A deliberately ordinary WinForms application that gives the Windows
  automation path something real to operate. Requirement V5 §10.1 asks for a
  reproducible fixture with standard UIA controls, a custom-drawn button, a
  scroll region, a delayed dialog, simulated contacts, a simulated "send" final
  commit point, an error dialog and a drop target — so the product's behaviour
  can be measured without a QQ account or a company ERP.

  Why WinForms: it exposes real UI Automation providers (unlike a game engine or
  a canvas), and it needs no SDK to build — the script parses and runs on the
  .NET Framework that ships with Windows. That keeps the fixture reproducible on
  any employee machine, which is the point: the evidence must be regenerable,
  not a screenshot someone took once.

  Every control carries a stable AutomationId so a test can address it by
  identity rather than by screen coordinates:

    FIXTURE_WINDOW            main window
    FIXTURE_APP_NAME          read-only label
    FIXTURE_NAME_INPUT        text field (accepts Chinese input)
    FIXTURE_FIND_BUTTON       semantic button
    FIXTURE_RESULT_LIST       list of simulated contacts
    FIXTURE_MESSAGE_INPUT     multi-line draft field
    FIXTURE_SEND_BUTTON       the final commit point (side effect happens here)
    FIXTURE_SEND_LOG          read-only log proving whether a send occurred
    FIXTURE_SENT_RECIPIENT    read-only label with the last recipient
    FIXTURE_SENT_BODY         read-only label with the last body
    FIXTURE_SCROLL_AREA       scrollable panel with 200 rows
    FIXTURE_DELAYED_DIALOG    button that opens a window after 3 seconds
    FIXTURE_ERROR_DIALOG      button that raises a modal error
    FIXTURE_CUSTOM_BUTTON     owner-drawn control with no native button pattern
    FIXTURE_DROP_TARGET       accepts dropped files
    FIXTURE_DROPPED_FILES     read-only label listing received file names

.PARAMETER Scenario
  Optional. `default` starts the full window; `restricted` starts with the send
  area disabled, used to check that a refused action leaves no side effect.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/testapp/CompanyClawTestApp.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet("default", "restricted")]
  [string]$Scenario = "default"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A stable, unmistakable window title so a caller cannot accidentally automate a
# different application that happens to be open.
$script:WindowTitle = "CompanyClaw Test App"
$script:SendCount = 0

$form = New-Object System.Windows.Forms.Form
$form.Text = $script:WindowTitle
$form.Name = "FIXTURE_WINDOW"
$form.Size = New-Object System.Drawing.Size(720, 620)
$form.StartPosition = "CenterScreen"
$form.AllowDrop = $true
$form.Name = "FIXTURE_WINDOW"

function New-Label {
  param(
    [string]$Text,
    [int]$Top,
    [int]$Left = 16,
    [int]$Width = 200,
    [string]$AutomationId = ""
  )
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Top = $Top
  $label.Left = $Left
  $label.Width = $Width
  $label.Height = 20
  if ($AutomationId) { $label.AccessibleName = $AutomationId
    $label.Name = $AutomationId }
  return $label
}

# ── Application identity ────────────────────────────────────────────────────
$form.Controls.Add((New-Label -Text "应用名称：CompanyClaw 通用测试程序" -Top 12 -Width 420 -AutomationId "FIXTURE_APP_NAME"))

# ── Contact search ─────────────────────────────────────────────────────────
$form.Controls.Add((New-Label -Text "查找联系人" -Top 44 -Width 120))
$nameInput = New-Object System.Windows.Forms.TextBox
$nameInput.Top = 66
$nameInput.Left = 16
$nameInput.Width = 260
$nameInput.Name = "FIXTURE_NAME_INPUT"
$nameInput.AccessibleName = "FIXTURE_NAME_INPUT"
$form.Controls.Add($nameInput)

$findButton = New-Object System.Windows.Forms.Button
$findButton.Text = "查找"
$findButton.Top = 64
$findButton.Left = 288
$findButton.Width = 90
$findButton.Name = "FIXTURE_FIND_BUTTON"
$findButton.AccessibleName = "FIXTURE_FIND_BUTTON"
$form.Controls.Add($findButton)

$resultList = New-Object System.Windows.Forms.ListBox
$resultList.Top = 96
$resultList.Left = 16
$resultList.Width = 360
$resultList.Height = 120
$resultList.Name = "FIXTURE_RESULT_LIST"
$resultList.AccessibleName = "FIXTURE_RESULT_LIST"
$resultList.Items.AddRange(@("测试联系人 甲", "测试联系人 乙", "测试联系人 丙")) | Out-Null
$form.Controls.Add($resultList)

# ── Draft and the send commit point ────────────────────────────────────────
$form.Controls.Add((New-Label -Text "消息草稿（输入不会产生副作用）" -Top 228 -Width 300))
$messageInput = New-Object System.Windows.Forms.TextBox
$messageInput.Top = 250
$messageInput.Left = 16
$messageInput.Width = 360
$messageInput.Height = 90
$messageInput.Multiline = $true
$messageInput.ScrollBars = "Vertical"
$messageInput.Name = "FIXTURE_MESSAGE_INPUT"
$messageInput.AccessibleName = "FIXTURE_MESSAGE_INPUT"
$form.Controls.Add($messageInput)

$sendButton = New-Object System.Windows.Forms.Button
$sendButton.Text = "发送"
$sendButton.Top = 348
$sendButton.Left = 16
$sendButton.Width = 110
$sendButton.Name = "FIXTURE_SEND_BUTTON"
$sendButton.AccessibleName = "FIXTURE_SEND_BUTTON"
if ($Scenario -eq "restricted") { $sendButton.Enabled = $false }
$form.Controls.Add($sendButton)

$sendLog = New-Object System.Windows.Forms.Label
$sendLog.Text = "尚未发送"
$sendLog.Top = 380
$sendLog.Left = 16
$sendLog.Width = 360
$sendLog.Name = "FIXTURE_SEND_LOG"
$sendLog.AccessibleName = "FIXTURE_SEND_LOG"
$form.Controls.Add($sendLog)

$sentRecipient = New-Object System.Windows.Forms.Label
$sentRecipient.Text = ""
$sentRecipient.Top = 402
$sentRecipient.Left = 16
$sentRecipient.Width = 360
$sentRecipient.Name = "FIXTURE_SENT_RECIPIENT"
$sentRecipient.AccessibleName = "FIXTURE_SENT_RECIPIENT"
$form.Controls.Add($sentRecipient)

$sentBody = New-Object System.Windows.Forms.Label
$sentBody.Text = ""
$sentBody.Top = 424
$sentBody.Left = 16
$sentBody.Width = 360
$sentBody.Name = "FIXTURE_SENT_BODY"
$sentBody.AccessibleName = "FIXTURE_SENT_BODY"
$form.Controls.Add($sentBody)

# ── Scroll region ──────────────────────────────────────────────────────────
$form.Controls.Add((New-Label -Text "长列表（滚动测试）" -Top 452 -Left 400 -Width 200))
$scrollArea = New-Object System.Windows.Forms.Panel
$scrollArea.Top = 474
$scrollArea.Left = 400
$scrollArea.Width = 280
$scrollArea.Height = 90
$scrollArea.AutoScroll = $true
$scrollArea.Name = "FIXTURE_SCROLL_AREA"
$scrollArea.AccessibleName = "FIXTURE_SCROLL_AREA"
$scrollInner = New-Object System.Windows.Forms.Panel
$scrollInner.Width = 250
$scrollInner.Height = 200 * 18
for ($index = 1; $index -le 200; $index += 1) {
  $row = New-Object System.Windows.Forms.Label
  $row.Text = "第 $index 行"
  $row.Top = ($index - 1) * 18
  $row.Left = 4
  $row.Width = 240
  $scrollInner.Controls.Add($row)
}
$scrollArea.Controls.Add($scrollInner)
$form.Controls.Add($scrollArea)

# ── Owner-drawn button: no native Invoke pattern, so vision fallback is needed
$customButton = New-Object System.Windows.Forms.Button
$customButton.Text = "自绘按钮"
$customButton.Top = 12
$customButton.Left = 400
$customButton.Width = 120
$customButton.FlatStyle = "Flat"
$customButton.FlatAppearance.BorderSize = 0
$customButton.Name = "FIXTURE_CUSTOM_BUTTON"
$customButton.AccessibleName = "FIXTURE_CUSTOM_BUTTON"
$customButton.Add_Paint({
  param($sender, $event)
  $graphics = $sender.CreateGraphics()
  $graphics.FillRectangle([System.Drawing.Brushes]::LightSteelBlue, 0, 0, $sender.Width, $sender.Height)
  $graphics.DrawString($sender.Text, $sender.Font, [System.Drawing.Brushes]::Black, 10, 8)
})
$form.Controls.Add($customButton)

# ── Delayed window ─────────────────────────────────────────────────────────
$delayedButton = New-Object System.Windows.Forms.Button
$delayedButton.Text = "打开延迟窗口"
$delayedButton.Top = 44
$delayedButton.Left = 400
$delayedButton.Width = 160
$delayedButton.Name = "FIXTURE_DELAYED_DIALOG"
$delayedButton.AccessibleName = "FIXTURE_DELAYED_DIALOG"
$form.Controls.Add($delayedButton)

# ── Error dialog ───────────────────────────────────────────────────────────
$errorButton = New-Object System.Windows.Forms.Button
$errorButton.Text = "触发错误提示"
$errorButton.Top = 76
$errorButton.Left = 400
$errorButton.Width = 160
$errorButton.Name = "FIXTURE_ERROR_DIALOG"
$errorButton.AccessibleName = "FIXTURE_ERROR_DIALOG"
$form.Controls.Add($errorButton)

# ── Drop target ────────────────────────────────────────────────────────────
$form.Controls.Add((New-Label -Text "拖拽区（接收文件）" -Top 472 -Width 200))
$dropTarget = New-Object System.Windows.Forms.Panel
$dropTarget.Top = 494
$dropTarget.Left = 16
$dropTarget.Width = 360
$dropTarget.Height = 70
$dropTarget.BackColor = [System.Drawing.Color]::Gainsboro
$dropTarget.AllowDrop = $true
$dropTarget.Name = "FIXTURE_DROP_TARGET"
$dropTarget.AccessibleName = "FIXTURE_DROP_TARGET"
$form.Controls.Add($dropTarget)

$droppedFiles = New-Object System.Windows.Forms.Label
$droppedFiles.Text = "（未收到文件）"
$droppedFiles.Top = 500
$droppedFiles.Left = 24
$droppedFiles.Width = 340
$droppedFiles.Name = "FIXTURE_DROPPED_FILES"
$droppedFiles.AccessibleName = "FIXTURE_DROPPED_FILES"
$dropTarget.Controls.Add($droppedFiles)

# ── Behaviour ──────────────────────────────────────────────────────────────

$findButton.Add_Click({
  $needle = $nameInput.Text.Trim()
  $resultList.Items.Clear()
  if (-not $needle) {
    $resultList.Items.AddRange(@("测试联系人 甲", "测试联系人 乙", "测试联系人 丙")) | Out-Null
    return
  }
  foreach ($candidate in @("测试联系人 甲", "测试联系人 乙", "测试联系人 丙")) {
    if ($candidate -like "*$needle*") { $resultList.Items.Add($candidate) | Out-Null }
  }
  if ($resultList.Items.Count -eq 0) { $resultList.Items.Add("（无匹配）") | Out-Null }
})

# The only place a side effect happens. A test can therefore observe precisely
# whether an unapproved "send" reached the application: the log is empty or it
# is not.
$sendButton.Add_Click({
  $recipient = if ($resultList.SelectedItem) { [string]$resultList.SelectedItem } else { "（未选择联系人）" }
  $body = $messageInput.Text
  $script:SendCount += 1
  $sendLog.Text = "已发送 $($script:SendCount) 次"
  $sentRecipient.Text = "收件人：$recipient"
  $sentBody.Text = "内容：$body"
})

$customButton.Add_Click({
  $sendLog.Text = "自绘按钮已点击（$($script:SendCount) 次发送）"
})

$delayedButton.Add_Click({
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 3000
  $timer.Add_Tick({
    $timer.Stop()
    $delayed = New-Object System.Windows.Forms.Form
    $delayed.Text = "延迟窗口"
    $delayed.Size = New-Object System.Drawing.Size(320, 160)
    $delayed.AccessibleName = "FIXTURE_DELAYED_WINDOW"
    $delayed.Controls.Add((New-Label -Text "延迟出现的窗口，用于验证等待逻辑。" -Top 24 -Width 280))
    [void]$delayed.ShowDialog($form)
  })
  $timer.Start()
})

$errorButton.Add_Click({
  [System.Windows.Forms.MessageBox]::Show(
    "这是一个测试用错误提示（TEST_FIXTURE_ERROR）。",
    "错误",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
})

$dropTarget.Add_DragEnter({
  param($sender, $event)
  if ($event.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $event.Effect = [System.Windows.Forms.DragDropEffects]::Copy
  }
})
$dropTarget.Add_DragDrop({
  param($sender, $event)
  $paths = $event.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
  $names = @($paths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
  $droppedFiles.Text = "收到：" + ($names -join "、")
})

[void]$form.ShowDialog()
