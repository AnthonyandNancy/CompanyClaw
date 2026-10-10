<#
.SYNOPSIS
  Builds the compiled desktop test fixture.

.DESCRIPTION
  Uses the C# compiler that ships with the .NET Framework, so no SDK is needed —
  the point is that this evidence can be regenerated on any machine that can run
  CompanyClaw, including the employee's own.
#>
[CmdletBinding()]
param([switch]$Force)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $scriptDir "CompanyClawTestApp.cs"
$output = Join-Path $scriptDir "CompanyClawTestApp.exe"

$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $compiler)) { throw "未找到 .NET Framework 编译器（csc.exe）" }

if ((Test-Path $output) -and -not $Force) {
  Write-Output "fixture already built: $output"
  exit 0
}

& $compiler /nologo /target:winexe /out:$output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $source
if (-not (Test-Path $output)) { throw "夹具编译失败" }
Write-Output "built $output"
