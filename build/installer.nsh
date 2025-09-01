!macro customInstall
CreateDirectory "$InstDir\GTA Horizon"
; Concede permisos de modificación a "Usuarios" para no requerir admin en runtime
nsExec::ExecToLog 'icacls "$InstDir\GTA Horizon" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend