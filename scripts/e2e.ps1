# FolderPilot E2E (#164): makes a fresh test folder of fake files (never your real files) and starts the app.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("FolderPilot-E2E-" + (Get-Date -Format 'HHmmss'))
$inbox = New-Item -ItemType Directory (Join-Path $root 'Inbox')

function Put($name, [byte[]]$bytes, $daysOld = 0) {
    $path = Join-Path $inbox $name
    [IO.File]::WriteAllBytes($path, $bytes)
    if ($daysOld) { (Get-Item $path).LastWriteTime = (Get-Date).AddDays(-$daysOld) }
}
$ascii = [Text.Encoding]::ASCII
# Minimal JPEG whose EXIF DateTimeOriginal is $date ("YYYY:MM:DD HH:MM:SS").
function Jpeg($date) {
    $tiff = [byte[]](0x49,0x49,0x2a,0,8,0,0,0, 1,0,0x69,0x87,4,0,1,0,0,0,26,0,0,0,0,0,0,0, 1,0,0x03,0x90,2,0,20,0,0,0,44,0,0,0,0,0,0,0) + $ascii.GetBytes($date) + [byte[]](0)
    $app1 = $ascii.GetBytes("Exif") + [byte[]](0,0) + $tiff
    $len = $app1.Length + 2
    return [byte[]](0xFF,0xD8,0xFF,0xE1,[byte]($len -shr 8),[byte]($len -band 0xFF)) + $app1 + [byte[]](0xFF,0xD9)
}

Put 'invoice-0412.pdf' $ascii.GetBytes("%PDF-1.4 test invoice")
Put 'contract.pdf' $ascii.GetBytes("%PDF-1.4 test contract")
Put 'old-statement.pdf' $ascii.GetBytes("%PDF-1.4 old statement") 200
Put 'IMG_1001.jpg' (Jpeg '2019:07:04 10:00:00')
Put 'IMG_1002.jpg' (Jpeg '2023:12:24 18:30:00')
Put 'screenshot.png' $ascii.GetBytes("not a real png, no EXIF")
Put 'report.docx' $ascii.GetBytes("fake docx")
Put 'old-notes.txt' $ascii.GetBytes("notes from long ago") 120
Put 'setup.zip' $ascii.GetBytes("fake zip, recent")

Set-Clipboard $inbox.FullName
Write-Host "Test folder (path is on the clipboard): $($inbox.FullName)"
Start-Process powershell -ArgumentList '-NoExit', '-Command', 'npm run tauri dev' -WorkingDirectory (Split-Path $PSScriptRoot)
Write-Host "FolderPilot is starting in a new window."
