$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$endpoint=Read-Host 'Apps Script web app URL (https://script.google.com/macros/s/.../exec)'
$secure=Read-Host 'WAREHOUSE_SECRET (same secret as Apps Script properties, at least 32 characters)' -AsSecureString
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{$secret=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType Directory -Force -Path 'data' | Out-Null
& icacls.exe (Join-Path $PSScriptRoot 'data') /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect server configuration directory'}
@{endpoint=$endpoint;secret=$secret} | ConvertTo-Json -Compress | & node google-sheets/connect.mjs
$secret=$null
if($LASTEXITCODE -ne 0){throw 'Connection or migration incomplete. Read the message above before retrying.'}
