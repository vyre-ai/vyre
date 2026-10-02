; Vyre reaches the person's server through Tailscale. The installer checks and says where to get it; it never
; installs it. A silent install (the app updating itself) says nothing.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent vyre_ts_done
  IfFileExists "$PROGRAMFILES64\Tailscale\tailscale.exe" vyre_ts_done
  IfFileExists "$PROGRAMFILES\Tailscale\tailscale.exe" vyre_ts_done
  MessageBox MB_OK|MB_ICONINFORMATION "Vyre reaches your server through Tailscale, and Tailscale is not on this PC yet.$\r$\n$\r$\nGet it at https://tailscale.com/download/windows, sign in, then open Vyre. This installer does not install it for you."
  vyre_ts_done:
!macroend

; Uninstall (not an update, which runs the old uninstaller silently with /UPDATE, and not a silent one): take down the startup task
; and the local files, and say what stays. Updates keep the task, the core and the pairing.
!macro NSIS_HOOK_PREUNINSTALL
  IfSilent vyre_pre_done
  ${GetOptions} $CMDLINE "/UPDATE" $1
  ${IfNot} ${Errors}
    Goto vyre_pre_done
  ${EndIf}
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "Vyre" /F'
  Pop $0
  vyre_pre_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  IfSilent vyre_post_done
  ${GetOptions} $CMDLINE "/UPDATE" $1
  ${IfNot} ${Errors}
    Goto vyre_post_done
  ${EndIf}
  RMDir /r "$LOCALAPPDATA\run.vyre.app"
  RMDir /r "$APPDATA\run.vyre.app"
  MessageBox MB_OK|MB_ICONINFORMATION "Vyre is removed from this PC, with its startup task, its local helper and its keys.$\r$\n$\r$\nLeft on purpose: your Vyre server and the history already sent to it, and the .vyre folder in your user folder. This PC still shows as a device on your server until you remove it in Devices."
  vyre_post_done:
!macroend
