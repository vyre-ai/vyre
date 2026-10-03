# Experiment 3a: a BitLocker-protected VHDX unlocked with a password held in memory (no key file), locked, dismounted, re-opened.
$ErrorActionPreference = "Stop"
trap { "ERROR: $_ at line $($_.InvocationInfo.ScriptLineNumber)"; exit 1 }
$dir = "C:\vyre-spike\bl"; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $dir | Out-Null
$vhd = "$dir\space.vhdx"
$t0 = Get-Date
# create + attach + format with diskpart (works without the Hyper-V module, so it also works on Home for the disk part)
@"
create vdisk file="$vhd" maximum=512 type=expandable
select vdisk file="$vhd"
attach vdisk
create partition primary
format fs=ntfs quick label=vyre
assign mount="$dir\mnt"
"@ | Out-File "$dir\dp1.txt" -Encoding ascii
New-Item -ItemType Directory -Force "$dir\mnt" | Out-Null
diskpart /s "$dir\dp1.txt" | Out-Null
"created and mounted: " + (Test-Path "$dir\mnt") + "  (" + [int]((Get-Date) - $t0).TotalSeconds + "s)"
$pw = ConvertTo-SecureString "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" -AsPlainText -Force
Enable-BitLocker -MountPoint "$dir\mnt" -EncryptionMethod XtsAes256 -PasswordProtector -Password $pw -UsedSpaceOnly -SkipHardwareTest | Out-Null
"bitlocker status: " + (Get-BitLockerVolume -MountPoint "$dir\mnt").VolumeStatus + " " + (Get-BitLockerVolume -MountPoint "$dir\mnt").ProtectionStatus
"CANARY-BL-PLAINTEXT-5521" | Set-Content "$dir\mnt\a.txt"
manage-bde -status "$dir\mnt" | Select-String "Conversion Status|Percentage|Lock Status"
# wait for encryption to finish
for ($i = 0; $i -lt 60; $i++) { if ((Get-BitLockerVolume -MountPoint "$dir\mnt").VolumeStatus -eq "FullyEncrypted") { break }; Start-Sleep 2 }
"status after wait: " + (Get-BitLockerVolume -MountPoint "$dir\mnt").VolumeStatus
Lock-BitLocker -MountPoint "$dir\mnt" -ForceDismount | Out-Null
"locked, readable: " + (Test-Path "$dir\mnt\a.txt")
@"
select vdisk file="$vhd"
detach vdisk
"@ | Out-File "$dir\dp2.txt" -Encoding ascii
diskpart /s "$dir\dp2.txt" | Out-Null
# raw search for the canary in the VHDX file
$bytes = [IO.File]::ReadAllBytes($vhd); $s = [Text.Encoding]::ASCII.GetString($bytes)
"canary in raw vhdx: " + $s.Contains("CANARY-BL-PLAINTEXT-5521")
# re-open with the password only
@"
select vdisk file="$vhd"
attach vdisk
"@ | Out-File "$dir\dp3.txt" -Encoding ascii
diskpart /s "$dir\dp3.txt" | Out-Null
$vol = Get-Volume | Where-Object { $_.FileSystemLabel -eq "vyre" -or $_.FileSystemType -eq "" } | Select-Object -First 3
"after reattach, volumes: " + ($vol | ForEach-Object { $_.DriveLetter + ":" + $_.FileSystemLabel }) -join ","
$d = (Get-Disk | Where-Object { $_.Location -like "*space.vhdx*" -or $_.FriendlyName -like "*Virtual*" } | Select-Object -First 1)
$p = Get-Partition -DiskNumber $d.Number | Select-Object -First 1
Add-PartitionAccessPath -DiskNumber $d.Number -PartitionNumber $p.PartitionNumber -AccessPath "$dir\mnt" -ErrorAction SilentlyContinue
"locked after reattach: " + (Get-BitLockerVolume -MountPoint "$dir\mnt").LockStatus
$bad = ConvertTo-SecureString "wrong" -AsPlainText -Force
try { Unlock-BitLocker -MountPoint "$dir\mnt" -Password $bad | Out-Null; "WRONG PASSWORD UNLOCKED" } catch { "wrong password refused" }
Unlock-BitLocker -MountPoint "$dir\mnt" -Password $pw | Out-Null
"unlocked with password: " + (Get-Content "$dir\mnt\a.txt")
Lock-BitLocker -MountPoint "$dir\mnt" -ForceDismount | Out-Null
diskpart /s "$dir\dp2.txt" | Out-Null
Remove-Item $dir -Recurse -Force
"done " + [int]((Get-Date) - $t0).TotalSeconds + "s"
