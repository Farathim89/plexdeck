; On a real uninstall (not an update), remove the "Start with Windows" entry.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.farathim.plexplayer"
  ${endIf}
!macroend
