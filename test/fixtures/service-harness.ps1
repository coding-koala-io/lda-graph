param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [switch]$EncodingPlan)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Load only function definitions, never the script's elevation/dispatch entry point.
$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\service.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([ScriptBlock]::Create($definition.Extent.Text.Replace('$PSScriptRoot', '(Split-Path -Parent $scriptPath)')))
}
$serviceId = 'LdaGraph'
$legacyServiceId = 'OptimizelyGraphLocal'
$wrapperUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$wrapperSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$serviceDir = Join-Path $RuntimeRoot 'service'
$wrapper = Join-Path $serviceDir 'fake-wrapper.txt'
$xmlFile = Join-Path $serviceDir 'LdaGraph.xml'
$tenantsFile = Join-Path $RuntimeRoot 'tenants.json'
$wrapperLogs = Join-Path $serviceDir 'logs'
$utf8 = New-Object Text.UTF8Encoding($false)
$OutputEncoding = $utf8
$Port = 19082
$portExplicit = $true
$MaxMemoryMB = 8192
$maxMemoryExplicit = $false
$ImportFrom = ''
$RemoveData = $false
$installed = $null
$legacy = $null
$actions = New-Object 'System.Collections.Generic.List[string]'
$script:aclCalls = @()
$script:restrictedCalls = @()
$script:mockAcls = @{}
# Per-path owner SIDs; every other path is owned by $directoryOwnerSid.
$script:ownerOverrides = @{}

# All admin/network/process entry points are replaced before running any command.
function Get-GraphService { return $script:installed }
function Get-LegacyService { return $script:legacy }
function Assert-PortAvailable { $actions.Add('port-check') }
function Invoke-Wrapper([string]$Action) { $actions.Add("wrapper-$Action") }
function Set-ServiceConfiguration { $actions.Add('configure') }
function Stop-GraphService { $actions.Add('stop') }
function Wait-Healthy { $actions.Add('health') }
function icacls { $actions.Add('acl'); $script:aclCalls += ,@($args); $script:LASTEXITCODE = 0 }
$directoryOwnerSid = 'S-1-5-18'
function Get-Acl {
    param($LiteralPath)
    if ($script:mockAcls.ContainsKey($LiteralPath)) { return $script:mockAcls[$LiteralPath] }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $ownerSid = $script:directoryOwnerSid
    if ($script:ownerOverrides.ContainsKey($LiteralPath)) { $ownerSid = $script:ownerOverrides[$LiteralPath] }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
    return $acl
}
# Folders created with a restrictive DACL: record the call, create a plain folder (a real protected
# DACL would lock this unelevated test out) and remember the requested security.
$script:secureDirectories = New-Object 'System.Collections.Generic.List[string]'
function New-RestrictedDirectory([string]$Path, [switch]$Service) {
    Check (!(Test-Path -LiteralPath $Path)) 'Restricted directory created over an existing folder'
    Check (Test-Path -LiteralPath (Split-Path $Path -Parent)) 'Restricted directories were not created top-down'
    $script:secureDirectories.Add($Path)
    Microsoft.PowerShell.Management\New-Item -ItemType Directory -Path $Path | Out-Null
    $security = New-RestrictedDirectorySecurity -Service:$Service
    $ownerSid = $script:directoryOwnerSid
    if ($script:ownerOverrides.ContainsKey($Path)) { $ownerSid = $script:ownerOverrides[$Path] }
    $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
    $script:mockAcls[$Path] = $security
}
function Set-Acl {
    param($LiteralPath, $AclObject)
    $rules = @($AclObject.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        Check ($rule.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19', 'S-1-5-32-545')) 'Unexpected ACL principal'
    }
    if ($LiteralPath -in @($RuntimeRoot, $serviceDir)) {
        $expected = @{'S-1-5-18' = 'FullControl'; 'S-1-5-32-544' = 'FullControl'; 'S-1-5-19' = 'Modify'}
        $action = 'dacl-root'
        if ($LiteralPath -eq $serviceDir) { $expected['S-1-5-19'] = 'ReadAndExecute'; $expected['S-1-5-32-545'] = 'ReadAndExecute'; $action = 'dacl-service' }
        Check $AclObject.AreAccessRulesProtected 'DACL inheritance remains enabled'
        Check ($rules.Count -eq $expected.Count) 'Restricted DACL has unexpected ACEs'
        foreach ($rule in $rules) {
            $identity = $rule.IdentityReference
            $expectedRule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $expected[$identity.Value], 'ContainerInherit, ObjectInherit', 'None', 'Allow')
            Check (!$rule.IsInherited -and $rule.AccessControlType -eq 'Allow') 'Restricted DACL has inherited or deny ACEs'
            Check ($rule.FileSystemRights -eq $expectedRule.FileSystemRights -and $rule.InheritanceFlags -eq $expectedRule.InheritanceFlags -and $rule.PropagationFlags -eq 'None') 'Restricted DACL has wrong rights/flags'
        }
        $actions.Add($action)
        $script:restrictedCalls += [PSCustomObject]@{Path = $LiteralPath; TenantsPresent = (Test-Path -LiteralPath $tenantsFile)}
    } else {
        $actions.Add('acl-add')
        if ($LiteralPath -eq (Join-Path $serviceDir "$serviceId.wrapper.log")) {
            Check (@($rules | Where-Object { $_.InheritanceFlags -ne 'None' }).Count -eq 0) 'File received directory inheritance flags'
        }
    }
    $AclObject.SetOwner((New-Object Security.Principal.SecurityIdentifier($script:directoryOwnerSid)))
    $script:mockAcls[$LiteralPath] = $AclObject
}
function Invoke-WebRequest { throw 'Network access forbidden in test harness' }
function Start-Process { throw 'Elevation forbidden in test harness' }
function Get-NetTCPConnection { throw 'Real port inspection forbidden in test harness' }
function Stop-Service { throw 'Service changes forbidden in test harness' }
# External tools come from the Windows system folder; the mock maps icacls.exe to the icacls function above.
$systemTool = ${function:Get-SystemTool}
foreach ($tool in @('icacls.exe', 'sc.exe', 'WindowsPowerShell\v1.0\powershell.exe')) {
    if ((& $systemTool $tool) -ne (Join-Path ([Environment]::SystemDirectory) $tool)) { throw "System tool $tool is not resolved from System32" }
}
function Get-SystemTool([string]$Name) { if ($Name -eq 'icacls.exe') { return 'icacls' }; return & $systemTool $Name }
# No external program may be started by bare name (PATH or current-folder lookup).
foreach ($commandAst in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true)) {
    $name = $commandAst.GetCommandName()
    if ($name -and $name -match '^(icacls|sc|powershell|pwsh|cmd|net|takeown|node|winsw)(\.exe)?$') { throw "External program started by bare name: $name" }
}

function Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
if ($EncodingPlan) {
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)
        $plan = Show-Plan | Out-String
        [xml]$plannedXml = $plan.Substring($plan.IndexOf('<?xml'))
        foreach ($name in @('TENANTS_FILE', 'DATA_DIR', 'LOG_DIR')) {
            $setting = @($plannedXml.service.env | Where-Object { $_.name -eq $name })
            Check ($setting.Count -eq 1 -and $setting[0].value.StartsWith($RuntimeRoot + '\')) 'Plan corrupted a non-ASCII runtime path'
        }
        Check ([Console]::OutputEncoding.CodePage -eq 437) 'Node invocation did not restore console encoding'
        $failed = $false
        try { Invoke-Node 'invalid-action' '{}' 2>$null | Out-Null } catch { $failed = $true }
        Check $failed 'Invalid Node command unexpectedly succeeded'
        Check ([Console]::OutputEncoding.CodePage -eq 437) 'Failed Node invocation did not restore console encoding'
        Check (!(Test-Path -LiteralPath $RuntimeRoot) -and $actions.Count -eq 0) 'Plan changed runtime or service'
    } finally { [Console]::OutputEncoding = $previousEncoding }
    Write-Output 'PASS: UTF-8 plan and restored console encoding'
    exit 0
}

# Check the security boundary at the actual generated/imported write entry points.
$nodeDefinition = ${function:Invoke-Node}
function Check-SecuredDestination {
    Check ($script:mockAcls.ContainsKey($RuntimeRoot) -and $script:mockAcls.ContainsKey($serviceDir)) 'Credentials/data written before restricted DACLs'
    Check ($actions.Contains('dacl-root') -and $actions.Contains('dacl-service') -and $actions.Contains('acl')) 'Credentials/data written before child permissions reset'
}
function Invoke-Node([string]$Action, [string]$Options) {
    if ($Action -eq 'init') { Check-SecuredDestination; $actions.Add('generate-tenants') }
    & $nodeDefinition $Action $Options @args
}
function Copy-Item {
    [CmdletBinding()]
    param([Parameter(ValueFromPipeline = $true)]$InputObject, [string]$LiteralPath, [string]$Destination, [switch]$Recurse, [switch]$Force)
    process {
        Check-SecuredDestination
        $actions.Add('import-write')
        if ($LiteralPath) { Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination }
        else { $InputObject | Microsoft.PowerShell.Management\Copy-Item -Destination $Destination -Recurse:$Recurse -Force:$Force }
    }
}
New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
[IO.File]::WriteAllText($wrapper, 'Test fixture, not WinSW', $utf8)
# Pin the fixture's hash only in this isolated harness; production pins WinSW.
$wrapperSha256 = Get-WrapperHash
$Command = 'install'
# Untrusted ownership and hash mismatches must fail before any install writes/actions.
$ownerOverrides[$serviceDir] = 'S-1-5-19'
$refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use ${serviceDir}: owned by") }
Check $refused 'Untrusted service directory owner was accepted'
Check ($actions.Count -eq 0 -and !(Test-Path -LiteralPath $tenantsFile)) 'Owner refusal changed runtime/service'
$ownerOverrides.Clear()
$fixtureHash = $wrapperSha256
$wrapperSha256 = 'wrong-hash'
$refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('does not match the pinned SHA-256') }
Check $refused 'Existing wrapper hash mismatch was accepted'
Check ($actions.Count -eq 0 -and !(Test-Path -LiteralPath $tenantsFile)) 'Hash refusal changed runtime/service'
$wrapperSha256 = $fixtureHash
$firstOutput = Invoke-CommandBody | Out-String
Check ($firstOutput.Contains('Default instance created')) 'Missing generated CMS snippet'
Check ($firstOutput.Contains('SHA-256')) 'Missing wrapper hash'
Check ($actions.Contains('wrapper-install')) 'Missing fresh install'
Check ($actions.Contains('health')) 'Missing health wait'
Check ($actions.FindAll({ param($action) $action -eq 'acl' }).Count -eq 2) 'Missing pre-write/final child ACL resets'
Check (@($script:aclCalls | Where-Object { ($_ -join ',') -ne ((Join-Path $RuntimeRoot '*') + ',/reset,/T,/C') }).Count -eq 0) 'icacls must only reset child permissions'
Check ($actions.IndexOf('dacl-root') -lt $actions.IndexOf('generate-tenants') -and $actions.IndexOf('dacl-service') -lt $actions.IndexOf('generate-tenants')) 'Generated tenants precede restricted DACLs'
Check (!$script:restrictedCalls[0].TenantsPresent) 'Root DACL was not set before tenants.json existed'
$original = [IO.File]::ReadAllText($tenantsFile)
[xml]$config = [IO.File]::ReadAllText($xmlFile)
Check ($config.service.executable -eq (Get-Command node).Source) 'Incorrect resolved Node executable'
Check (@($config.service.env | Where-Object { $_.name -eq 'PORT' -and $_.value -eq '19082' }).Count -eq 1) 'Incorrect XML port'
Check ($config.service.arguments.StartsWith('--max-old-space-size=8192 "')) 'Missing default memory flag before script path'
Check ($firstOutput.Contains('MaxMemoryMB: 8192 (default)')) 'Missing default memory source'
Check (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'data')) 'Missing data directory'
Check (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'logs')) 'Missing request-log directory'
$installed = [PSCustomObject]@{PathName = '"' + $wrapper + '"'; ProcessId = 123; State = 'Running'}
$portExplicit = $false; $Port = 8082
$actions.Clear()
$secondOutput = Invoke-CommandBody | Out-String
Check ([IO.File]::ReadAllText($tenantsFile) -eq $original) 'Reinstall changed credentials'
Check ($secondOutput.Contains('Preserving existing tenants')) 'Missing preservation notice'
Check ($actions.Contains('configure')) 'Reinstall did not reconfigure service'
Check (!$actions.Contains('wrapper-install')) 'Reinstall reinstalled service'
Check ($Port -eq 19082 -and $secondOutput.Contains('kept from existing config')) 'Reinstall reset configured port'
$portExplicit = $true; $Port = 19083
$maxMemoryExplicit = $true; $MaxMemoryMB = 16384
$changedOutput = Invoke-CommandBody | Out-String
[xml]$changedConfig = [IO.File]::ReadAllText($xmlFile)
Check (@($changedConfig.service.env | Where-Object { $_.name -eq 'PORT' -and $_.value -eq '19083' }).Count -eq 1) 'Explicit reinstall port was ignored'
Check ($changedOutput.Contains('from -Port')) 'Explicit port source was not reported'
Check ($changedConfig.service.arguments.StartsWith('--max-old-space-size=16384 "')) 'Explicit reinstall memory was ignored'
Check ($changedOutput.Contains('MaxMemoryMB: 16384 (from -MaxMemoryMB)')) 'Explicit memory source was not reported'
$maxMemoryExplicit = $false; $MaxMemoryMB = 8192
$keptMemory = Invoke-CommandBody | Out-String
[xml]$keptConfig = [IO.File]::ReadAllText($xmlFile)
Check ($MaxMemoryMB -eq 16384 -and $keptConfig.service.arguments.StartsWith('--max-old-space-size=16384 "')) 'Reinstall reset configured memory'
Check ($keptMemory.Contains('MaxMemoryMB: 16384 (kept from existing config)')) 'Missing retained memory source'
$Port = 19082; Invoke-CommandBody | Out-Null
$ImportFrom = Join-Path $RuntimeRoot 'not-used'; $actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('-ImportFrom was not applied') }
Check $refused 'Existing tenants.json silently ignored ImportFrom'
Check ($actions.Count -eq 0 -and [IO.File]::ReadAllText($tenantsFile) -eq $original) 'Import refusal changed runtime/service'
$ImportFrom = ''
$Command = 'restart'; $Port = 19083; $actions.Clear()
Invoke-CommandBody | Out-Null
Check ($Port -eq 19082) 'Restart ignored XML port'
Check (($actions -join ',') -eq 'port-check,stop,port-check,wrapper-start,health') 'Incorrect restart sequence'
$Command = 'stop'; $actions.Clear(); Invoke-CommandBody | Out-Null
Check (($actions -join ',') -eq 'stop') 'Stop did not dispatch correctly'
$Command = 'start'; $actions.Clear(); Invoke-CommandBody | Out-Null
Check (($actions -join ',') -eq 'port-check,wrapper-start,health') 'Start did not dispatch correctly'
$Command = 'uninstall'; $actions.Clear(); $retained = Invoke-CommandBody | Out-String
Check (Test-Path -LiteralPath $tenantsFile) 'Default uninstall deleted runtime'
Check ($retained.Contains('Runtime data retained')) 'Missing retained-runtime location'
Check ($actions.Contains('wrapper-uninstall')) 'Uninstall did not dispatch wrapper'
$installed.PathName = '"C:\different-runtime\wrapper.exe"'
$actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('another runtime') }
Check $refused 'Wrong-runtime uninstall was not refused'
Check ($actions.Count -eq 0) 'Wrong-runtime uninstall changed service'

# Read-only status and real ownership/health logic use synthetic process/network results.
$installed.PathName = '"' + $wrapper + '"'
$listeners = @([PSCustomObject]@{OwningProcess = 456})
function Get-PortListeners { return $script:listeners }
function Get-CimInstance { return [PSCustomObject]@{ParentProcessId = 123} }
function Get-Process { return [PSCustomObject]@{ProcessName = 'another-process'} }
function Invoke-WebRequest { return [PSCustomObject]@{StatusCode = 200; Content = '{"status":"ok"}'} }
$Command = 'status'; $statusOutput = Invoke-CommandBody | Out-String
Check ($statusOutput.Contains('Service: Running; PID: 123')) 'Status lost service state/PID'
Check ($statusOutput.Contains('Port 19082: PID 456')) 'Status lost port check'
Check ($statusOutput.Contains('Health: HTTP 200 {"status":"ok"}')) 'Status lost health summary'
# A pre-rename install (old service id) is pointed to the upgrade steps only when the new id is absent.
$legacy = [PSCustomObject]@{Name = $legacyServiceId; State = 'Running'}
Check (!((Invoke-CommandBody | Out-String).Contains('Legacy service'))) 'Legacy hint shown although the new service is installed'
$savedInstalled = $installed; $installed = $null
$legacyStatus = Invoke-CommandBody | Out-String
Check ($legacyStatus.Contains('Service: not installed')) 'Status lost not-installed state'
Check ($legacyStatus.Contains("Legacy service $legacyServiceId found " + [char]0x2014 + " run ``lda adopt`` or see README 'Upgrading from an older install'.")) 'Status did not point to the legacy upgrade steps'
$legacy = $null
Check (!((Invoke-CommandBody | Out-String).Contains('Legacy service'))) 'Legacy hint shown without a legacy service'
$installed = $savedInstalled
foreach ($name in @('Assert-PortAvailable', 'Wait-Healthy')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false)
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
Assert-PortAvailable
$healthy = Wait-Healthy | Out-String
Check ($healthy.Contains('Dashboard: http://localhost:19082/')) 'Owned healthy service did not report dashboard'
$listeners = @([PSCustomObject]@{OwningProcess = 999})
function Get-CimInstance { return $null }
$refused = $false
try { Assert-PortAvailable } catch { $refused = $_.Exception.Message.Contains('PID 999 (another-process)') }
Check $refused 'Port collision did not report foreign PID/name'
function Assert-PortAvailable { $actions.Add('port-check') }
function Wait-Healthy { $actions.Add('health') }
function Invoke-WebRequest { throw 'Network access forbidden in test harness' }

# Verify exact UAC argument quoting and temp-result handoff without launching a process.
$Command = 'install'; $ImportFrom = "C:\dev & team's runtime"; $RemoveData = $true
function Start-Process {
    param($FilePath, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle, $ArgumentList)
    Check ($FilePath -eq (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -and $Verb -eq 'RunAs' -and $Wait -and $PassThru -and $WindowStyle -eq 'Hidden') 'Incorrect elevation invocation'
    $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[-1]))
    Check ($decoded.Contains((Quote-PS $RuntimeRoot))) 'Elevation lost RuntimeRoot quoting'
    Check ($decoded.Contains((Quote-PS $ImportFrom))) 'Elevation lost ImportFrom quoting'
    Check ($decoded.Contains('-RemoveData')) 'Elevation lost RemoveData'
    if ($portExplicit) { Check ($decoded.Contains('-Port 19082')) 'Elevation lost explicit port' }
    else { Check (!$decoded.Contains('-Port ')) 'Elevation added an implicit port' }
    if ($maxMemoryExplicit) { Check ($decoded.Contains('-MaxMemoryMB 16384')) 'Elevation lost explicit memory' }
    else { Check (!$decoded.Contains('-MaxMemoryMB ')) 'Elevation added implicit memory' }
    $callTokens = $null; $callErrors = $null
    $callAst = [Management.Automation.Language.Parser]::ParseInput($decoded, [ref]$callTokens, [ref]$callErrors)
    Check ($callErrors.Count -eq 0) 'Elevation produced invalid PowerShell'
    $callCommand = $callAst.Find({param($node) $node -is [Management.Automation.Language.CommandAst]}, $false)
    for ($i = 0; $i -lt $callCommand.CommandElements.Count; $i++) {
        $part = $callCommand.CommandElements[$i]
        if ($part -is [Management.Automation.Language.CommandParameterAst] -and $part.ParameterName -eq 'ResultFile') {
            $script:resultPath = $callCommand.CommandElements[$i + 1].Value
        }
    }
    Check ([IO.Path]::GetDirectoryName($script:resultPath) -eq [IO.Path]::GetTempPath().TrimEnd('\')) 'Result file escaped TEMP'
    [IO.File]::WriteAllText($script:resultPath, '{"exitCode":7,"output":["elevated result line"]}', $utf8)
    return [PSCustomObject]@{ExitCode = 7}
}
$portExplicit = $true
$maxMemoryExplicit = $true
$elevatedOutput = @(Invoke-Elevated)
Check ($elevatedOutput[0] -eq 'elevated result line' -and $elevatedOutput[-1] -eq 7) 'Elevation lost output or exit code'
Check (!(Test-Path -LiteralPath $resultPath)) 'Elevation left its result file behind'
# Require an omitted -Port to stay omitted across elevation.
$portExplicit = $false
$maxMemoryExplicit = $false
$elevatedOutput = @(Invoke-Elevated)
Check ($elevatedOutput[-1] -eq 7) 'Implicit-port elevation lost its result'
$portExplicit = $true
$RemoveData = $false
function Start-Process { throw 'Elevation forbidden in test harness' }

# Import in a second clean temp runtime. Keep the fake wrapper so network remains forbidden.
$installed = $null
$ImportFrom = Join-Path $RuntimeRoot 'source'
New-Item -ItemType Directory -Path (Join-Path $ImportFrom 'data\default'), (Join-Path $ImportFrom 'logs\default') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $ImportFrom 'tenants.json'), $original, $utf8)
[IO.File]::WriteAllText((Join-Path $ImportFrom 'data\default\store.ndjson'), 'stored document', $utf8)
[IO.File]::WriteAllText((Join-Path $ImportFrom 'logs\default\requests.ndjson'), 'request log', $utf8)
# Later runtimes are siblings: a runtime inside another runtime root is refused (LocalService can write there).
$sandbox = Join-Path (Split-Path $RuntimeRoot -Parent) 'cases'
$RuntimeRoot = Join-Path $sandbox 'imported'
$serviceDir = Join-Path $RuntimeRoot 'service'; $wrapper = Join-Path $serviceDir 'fake-wrapper.txt'
$xmlFile = Join-Path $serviceDir 'LdaGraph.xml'; $tenantsFile = Join-Path $RuntimeRoot 'tenants.json'; $wrapperLogs = Join-Path $serviceDir 'logs'
New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
[IO.File]::WriteAllText($wrapper, 'Test fixture, not WinSW', $utf8)
$Command = 'install'; $actions.Clear(); $importOutput = Invoke-CommandBody | Out-String
Check ($actions.IndexOf('dacl-root') -lt $actions.IndexOf('import-write') -and $actions.IndexOf('dacl-service') -lt $actions.IndexOf('import-write')) 'Imported files precede restricted DACLs'
Check ($importOutput.Contains('Imported tenants.json')) 'Missing import notice'
Check ([IO.File]::ReadAllText($tenantsFile) -eq $original) 'Import changed credentials'
Check ([IO.File]::ReadAllText((Join-Path $RuntimeRoot 'data\default\store.ndjson')) -eq 'stored document') 'Import lost store'
Check ([IO.File]::ReadAllText((Join-Path $RuntimeRoot 'logs\default\requests.ndjson')) -eq 'request log') 'Import lost log'
# Use another destination without a tenants file but with existing content.
$RuntimeRoot = Join-Path $sandbox 'conflict'; $tenantsFile = Join-Path $RuntimeRoot 'tenants.json'
New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot 'data') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $RuntimeRoot 'data\keep.txt'), 'keep me', $utf8)
$refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('not empty') }
Check $refused 'Import overwrote an existing data destination'
Check (!(Test-Path -LiteralPath $tenantsFile)) 'Refused import created tenants file'
Check ([IO.File]::ReadAllText((Join-Path $RuntimeRoot 'data\keep.txt')) -eq 'keep me') 'Refused import damaged data'

# A runtime root under missing parents: every created folder must have a trusted owner.
$baseRoot = $RuntimeRoot
$RuntimeRoot = Join-Path $baseRoot 'untrusted-parent\runtime'
$serviceDir = Join-Path $RuntimeRoot 'service'; $wrapper = Join-Path $serviceDir 'fake-wrapper.txt'
$xmlFile = Join-Path $serviceDir 'LdaGraph.xml'; $tenantsFile = Join-Path $RuntimeRoot 'tenants.json'; $wrapperLogs = Join-Path $serviceDir 'logs'
$ImportFrom = ''; $actions.Clear(); $ownerOverrides[(Join-Path $baseRoot 'untrusted-parent')] = 'S-1-5-19'; $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith('Refusing to use ' + (Join-Path $baseRoot 'untrusted-parent') + ': owned by') }
Check $refused 'Created parent folder with an untrusted owner was accepted'
Check (!(Test-Path -LiteralPath $tenantsFile) -and !$actions.Contains('dacl-root') -and !(Test-Path -LiteralPath $serviceDir)) 'Untrusted parent refusal changed runtime/service'
$ownerOverrides.Clear()

# Downloads use fixture bytes only, without executing any wrapper or making network calls.
# The download runtime also sits under a missing parent, which a trusted owner allows.
$RuntimeRoot = Join-Path $baseRoot 'new-parent\download'
$serviceDir = Join-Path $RuntimeRoot 'service'; $wrapper = Join-Path $serviceDir 'fake-wrapper.txt'
$xmlFile = Join-Path $serviceDir 'LdaGraph.xml'; $tenantsFile = Join-Path $RuntimeRoot 'tenants.json'; $wrapperLogs = Join-Path $serviceDir 'logs'
$ImportFrom = ''; $downloadContent = 'wrong download'; $actions.Clear()
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile)
    Check ($Uri -eq $wrapperUrl -and $OutFile -eq ($wrapper + '.download')) 'Incorrect wrapper download destination'
    [IO.File]::WriteAllText($OutFile, $script:downloadContent, $utf8)
}
$refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('WinSW download hash mismatch: expected') -and $_.Exception.Message.Contains('Nothing installed.') }
Check $refused 'Download hash mismatch was accepted'
Check (!(Test-Path -LiteralPath $wrapper) -and !(Test-Path -LiteralPath ($wrapper + '.download'))) 'Rejected download was retained'
Check (!(Test-Path -LiteralPath $xmlFile) -and !$actions.Contains('stop') -and !$actions.Contains('wrapper-install')) 'Rejected download changed service/XML'
$downloadContent = 'Test fixture, not WinSW'; $actions.Clear()
Invoke-CommandBody | Out-Null
Check ([IO.File]::ReadAllText($wrapper) -eq $downloadContent) 'Verified download was not promoted'
Check ($actions.Contains('wrapper-install') -and $actions.Contains('health')) 'Verified download did not complete mock install'
# Every existing ancestor is checked, not only the folders install creates.
function Use-Runtime([string]$Path) {
    $script:RuntimeRoot = $Path
    $script:serviceDir = Join-Path $Path 'service'; $script:wrapper = Join-Path $script:serviceDir 'fake-wrapper.txt'
    $script:xmlFile = Join-Path $script:serviceDir 'LdaGraph.xml'; $script:tenantsFile = Join-Path $Path 'tenants.json'; $script:wrapperLogs = Join-Path $script:serviceDir 'logs'
}
$fixHint = '. Remove or fix this folder as an administrator and try again.'
# A non-admin user pre-created and owns a parent; its existing children look trusted.
$preowned = Join-Path $baseRoot 'preowned'
New-Item -ItemType Directory -Path (Join-Path $preowned 'child') -Force | Out-Null
Use-Runtime (Join-Path $preowned 'child\runtime')
$ownerOverrides[$preowned] = 'S-1-5-32-545'; $actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use ${preowned}: owned by") -and $_.Exception.Message.EndsWith($fixHint) }
Check $refused 'Untrusted existing parent with trusted children was accepted'
Check ($actions.Count -eq 0 -and !(Test-Path -LiteralPath $RuntimeRoot)) 'Untrusted existing parent refusal created the runtime'
$ownerOverrides.Clear()
# A junction anywhere in the chain is refused, even with trusted owners.
$junctionTarget = Join-Path $baseRoot 'junction-target'
$junction = Join-Path $baseRoot 'junction'
New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
New-Item -ItemType Junction -Path $junction -Target $junctionTarget | Out-Null
Use-Runtime (Join-Path $junction 'runtime')
$actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message -eq "Refusing to use ${junction}: it is a junction or symbolic link$fixHint" }
Check $refused 'Junction parent was accepted'
Check ($actions.Count -eq 0 -and !(Test-Path -LiteralPath $RuntimeRoot)) 'Junction refusal created the runtime'
Use-Runtime $junction
$refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.Contains('it is a junction or symbolic link') }
Check $refused 'Junction runtime root was accepted'
Check ($actions.Count -eq 0 -and @(Get-ChildItem -LiteralPath $junctionTarget -Force).Count -eq 0) 'Junction runtime refusal wrote through the link'
[IO.Directory]::Delete($junction)
# Application folders below ProgramData must not be writable by non-admin principals.
$savedProgramData = $env:ProgramData
try {
    $env:ProgramData = Join-Path $baseRoot 'ProgramData'
    $company = Join-Path $env:ProgramData 'Coding Koala'
    New-Item -ItemType Directory -Path $company -Force | Out-Null
    Use-Runtime (Join-Path $company 'Local Developer Accelerator\Runtime')
    # A system parent itself is accepted only with a system owner, never the current user.
    $ownerOverrides[$env:ProgramData] = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $actions.Clear(); $refused = $false
    try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use $($env:ProgramData): owned by") }
    Check $refused 'Current-user-owned ProgramData was accepted'
    $ownerOverrides.Clear()
    $writable = New-Object Security.AccessControl.DirectorySecurity
    $writable.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $writable.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-11')), 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    $mockAcls[$company] = $writable
    $actions.Clear(); $refused = $false
    try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use ${company}: ") -and $_.Exception.Message.Contains('can write to it') }
    Check $refused 'Writable application folder below ProgramData was accepted'
    Check ($actions.Count -eq 0 -and !(Test-Path -LiteralPath $RuntimeRoot)) 'Writable application folder refusal created the runtime'
    # Trusted chain: Users may read; install creates the rest and locks down the created application folder.
    $readable = New-Object Security.AccessControl.DirectorySecurity
    $readable.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')))
    $readable.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')), 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    $mockAcls[$company] = $readable
    $actions.Clear()
    Invoke-CommandBody | Out-Null
    $product = Join-Path $company 'Local Developer Accelerator'
    Check ($actions.Contains('wrapper-install') -and $actions.Contains('health') -and (Test-Path -LiteralPath $tenantsFile)) 'Trusted chain was not accepted'
    Check ($mockAcls.ContainsKey($product) -and $mockAcls[$product].AreAccessRulesProtected) 'Created application folder kept inherited permissions'
    Check (@($mockAcls[$product].GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' -and ([int]$_.FileSystemRights -band [int][Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, ChangePermissions, TakeOwnership') }).Count -eq 0) 'Created application folder grants Users more than Read/Execute'
    # A custom runtime whose existing parent is owned by Administrators (e.g. D:\OptimizelyLocal\Graph) is accepted.
    $custom = Join-Path $baseRoot 'DevRuntimes'
    New-Item -ItemType Directory -Path $custom -Force | Out-Null
    $ownerOverrides[$custom] = 'S-1-5-32-544'
    Use-Runtime (Join-Path $custom 'Graph'); $actions.Clear()
    Invoke-CommandBody | Out-Null
    Check ($actions.Contains('wrapper-install') -and (Test-Path -LiteralPath $tenantsFile)) 'Custom runtime under an Administrators-owned parent was refused'
    $ownerOverrides.Clear()
} finally { $env:ProgramData = $savedProgramData }

# Missing folders are created top-down, each with a restrictive DACL in the create call.
$installed = $null
Use-Runtime (Join-Path $baseRoot 'fresh-a\fresh-b\runtime'); $secureDirectories.Clear(); $actions.Clear()
$Command = 'install'; Invoke-CommandBody | Out-Null
$expectedCreated = @((Join-Path $baseRoot 'fresh-a'), (Join-Path $baseRoot 'fresh-a\fresh-b'), $RuntimeRoot, (Join-Path $RuntimeRoot 'data'), (Join-Path $RuntimeRoot 'logs'), $serviceDir, $wrapperLogs)
Check (($secureDirectories -join '|') -eq ($expectedCreated -join '|')) 'Missing folders were not all created top-down with a restrictive DACL'
foreach ($parent in $expectedCreated[0..1]) {
    $rules = @($mockAcls[$parent].GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    Check ($mockAcls[$parent].AreAccessRulesProtected -and $rules.Count -eq 4) "Created parent $parent kept inherited permissions"
    Check (@($rules | Where-Object { $_.IdentityReference.Value -in @('S-1-5-19', 'S-1-5-32-545') -and $_.FileSystemRights -ne 'ReadAndExecute, Synchronize' }).Count -eq 0) "Created parent $parent grants Users/LocalService more than Read/Execute"
}
# The real helper passes the DACL to CreateDirectory (checked on a throwaway folder; an empty folder can still be removed via its parent).
$realHelper = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-RestrictedDirectory' }, $false)
. ([ScriptBlock]::Create($realHelper.Extent.Text.Replace('function New-RestrictedDirectory', 'function New-RealRestrictedDirectory')))
$probe = Join-Path $baseRoot 'real-restricted'
New-RealRestrictedDirectory $probe -Service
try {
    $probeAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $probe
    $probeSids = @($probeAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) | Sort-Object
    Check ($probeAcl.AreAccessRulesProtected -and (($probeSids -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544,S-1-5-32-545')) 'Real restricted folder was created with inherited or extra permissions'
} finally {
    # As owner, regain access first: the parent may not grant delete-child (e.g. a test folder inside the repository).
    $access = New-Object Security.AccessControl.DirectorySecurity
    $access.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
    [IO.Directory]::SetAccessControl($probe, $access)
    [IO.Directory]::Delete($probe)
}

# Write access for anyone but SYSTEM, Administrators, TrustedInstaller or inherit-only CREATOR OWNER
# (LocalService only where the service writes) is refused before every elevated command changes anything.
function New-MockAcl([string]$OwnerSid, [hashtable[]]$Grants = @()) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($OwnerSid)))
    foreach ($grant in $Grants) {
        $propagation = 'None'; if ($grant.ContainsKey('Propagation')) { $propagation = $grant.Propagation }
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($grant.Sid)), [Security.AccessControl.FileSystemRights]$grant.Rights, 'ContainerInherit, ObjectInherit', $propagation, 'Allow')))
    }
    return $acl
}
function Test-Refused([string]$Prefix, [string]$Contains, [string]$Message) {
    $script:actions.Clear(); $refused = $false
    try { Invoke-CommandBody | Out-Null } catch { $text = $_.Exception.Message; $refused = $text.StartsWith($Prefix) -and $text.Contains($Contains) }
    Check $refused $Message
    Check ($script:actions.Count -eq 0) "$Message (service or permissions changed)"
}
$otherUser = 'S-1-5-21-1000000000-2000000000-3000000000-1001'
$rightsParent = Join-Path $baseRoot 'rights'
New-Item -ItemType Directory -Path (Join-Path $rightsParent 'runtime\service') -Force | Out-Null
Use-Runtime (Join-Path $rightsParent 'runtime')
$mockAcls[$rightsParent] = New-MockAcl 'S-1-5-32-544' @(@{Sid = $otherUser; Rights = 'AppendData'})
foreach ($elevatedCommand in @('install', 'uninstall', 'start', 'stop', 'restart')) {
    $Command = $elevatedCommand
    Test-Refused "Refusing to use ${rightsParent}: $otherUser can write to it" $fixHint "Another user's write access on a parent was accepted by $elevatedCommand"
}
$Command = 'install'
foreach ($rights in @('WriteAttributes', 'WriteExtendedAttributes', 'Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership')) {
    $mockAcls[$rightsParent] = New-MockAcl 'S-1-5-32-544' @(@{Sid = $otherUser; Rights = $rights})
    Test-Refused "Refusing to use ${rightsParent}: $otherUser can write to it" $fixHint "Parent right $rights was not treated as write access"
}
# GENERIC_WRITE and GENERIC_ALL (raw masks the .NET rule constructor rejects) via SDDL.
foreach ($generic in @('GW', 'GA')) {
    $genericAcl = New-Object Security.AccessControl.DirectorySecurity
    $genericAcl.SetSecurityDescriptorSddlForm("O:BAD:(A;OICI;$generic;;;$otherUser)")
    $mockAcls[$rightsParent] = $genericAcl
    Test-Refused "Refusing to use ${rightsParent}: $otherUser can write to it" $fixHint "Parent right $generic was not treated as write access"
}
$mockAcls[$rightsParent] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-5-19'; Rights = 'Modify'})
Test-Refused "Refusing to use ${rightsParent}: " 'can write to it' 'LocalService write access on a parent was accepted'
$mockAcls[$rightsParent] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-3-0'; Rights = 'FullControl'})
Test-Refused "Refusing to use ${rightsParent}: " 'can write to it' 'CREATOR OWNER write access that applies to the folder itself was accepted'
$mockAcls[$rightsParent] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-1-0'; Rights = 'ReadAndExecute'}, @{Sid = 'S-1-3-0'; Rights = 'FullControl'; Propagation = 'InheritOnly'})
$mockAcls[$RuntimeRoot] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-1-0'; Rights = 'Modify'})
Test-Refused "Refusing to use ${RuntimeRoot}: " 'can write to it' 'Everyone write access on the runtime root was accepted'
$mockAcls[$RuntimeRoot] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-5-19'; Rights = 'Modify'})
$mockAcls[$serviceDir] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-5-19'; Rights = 'Write'})
foreach ($elevatedCommand in @('install', 'start')) {
    $Command = $elevatedCommand
    Test-Refused "Refusing to use ${serviceDir}: " 'can write to it' "LocalService write access on service\ was accepted by $elevatedCommand"
}
# Read-only principals, inherit-only CREATOR OWNER and LocalService Modify on the runtime root are accepted.
$mockAcls.Remove($serviceDir); $Command = 'install'; $actions.Clear()
Invoke-CommandBody | Out-Null
Check ($actions.Contains('wrapper-install') -and (Test-Path -LiteralPath $tenantsFile)) 'Trusted rights on the chain were refused'
# Descendants are checked right before use: a writable data folder blocks start and, when it survives
# the permission reset, install before any credentials are written.
$data = Join-Path $RuntimeRoot 'data'
$mockAcls[$data] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-5-32-545'; Rights = 'Modify'})
$Command = 'start'
Test-Refused "Refusing to use ${data}: " 'can write to it' 'Start accepted a data folder writable by Users'
Use-Runtime (Join-Path $rightsParent 'second'); $data = Join-Path $RuntimeRoot 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$mockAcls[$data] = New-MockAcl 'S-1-5-32-544' @(@{Sid = 'S-1-5-32-545'; Rights = 'Modify'})
$Command = 'install'; $actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use ${data}: ") -and $_.Exception.Message.Contains('can write to it') }
Check $refused 'Install used a data folder that stayed writable after the permission reset'
Check (!(Test-Path -LiteralPath $tenantsFile) -and !$actions.Contains('wrapper-install')) 'Writable data folder refusal wrote credentials or installed the service'
$mockAcls[$data] = New-MockAcl $otherUser
$actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message.StartsWith("Refusing to use ${data}: owned by") }
Check ($refused -and !$actions.Contains('acl')) 'Data folder with an untrusted owner was not refused before the permission reset'
$mockAcls.Remove($data)
[IO.Directory]::Delete($data)
$dataTarget = Join-Path $baseRoot 'data-target'
New-Item -ItemType Directory -Path $dataTarget -Force | Out-Null
New-Item -ItemType Junction -Path $data -Target $dataTarget | Out-Null
$actions.Clear(); $refused = $false
try { Invoke-CommandBody | Out-Null } catch { $refused = $_.Exception.Message -eq "Refusing to use ${data}: it is a junction or symbolic link$fixHint" }
Check ($refused -and !$actions.Contains('acl') -and !(Test-Path -LiteralPath $tenantsFile)) 'Data junction was not refused before use'
Check (@(Get-ChildItem -LiteralPath $dataTarget -Force).Count -eq 0) 'Data junction refusal wrote through the link'
[IO.Directory]::Delete($data)

# Node.js must sit in a folder chain only administrators can change before it is run elevated or written into the XML.
Use-Runtime (Join-Path $baseRoot 'node-check'); $Command = 'install'
$userProfile = Join-Path $baseRoot 'Users\dev'
$nodeDir = Join-Path $userProfile 'AppData\Roaming\nvm\v24'
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
$fakeNode = Join-Path $nodeDir 'node.exe'
[IO.File]::WriteAllText($fakeNode, 'not node', $utf8)
function Get-NodePath { return $script:fakeNode }
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mockAcls[$userProfile] = New-MockAcl 'S-1-5-18' @(@{Sid = $currentUser; Rights = 'FullControl'})
Test-Refused "Refusing to use ${userProfile}: " 'must be installed system-wide' 'Node.js in a user-writable profile folder was accepted'
Check (!(Test-Path -LiteralPath $xmlFile) -and !(Test-Path -LiteralPath $RuntimeRoot)) 'Node.js refusal wrote the service XML or runtime'
$mockAcls.Remove($userProfile)
$ownerOverrides[$fakeNode] = $currentUser
Test-Refused "Refusing to use ${fakeNode}: owned by" 'must be installed system-wide' 'Node.js owned by the current user was accepted'
$ownerOverrides.Clear()
$nodeLink = Join-Path $baseRoot 'nodejs-link'
New-Item -ItemType Junction -Path $nodeLink -Target $nodeDir | Out-Null
$fakeNode = Join-Path $nodeLink 'node.exe'
Test-Refused "Refusing to use ${nodeLink}: it is a junction or symbolic link" 'must be installed system-wide' 'Node.js behind a junction (nvm-style) was accepted'
[IO.Directory]::Delete($nodeLink)
Write-Output 'PASS: mocked install, reinstallation, import, conflict, start/stop/restart/uninstall, wrong-runtime protection, folder-chain rights, restricted folder creation and Node.js location'
