[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('plan', 'install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs')]
    [string]$Command = 'status',
    [ValidateRange(1, 65535)][int]$Port = 8082,
    [ValidateRange(1024, 65536)][int]$MaxMemoryMB = 8192,
    [string]$RuntimeRoot = 'C:\ProgramData\Coding Koala\Local Developer Accelerator\Graph',
    [string]$ImportFrom,
    [switch]$RemoveData,
    # Internal: returns all output and the exit code to the unelevated window.
    [string]$ResultFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$portExplicit = $PSBoundParameters.ContainsKey('Port')
$maxMemoryExplicit = $PSBoundParameters.ContainsKey('MaxMemoryMB')
$serviceId = 'LdaGraph'
# Service id used by installs before the LDA rename; status points those users to the upgrade steps.
$legacyServiceId = 'OptimizelyGraphLocal'
$wrapperUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$wrapperSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$PSBoundParameters.ContainsKey('RuntimeRoot')) {
    # No -RuntimeRoot given: follow an installed service to its runtime (e.g. after moving it to another drive).
    $installedService = Get-CimInstance Win32_Service -Filter "Name='$serviceId'" -ErrorAction SilentlyContinue
    if ($installedService) {
        $installedExe = $installedService.PathName.Trim('"')
        if ($installedService.PathName -match '^"([^"]+)"') { $installedExe = $Matches[1] }
        $RuntimeRoot = Split-Path (Split-Path $installedExe -Parent) -Parent
    }
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$serviceDir = Join-Path $RuntimeRoot 'service'
$wrapper = Join-Path $serviceDir "$serviceId.exe"
$xmlFile = Join-Path $serviceDir "$serviceId.xml"
$tenantsFile = Join-Path $RuntimeRoot 'tenants.json'
$wrapperLogs = Join-Path $serviceDir 'logs'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if ($ImportFrom) { $ImportFrom = [IO.Path]::GetFullPath($ImportFrom) }

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-PS([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

function Invoke-Elevated {
    $resultPath = Join-Path ([IO.Path]::GetTempPath()) ("graph-service-result-" + [Guid]::NewGuid().ToString('N') + '.json')
    $call = '& ' + (Quote-PS $PSCommandPath) + ' ' + (Quote-PS $Command) + ' -RuntimeRoot ' + (Quote-PS $RuntimeRoot)
    if ($portExplicit) { $call += ' -Port ' + $Port }
    if ($maxMemoryExplicit) { $call += ' -MaxMemoryMB ' + $MaxMemoryMB }
    if ($ImportFrom) { $call += ' -ImportFrom ' + (Quote-PS $ImportFrom) }
    if ($RemoveData) { $call += ' -RemoveData' }
    $call += ' -ResultFile ' + (Quote-PS $resultPath)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($call))
    try {
        Write-Host 'Administrator access is required. Opening the Windows UAC prompt.'
        $child = Start-Process -FilePath (Get-SystemTool 'WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
        if (!(Test-Path -LiteralPath $resultPath)) { throw "Elevated process exited with code $($child.ExitCode) without a result file." }
        $result = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
        foreach ($line in $result.output) { Write-Output $line }
        return [int]$result.exitCode
    } finally {
        if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
    }
}

function Get-GraphService { return Get-CimInstance Win32_Service -Filter "Name='$serviceId'" }

function Get-LegacyService { return Get-CimInstance Win32_Service -Filter "Name='$legacyServiceId'" -ErrorAction SilentlyContinue }

function Get-WrapperHash([string]$Path = $wrapper) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Assert-WrapperHash {
    $actual = Get-WrapperHash
    if ($actual -ne $wrapperSha256) {
        throw "Existing wrapper $wrapper does not match the pinned SHA-256 (expected $wrapperSha256, got $actual). Delete it and run install again."
    }
}

function Assert-ImportDestination {
    if ($ImportFrom -and (Test-Path -LiteralPath $tenantsFile)) {
        throw "tenants.json already exists at $tenantsFile; -ImportFrom was not applied. Uninstall with -RemoveData or move the existing runtime first."
    }
}

function Test-ReparsePoint([string]$Path) {
    return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-SystemTool([string]$Name) {
    # External tools always run from the Windows system folder, never from PATH or the current folder.
    return Join-Path ([Environment]::SystemDirectory) $Name
}

function Get-SystemParentFolders {
    # Well-known system folders that may hold the runtime; accepted only when owned by SYSTEM, Administrators or TrustedInstaller.
    return @(@($env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
}

function Get-UntrustedReason([string]$Path, [switch]$SystemParent, [switch]$StrictOwner, [switch]$SkipRights, [switch]$AllowLocalServiceWrite) {
    # Owners: SYSTEM, Administrators, TrustedInstaller; the current elevated user too, except for system parents and -StrictOwner.
    $system = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $owners = $system
    if (!$SystemParent -and !$StrictOwner) { $owners += [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    if (!$SystemParent -and (Test-ReparsePoint $Path)) { return 'it is a junction or symbolic link' }
    $acl = Get-Acl -LiteralPath $Path
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin $owners) {
        $ownerName = $ownerSid
        try { $ownerName = $acl.Owner } catch { $ownerName = $ownerSid }
        return "owned by $ownerName"
    }
    if ($SystemParent -or $SkipRights) { return $null }
    # Only SYSTEM, Administrators, TrustedInstaller and inherit-only CREATOR OWNER may change it;
    # LocalService only where the service writes (runtime root, data, logs, service logs).
    $writeRights = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership') -bor 0x10000000 -bor 0x40000000
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ([string]$rule.AccessControlType -ne 'Allow' -or !([int]$rule.FileSystemRights -band $writeRights)) { continue }
        $sid = $rule.IdentityReference.Value
        if ($sid -in $system) { continue }
        if ($sid -eq 'S-1-3-0' -and ([int]$rule.PropagationFlags -band [int][Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        if ($sid -eq 'S-1-5-19' -and $AllowLocalServiceWrite) { continue }
        $principal = $sid
        try { $principal = $rule.IdentityReference.Translate([Security.Principal.NTAccount]).Value } catch { $principal = $sid }
        return "$principal can write to it"
    }
    return $null
}

function Assert-TrustedFolder([string]$Path, [switch]$SystemParent, [switch]$SkipRights, [switch]$AllowLocalServiceWrite) {
    $reason = Get-UntrustedReason $Path -SystemParent:$SystemParent -SkipRights:$SkipRights -AllowLocalServiceWrite:$AllowLocalServiceWrite
    if ($reason) { throw "Refusing to use ${Path}: $reason. Remove or fix this folder as an administrator and try again." }
}

function Get-PathAncestors([string]$Path) {
    # Every folder between the volume root (excluded) and the path (excluded), top first.
    $volumeRoot = [IO.Path]::GetPathRoot($Path).TrimEnd('\')
    $folders = New-Object 'System.Collections.Generic.List[string]'
    $cursor = Split-Path $Path.TrimEnd('\') -Parent
    while ($cursor -and $cursor.TrimEnd('\') -ne $volumeRoot) { $folders.Insert(0, $cursor.TrimEnd('\')); $cursor = Split-Path $cursor -Parent }
    return $folders.ToArray()
}

function Assert-RuntimeChain {
    # Walk every existing ancestor from the top down, then the runtime root and service\: no junctions,
    # trusted owners, and write access only for SYSTEM, Administrators, TrustedInstaller and
    # inherit-only CREATOR OWNER (LocalService also on the runtime root).
    $systemParents = @(Get-SystemParentFolders)
    $root = $RuntimeRoot.TrimEnd('\')
    foreach ($folder in @(Get-PathAncestors $root) + @($root, $serviceDir)) {
        if (!(Test-Path -LiteralPath $folder)) { continue }
        if ($systemParents -contains $folder) { Assert-TrustedFolder $folder -SystemParent; continue }
        Assert-TrustedFolder $folder -AllowLocalServiceWrite:($folder -eq $root)
    }
}

function Assert-RuntimeDescendants([switch]$SkipRights) {
    # Checked right before use. LocalService may write only to data, logs and service\logs.
    $data = Join-Path $RuntimeRoot 'data'
    $logs = Join-Path $RuntimeRoot 'logs'
    foreach ($folder in @($serviceDir, $data, $logs, $wrapperLogs)) {
        if (!(Test-Path -LiteralPath $folder)) { continue }
        Assert-TrustedFolder $folder -SkipRights:$SkipRights -AllowLocalServiceWrite:($folder -in @($data, $logs, $wrapperLogs))
    }
}

function Get-NodePath { return @(Get-Command node -CommandType Application)[0].Source }

function Assert-TrustedNode([string]$Path) {
    # Install runs Node elevated and the service runs it as LocalService: only administrators may be able to change it.
    $systemParents = @(Get-SystemParentFolders)
    foreach ($item in @(Get-PathAncestors $Path) + @($Path)) {
        if ($systemParents -contains $item) { $reason = Get-UntrustedReason $item -SystemParent }
        else { $reason = Get-UntrustedReason $item -StrictOwner }
        if ($reason) {
            throw "Refusing to use ${item}: $reason. Node.js ($Path) must be installed system-wide where only administrators can change it, for example with the official installer into C:\Program Files\nodejs; per-user installs such as nvm or a folder under AppData cannot run a service."
        }
    }
}

function New-RuntimeRoot {
    # Check the existing chain, create each missing folder top-down with a restrictive DACL
    # (so it never exists with inherited permissions), then check the whole chain again.
    Assert-RuntimeChain
    $root = $RuntimeRoot.TrimEnd('\')
    $missing = New-Object 'System.Collections.Generic.List[string]'
    $cursor = $root
    while ($cursor -and !(Test-Path -LiteralPath $cursor)) { $missing.Insert(0, $cursor.TrimEnd('\')); $cursor = Split-Path $cursor -Parent }
    # Parents: SYSTEM/Administrators Full, Users/LocalService Read/Execute. Root: LocalService Modify.
    foreach ($folder in $missing) { New-RestrictedDirectory $folder -Service:($folder -ne $root) }
    Assert-RuntimeChain
}

function Assert-SelectedRuntime {
    $installed = Get-GraphService
    if (!$installed) { return }
    $serviceExecutable = $installed.PathName.Trim('"')
    if ($installed.PathName -match '^"([^"]+)"') { $serviceExecutable = $Matches[1] }
    if ([IO.Path]::GetFullPath($serviceExecutable) -ne $wrapper) {
        throw "Service $serviceId belongs to another runtime: $($installed.PathName). Use its -RuntimeRoot."
    }
}

function Get-PortListeners {
    # Get-NetTCPConnection returns an error when there are no matching listeners.
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-OwnedProcess([int]$ProcessId, [int]$ServiceProcessId) {
    if ($ServiceProcessId -le 0) { return $false }
    $seen = @{}
    while ($ProcessId -gt 0 -and !$seen.ContainsKey($ProcessId)) {
        if ($ProcessId -eq $ServiceProcessId) { return $true }
        $seen[$ProcessId] = $true
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (!$processInfo) { break }
        $ProcessId = [int]$processInfo.ParentProcessId
    }
    return $false
}

function Assert-PortAvailable {
    $installed = Get-GraphService
    $ownerId = 0
    if ($installed) { $ownerId = [int]$installed.ProcessId }
    foreach ($listener in @(Get-PortListeners)) {
        if (!(Test-OwnedProcess ([int]$listener.OwningProcess) $ownerId)) {
            $processInfo = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            $name = 'unknown'
            if ($processInfo) { $name = $processInfo.ProcessName }
            throw "Port $Port is in use by PID $($listener.OwningProcess) ($name). Choose -Port <free-port> or stop that process yourself."
        }
    }
}

function Invoke-Wrapper([string]$Action) {
    if (!(Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw "Wrapper missing: $wrapper. Run install first (or use the matching -RuntimeRoot)." }
    Assert-WrapperHash
    & $wrapper $Action 2>&1 | ForEach-Object { Write-Output "$_" }
    if ($LASTEXITCODE -ne 0) { throw "WinSW $Action failed with exit code $LASTEXITCODE. See $wrapperLogs." }
}

function Set-ServiceConfiguration {
    # WinSW v2.12.0 has no refresh command. XML is read at each start; SCM
    # settings must be reapplied separately when reusing an installed service.
    $sc = Get-SystemTool 'sc.exe'
    & $sc config $serviceId start= delayed-auto obj= 'NT AUTHORITY\LocalService' DisplayName= 'Local Developer Accelerator — Graph (development only)' 2>&1 | ForEach-Object { Write-Output "$_" }
    if ($LASTEXITCODE -ne 0) { throw 'Could not update service startup/account settings.' }
    & $sc failure $serviceId reset= 3600 actions= restart/10000/restart/10000/restart/10000 2>&1 | ForEach-Object { Write-Output "$_" }
    if ($LASTEXITCODE -ne 0) { throw 'Could not update service restart settings.' }
}

function Stop-GraphService {
    $installed = Get-GraphService
    if ($installed -and $installed.State -ne 'Stopped') {
        Stop-Service -Name $serviceId
        (Get-Service -Name $serviceId).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}

function New-RestrictedDirectorySecurity([switch]$Service) {
    # Start with an empty DACL: /grant:r would retain unrelated explicit ACEs.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $grants = @{'S-1-5-18' = 'FullControl'; 'S-1-5-32-544' = 'FullControl'; 'S-1-5-19' = 'Modify'}
    if ($Service) { $grants['S-1-5-19'] = 'ReadAndExecute'; $grants['S-1-5-32-545'] = 'ReadAndExecute' }
    foreach ($sid in $grants.Keys) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $grants[$sid], 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Set-RestrictedDirectoryAcl([string]$Path, [switch]$Service) {
    Set-Acl -LiteralPath $Path -AclObject (New-RestrictedDirectorySecurity -Service:$Service)
}

function New-RestrictedDirectory([string]$Path, [switch]$Service) {
    # The DACL is part of the create call, so the folder never exists with inherited (possibly writable) permissions.
    $security = New-RestrictedDirectorySecurity -Service:$Service
    if ($PSVersionTable.PSVersion.Major -le 5) { [void][IO.Directory]::CreateDirectory($Path, $security) }
    else { [IO.FileSystemAclExtensions]::Create((New-Object IO.DirectoryInfo($Path)), $security) }  # PowerShell 7
}

function Grant-LocalServiceAccess([string]$Path, [string]$Rights, [switch]$File) {
    $acl = Get-Acl -LiteralPath $Path
    $identity = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
    $inheritance = 'ContainerInherit, ObjectInherit'
    if ($File) { $inheritance = 'None' }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $Rights, $inheritance, 'None', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-RuntimePermissions {
    Set-RestrictedDirectoryAcl $RuntimeRoot
    # Reset existing explicit child ACEs, then restore the service/log exceptions.
    & (Get-SystemTool 'icacls.exe') (Join-Path $RuntimeRoot '*') /reset /T /C 2>&1 | ForEach-Object { Write-Output "$_" }
    if ($LASTEXITCODE -ne 0) { throw 'Could not reset runtime files to inherited permissions.' }
    Set-RestrictedDirectoryAcl $serviceDir -Service
    Grant-LocalServiceAccess $wrapperLogs 'Modify'
}

function Invoke-Node([string]$Action, [string]$Options, [string]$NodePath = (Get-NodePath)) {
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = $utf8
        $Options | & $NodePath (Join-Path $PSScriptRoot 'service-xml.js') $Action
        if ($LASTEXITCODE -ne 0) { throw "Service Node command failed: $Action." }
    } finally { [Console]::OutputEncoding = $previousEncoding }
}

function Get-ConfiguredPort {
    if (Test-Path -LiteralPath $xmlFile -PathType Leaf) {
        [xml]$config = [IO.File]::ReadAllText($xmlFile)
        $setting = @($config.service.env | Where-Object { $_.name -eq 'PORT' })
        if ($setting.Count -eq 1) { return [int]$setting[0].value }
    }
    return $Port
}

function Select-InstallPort {
    if ($portExplicit) { return 'from -Port' }
    if (Test-Path -LiteralPath $xmlFile -PathType Leaf) {
        $script:Port = Get-ConfiguredPort
        return 'kept from existing config'
    }
    return 'default'
}

function Select-InstallMemory {
    if ($maxMemoryExplicit) { return 'from -MaxMemoryMB' }
    if (Test-Path -LiteralPath $xmlFile -PathType Leaf) {
        [xml]$config = [IO.File]::ReadAllText($xmlFile)
        if ([string]$config.service.arguments -match '(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)') {
            $configuredMemory = [long]$Matches[1]
            if ($configuredMemory -lt 1024 -or $configuredMemory -gt 65536) { throw 'Existing MaxMemoryMB must be from 1024 to 65536.' }
            $script:MaxMemoryMB = [int]$configuredMemory
            return 'kept from existing config'
        }
    }
    $script:MaxMemoryMB = 8192
    return 'default'
}

function Wait-Healthy {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $installed = Get-GraphService
                $listeners = @(Get-PortListeners)
                if ($installed -and $installed.State -eq 'Running' -and $listeners.Count -gt 0) {
                    foreach ($listener in $listeners) {
                        if (!(Test-OwnedProcess ([int]$listener.OwningProcess) ([int]$installed.ProcessId))) { throw 'Health response belongs to another process.' }
                    }
                    Write-Output "Dashboard: http://localhost:$Port/"
                    return
                }
            }
        } catch { # A refused connection is expected while the service starts.
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Service did not become healthy within 20 seconds at http://127.0.0.1:$Port/health. See $wrapperLogs and run the logs command."
}

function Get-Xml([string]$NodePath = (Get-NodePath)) {
    $options = @{nodePath = $NodePath; repoRoot = $repoRoot; runtimeRoot = $RuntimeRoot; port = $Port; maxMemoryMB = $MaxMemoryMB} | ConvertTo-Json -Compress
    $generated = Invoke-Node 'xml' $options $NodePath
    return ($generated -join [Environment]::NewLine)
}

function Show-Plan {
    # Deliberately returns before elevation, service/port inspection, mkdir or download.
    $portSource = Select-InstallPort
    $memorySource = Select-InstallMemory
    $generated = Get-Xml
    Write-Output 'PLAN ONLY: no files written, no download, no elevation, no service or port changes.'
    Write-Output "Runtime root: $RuntimeRoot"
    Write-Output "Create: $tenantsFile; $(Join-Path $RuntimeRoot 'data'); $(Join-Path $RuntimeRoot 'logs'); $serviceDir; $wrapperLogs"
    if ($ImportFrom) { Write-Output "Copy tenants.json + data + logs from: $ImportFrom; abort if tenants.json already exists or destination data/log content exists." }
    else { Write-Output 'If tenants.json is absent, generate one Default tenant using dashboard key/secret rules and print its CMS appsettings snippet.' }
    Write-Output "Check port $Port ($portSource); reject another process and show its PID/name."
    Write-Output "MaxMemoryMB: $MaxMemoryMB ($memorySource)"
    Write-Output "Download WinSW v2.12.0 x64 from $wrapperUrl to $wrapper only if absent; reuse otherwise."
    Write-Output "Pinned WinSW SHA-256: $wrapperSha256; a download or existing-wrapper mismatch aborts before service changes."
    Write-Output "Write: $xmlFile"
    Write-Output "Before every install, uninstall, start, stop and restart, check every existing folder from the drive root down to $RuntimeRoot and ${serviceDir}: refuse junctions/symbolic links, owners other than SYSTEM, Administrators, TrustedInstaller or the current elevated user (ProgramData/Program Files themselves: SYSTEM, Administrators or TrustedInstaller only, owner check only)."
    Write-Output "Refuse those folders when anyone other than SYSTEM, Administrators, TrustedInstaller or inherit-only CREATOR OWNER can write, delete, change permissions or take ownership; LocalService may write only to $RuntimeRoot, its data and logs folders and $wrapperLogs."
    Write-Output "Create missing folders top-down with a restrictive DACL from the start (created parents: SYSTEM/Administrators Full, Users/LocalService Read/Execute); check service, data, logs and service\logs again right before use."
    Write-Output "Refuse a Node.js executable whose file or parent folders are junctions/symbolic links, not owned by SYSTEM, Administrators or TrustedInstaller, or writable by anyone else (e.g. nvm or AppData installs); install Node.js system-wide."
    Write-Output "Run icacls.exe, sc.exe and the UAC powershell.exe only from $([Environment]::SystemDirectory)."
    Write-Output "Before writing credentials/data, replace the runtime DACL: only SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) Full; LocalService Modify (S-1-5-19) on $RuntimeRoot."
    Write-Output "LocalService and Users Read/Execute on $serviceDir (including wrapper/XML; no secrets) and LocalService on $repoRoot; Modify on $wrapperLogs and the single $serviceId.wrapper.log file beside the executable."
    Write-Output 'Install or reconfigure the existing service, start it, wait up to 20 seconds for HTTP 200 /health.'
    Write-Output "Dashboard: http://localhost:$Port/"
    Write-Output $generated
}

function Assert-SafeRemoval {
    $trimmedRoot = [IO.Path]::GetPathRoot($RuntimeRoot).TrimEnd('\')
    $target = $RuntimeRoot.TrimEnd('\')
    if ($target -eq $trimmedRoot) { throw 'Refusing to remove a drive root.' }
    if ($repoRoot -eq $target -or $repoRoot.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove the repository or a runtime inside the repository.'
    }
    if (!(Test-Path -LiteralPath $xmlFile -PathType Leaf)) { throw 'Refusing -RemoveData without the generated service XML in this runtime root.' }
    [xml]$config = [IO.File]::ReadAllText($xmlFile)
    if ($config.service.id -ne $serviceId) { throw 'Refusing -RemoveData: service XML id does not match.' }
    # Do not follow junctions/symlinks during recursive deletion.
    foreach ($entry in @((Get-Item -LiteralPath $RuntimeRoot)) + @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing -RemoveData on a runtime containing junctions or symbolic links.' }
    }
}

function Invoke-CommandBody {
    if ($Command -eq 'install') { Assert-ImportDestination }
    if ($Command -in @('install', 'uninstall', 'start', 'stop', 'restart')) {
        # Before the first write, permission change or program start of every elevated command.
        Assert-RuntimeChain
        if ($Command -in @('start', 'restart')) { Assert-RuntimeDescendants }
        Assert-SelectedRuntime
    }
    if ($Command -in @('install', 'uninstall', 'start', 'stop', 'restart') -and (Test-Path -LiteralPath $wrapper -PathType Leaf)) { Assert-WrapperHash }
    switch ($Command) {
        'plan' { Show-Plan }
        'install' {
            $portSource = Select-InstallPort
            $memorySource = Select-InstallMemory
            Write-Output "Install port: $Port ($portSource)"
            Write-Output "MaxMemoryMB: $MaxMemoryMB ($memorySource)"
            $nodePath = Get-NodePath
            Assert-TrustedNode $nodePath
            $generated = Get-Xml $nodePath
            Assert-PortAvailable
            $installed = Get-GraphService
            # Validate imports before creating or changing the destination.
            if ($ImportFrom) {
                $source = Join-Path $ImportFrom 'tenants.json'
                if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Import tenants.json is missing: $source" }
                foreach ($folder in @('data', 'logs')) {
                    $target = Join-Path $RuntimeRoot $folder
                    if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) { throw "Import destination is not empty: $target. No files were overwritten." }
                }
            }
            New-RuntimeRoot
            Set-RestrictedDirectoryAcl $RuntimeRoot
            foreach ($folder in @((Join-Path $RuntimeRoot 'data'), (Join-Path $RuntimeRoot 'logs'), $serviceDir, $wrapperLogs)) {
                if (!(Test-Path -LiteralPath $folder)) { New-RestrictedDirectory $folder -Service:($folder -in @($serviceDir, $wrapperLogs)) }
            }
            # No junctions or untrusted owners before resetting permissions; full rights check right after.
            Assert-RuntimeDescendants -SkipRights
            Set-RuntimePermissions
            Assert-RuntimeDescendants
            if (!(Test-Path -LiteralPath $tenantsFile)) {
                if ($ImportFrom) {
                    foreach ($folder in @('data', 'logs')) {
                        $from = Join-Path $ImportFrom $folder
                        $to = Join-Path $RuntimeRoot $folder
                        New-Item -ItemType Directory -Path $to -Force | Out-Null
                        if (Test-Path -LiteralPath $from -PathType Container) {
                            Get-ChildItem -LiteralPath $from -Force | Copy-Item -Destination $to -Recurse -Force
                        }
                    }
                    Copy-Item -LiteralPath $source -Destination $tenantsFile
                    Write-Output "Imported tenants.json, data and logs from $ImportFrom."
                } else {
                    $options = @{runtimeRoot = $RuntimeRoot; port = $Port} | ConvertTo-Json -Compress
                    $snippet = Invoke-Node 'init' $options $nodePath
                    Write-Output 'Default instance created. Copy these settings into CMS appsettings.Development.json:'
                    Write-Output $snippet
                }
            } else { Write-Output "Preserving existing tenants and runtime data: $RuntimeRoot" }
            if (!(Test-Path -LiteralPath $wrapper -PathType Leaf)) {
                [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                $download = $wrapper + '.download'
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri $wrapperUrl -OutFile $download
                    $actual = Get-WrapperHash $download
                    if ($actual -ne $wrapperSha256) {
                        Remove-Item -LiteralPath $download -Force
                        throw "WinSW download hash mismatch: expected $wrapperSha256, got $actual. Nothing installed."
                    }
                    Move-Item -LiteralPath $download -Destination $wrapper
                } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force } }
            } else { Write-Output "Reusing wrapper: $wrapper" }
            Write-Output "WinSW SHA-256: $(Get-WrapperHash)"
            Stop-GraphService
            [IO.File]::WriteAllText($xmlFile, $generated + [Environment]::NewLine, $utf8)
            Set-RuntimePermissions
            Assert-RuntimeDescendants
            # WinSW 2.12 uses logpath; also preserve write access to the legacy
            # beside-executable log without allowing wrapper/XML replacement.
            $ownLog = Join-Path $serviceDir "$serviceId.wrapper.log"
            if (!(Test-Path -LiteralPath $ownLog)) { [IO.File]::WriteAllText($ownLog, '', $utf8) }
            Grant-LocalServiceAccess $ownLog 'Modify' -File
            Grant-LocalServiceAccess $repoRoot 'ReadAndExecute'
            if ($installed) { Set-ServiceConfiguration } else { Invoke-Wrapper 'install' }
            Assert-PortAvailable
            Invoke-Wrapper 'start'
            Wait-Healthy
        }
        'uninstall' {
            if ($RemoveData) { Assert-SafeRemoval }
            Stop-GraphService
            if (Get-GraphService) { Invoke-Wrapper 'uninstall' } else { Write-Output 'Service is already uninstalled.' }
            if ($RemoveData) {
                # Resolve and re-validate the explicitly selected target immediately before deleting.
                $resolvedTarget = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath
                if ($resolvedTarget.TrimEnd('\') -ne $RuntimeRoot.TrimEnd('\')) { throw 'Runtime path resolution changed; refusing removal.' }
                Assert-SafeRemoval
                Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
                Write-Output "Removed runtime data: $resolvedTarget"
            } else { Write-Output "Runtime data retained: $RuntimeRoot" }
        }
        'start' { $script:Port = Get-ConfiguredPort; Assert-PortAvailable; Invoke-Wrapper 'start'; Wait-Healthy }
        'stop' { Stop-GraphService; Write-Output 'Service stopped.' }
        'restart' { $script:Port = Get-ConfiguredPort; Assert-PortAvailable; Stop-GraphService; Assert-PortAvailable; Invoke-Wrapper 'start'; Wait-Healthy }
        'status' {
            $script:Port = Get-ConfiguredPort
            $installed = Get-GraphService
            if ($installed) { Write-Output "Service: $($installed.State); PID: $($installed.ProcessId)" }
            else {
                Write-Output 'Service: not installed; PID: none'
                if (Get-LegacyService) { Write-Output ('Legacy service ' + $legacyServiceId + ' found ' + [char]0x2014 + ' run `lda adopt` or see README ''Upgrading from an older install''.') }
            }
            $listeners = @(Get-PortListeners)
            if ($listeners.Count -eq 0) { Write-Output "Port ${Port}: not listening" }
            foreach ($listener in $listeners) {
                $processInfo = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
                $name = 'unknown'; if ($processInfo) { $name = $processInfo.ProcessName }
                Write-Output "Port ${Port}: PID $($listener.OwningProcess) ($name)"
            }
            try {
                $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
                Write-Output "Health: HTTP $($health.StatusCode) $($health.Content)"
            } catch { Write-Output "Health unavailable: $($_.Exception.Message)" }
        }
        'logs' {
            $files = @(Get-ChildItem -LiteralPath $wrapperLogs -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @("$serviceId.wrapper.log", "$serviceId.out.log", "$serviceId.err.log") })
            # Also read beside-executable logs retained by earlier configurations.
            $ownLog = Join-Path $serviceDir "$serviceId.wrapper.log"
            if (Test-Path -LiteralPath $ownLog -PathType Leaf) { $files += Get-Item -LiteralPath $ownLog }
            if (!$files.Count) { Write-Output "No wrapper/server console logs yet. Look in $serviceDir and $wrapperLogs." }
            foreach ($file in $files | Sort-Object FullName -Unique) {
                Write-Output "--- $($file.FullName) (last 50 lines) ---"
                Get-Content -LiteralPath $file.FullName -Tail 50
            }
        }
    }
}

# UTF-8 stdin is needed when paths contain non-ASCII characters under PS 5.1.
$OutputEncoding = $utf8
$exitCode = 0
if ($Command -in @('install', 'uninstall', 'start', 'stop', 'restart') -and !$ResultFile -and !(Test-Elevated)) {
    try {
        if ($Command -eq 'install') { Assert-ImportDestination }
        # Invoke-Elevated streams output; its final item is the exit code.
        $elevationOutput = @(Invoke-Elevated)
        if ($elevationOutput.Count -gt 1) { $elevationOutput[0..($elevationOutput.Count - 2)] | Write-Output }
        $exitCode = [int]$elevationOutput[-1]
    } catch { Write-Output "ERROR: $($_.Exception.Message)"; $exitCode = 1 }
} else {
    $lines = @(& {
        try {
            if ($ResultFile -and !(Test-Elevated)) { throw 'Elevated service command requires administrator access.' }
            Invoke-CommandBody
        } catch { $script:exitCode = 1; Write-Output "ERROR: $($_.Exception.Message)" }
    } 2>&1 | ForEach-Object { "$_" })
    $lines | Write-Output
    if ($ResultFile) {
        [IO.File]::WriteAllText($ResultFile, (@{exitCode = $exitCode; output = $lines} | ConvertTo-Json -Depth 4), $utf8)
    }
}
exit $exitCode
