// Permission changes in scripts/service.ps1 must work again on a folder that is already locked (a re-run, an
// upgrade). Set-Acl also tried to write the audit section (SACL) there, which needs SeSecurityPrivilege; the script
// now writes only the sections it changed. Runs the real functions on folders the test user created. Works the same
// non-elevated (owner = the user) and elevated as an administrator, as on GitHub's windows-latest runner (new files are
// then owned by BUILTIN\Administrators): the owner is recorded before the calls and must be unchanged after them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hasPowerShell, runPowerShell, powershellEnv} from './powershell.js';

const script = resolve(import.meta.dirname, '..', 'scripts', 'service.ps1');
const pwsh = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe') : null;
const hosts = [['Windows PowerShell 5.1', args => runPowerShell(args)]];
if (pwsh && existsSync(pwsh)) hosts.push(['PowerShell 7', args => spawnSync(pwsh, args, {encoding: 'utf8', windowsHide: true, env: powershellEnv()})]);
const q = value => `'${String(value).replaceAll("'", "''")}'`;

for (const [name, run] of hosts) test(`service.ps1 permission functions work twice in a row on an already locked folder (${name})`, {skip: !hasPowerShell, timeout: 30000}, t => {
  const root = mkdtempSync(join(tmpdir(), 'service-acl-test-')), folder = join(root, 'runtime'), fileFolder = join(root, 'files'), file = join(fileFolder, 'own.log');
  mkdirSync(folder); mkdirSync(fileFolder); writeFileSync(file, '');
  t.after(() => {
    // The owner may always rewrite the DACL; give the test user its access back before deleting.
    runPowerShell(['-NoProfile', '-NonInteractive', '-Command', `icacls ${q(root)} /reset /T /C /Q | Out-Null`]);
    rmSync(root, {recursive: true, force: true});
  });
  const code = `$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile(${q(script)},[ref]$null,[ref]$null)
foreach($n in 'New-RestrictedDirectorySecurity','Set-ItemAccessControl','Set-RestrictedDirectoryAcl','Grant-LocalServiceAccess'){$fn=$ast.Find({param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n},$true); . ([scriptblock]::Create($fn.Extent.Text))}
$d=${q(folder)}; $f=${q(file)}
# Lock the file the way the script leaves its own log: protected, owner only.
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User
$owner={param($p) (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value}
# When the token allows it (elevated administrator), first give the folder and file an owner that differs from the
# default owner of new items, so a function that wrongly wrote an owner would be caught whatever the default is.
foreach($p in $d,$f){ foreach($sid in @($me.Value,'S-1-5-32-544') | Where-Object {$_ -ne (& $owner $p)}){ try{ $o=if((Get-Item -LiteralPath $p -Force) -is [IO.DirectoryInfo]){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}; $o.SetOwner((New-Object Security.Principal.SecurityIdentifier($sid))); Set-ItemAccessControl $p $o; break }catch{} } }
$dirOwnerBefore=& $owner $d; $fileOwnerBefore=& $owner $f
$fs=New-Object Security.AccessControl.FileSecurity; $fs.SetAccessRuleProtection($true,$false); $fs.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','Allow')))
Set-ItemAccessControl $f $fs; Set-ItemAccessControl $f $fs
foreach($i in 1,2){ Set-RestrictedDirectoryAcl $d }
foreach($i in 1,2){ Set-RestrictedDirectoryAcl $d -Service }
foreach($i in 1,2){ Grant-LocalServiceAccess $d 'Modify' }
foreach($i in 1,2){ Grant-LocalServiceAccess $f 'Modify' -File }
$da=Get-Acl -LiteralPath $d; $fa=Get-Acl -LiteralPath $f
$ls={param($a) @($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-19'}) | ForEach-Object {[string]$_.FileSystemRights}}
@{dirProtected=$da.AreAccessRulesProtected; dirOwner=$da.GetOwner([Security.Principal.SecurityIdentifier]).Value; dirOwnerBefore=$dirOwnerBefore; fileOwner=$fa.GetOwner([Security.Principal.SecurityIdentifier]).Value; fileOwnerBefore=$fileOwnerBefore; dirLocalService=@(& $ls $da); dirSids=@($da.Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value} | Sort-Object -Unique); fileProtected=$fa.AreAccessRulesProtected; fileLocalService=@(& $ls $fa); me=$me.Value} | ConvertTo-Json -Compress`;
  const r = run(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.dirProtected, true); assert.equal(out.dirOwner, out.dirOwnerBefore, 'folder owner unchanged (only the DACL is written)');
  assert.equal(out.fileOwner, out.fileOwnerBefore, 'file owner unchanged (only the DACL is written)');
  assert.deepEqual(out.dirSids, ['S-1-5-18', 'S-1-5-19', 'S-1-5-32-544', 'S-1-5-32-545']);
  assert.ok(out.dirLocalService.length === 1 && /Modify/.test(out.dirLocalService[0]), JSON.stringify(out.dirLocalService));
  assert.equal(out.fileProtected, true); assert.ok(out.fileLocalService.length === 1 && /Modify/.test(out.fileLocalService[0]), JSON.stringify(out.fileLocalService));
});
