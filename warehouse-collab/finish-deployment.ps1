#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$config=Get-Content -LiteralPath 'certs/https.json' -Raw | ConvertFrom-Json
$ip=$config.ip
Write-Host "Warehouse service: https://${ip}:8443"
Write-Host 'This will allow TCP 8080/8443 only for the local subnet and this warehouse IP.'
Write-Host 'It will also create a per-user logon startup task and trust this warehouse root certificate on this PC.'
$node=(Get-Command node -ErrorAction Stop).Source
$rule=Get-NetFirewallRule -DisplayName 'Warehouse Counter LAN' -ErrorAction SilentlyContinue
if(-not $rule){
  New-NetFirewallRule -DisplayName 'Warehouse Counter LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $ip -LocalPort 8080,8443 -Profile Any -RemoteAddress LocalSubnet | Out-Null
}
Import-Certificate -FilePath 'certs/warehouse-root.cer' -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $PSScriptRoot 'server.mjs')+'"') -WorkingDirectory $PSScriptRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WarehouseBoxCounter' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
# If the service is already running, do not start a second copy. Restarting the computer will use the scheduled task.
$listener=Get-NetTCPConnection -LocalAddress $ip -LocalPort 8443 -State Listen -ErrorAction SilentlyContinue
if(-not $listener){Start-ScheduledTask -TaskName 'WarehouseBoxCounter'}
Write-Host 'Deployment setup completed. Keep the PC awake; automatic start runs after Windows sign-in.'
Write-Host "Phone certificate: http://${ip}:8080/warehouse-root.cer"
Write-Host "Open on all devices: https://${ip}:8443"
Read-Host 'Press Enter to close'
