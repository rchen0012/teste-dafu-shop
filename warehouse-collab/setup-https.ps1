param([Parameter(Mandatory=$true)][string]$WarehouseIP)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$parsedIP = $null
if (-not [System.Net.IPAddress]::TryParse($WarehouseIP, [ref]$parsedIP) -or $parsedIP.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'Enter the warehouse PC IPv4 address, for example 192.168.1.100' }
if (Test-Path -LiteralPath 'certs/https.json') { throw 'HTTPS already configured. Keep existing certs. If the PC IP changed, read README before replacing certificates.' }
New-Item -ItemType Directory -Force -Path 'certs' | Out-Null
# Certificates are created in CurrentUser, so no administrator is required here.
# Only public root certificate is distributed to phones. Never share the PFX.
$root = New-SelfSignedCertificate -Type Custom -Subject 'CN=Warehouse Local Root' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(5) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
$leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=Warehouse Box Counter' -Signer $root -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(365) -TextExtension @("2.5.29.17={text}IPAddress=$WarehouseIP&DNS=localhost&IPAddress=127.0.0.1",'2.5.29.37={text}1.3.6.1.5.5.7.3.1','2.5.29.19={critical}{text}ca=0')
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$password = [Convert]::ToBase64String($bytes)
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
Export-PfxCertificate -Cert $leaf -FilePath 'certs/server.pfx' -Password $securePassword -ChainOption BuildChain | Out-Null
Export-Certificate -Cert $root -FilePath 'certs/warehouse-root.cer' | Out-Null
Import-Certificate -FilePath 'certs/warehouse-root.cer' -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
@{ip=$WarehouseIP;passphrase=$password} | ConvertTo-Json | Set-Content -LiteralPath 'certs/https.json' -Encoding UTF8
# Restrict the folder to the current Windows account and SYSTEM.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe (Join-Path $PSScriptRoot 'certs') /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
Write-Host "HTTPS ready. Restart start.cmd, then visit https://${WarehouseIP}:8443"
Write-Host "On each phone install and trust: http://${WarehouseIP}:8080/warehouse-root.cer"
Write-Host 'Keep certs/server.pfx and certs/https.json private. Never upload certs or data to GitHub.'
