; CCS/1 uninstall drops the "Start with Windows" HKCU Run value the tray toggle made.
; WHY(UpdateMode): an update runs the old uninstaller with /UPDATE; keeping the value keeps autostart across upgrades.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FolderPilot"
  ${EndIf}
!macroend
