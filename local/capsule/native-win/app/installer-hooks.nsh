; Vyre reaches the person's server through Tailscale. The installer checks and says where to get it; it never
; installs it. A silent install (the app updating itself) says nothing.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent vyre_ts_done
  IfFileExists "$PROGRAMFILES64\Tailscale\tailscale.exe" vyre_ts_done
  IfFileExists "$PROGRAMFILES\Tailscale\tailscale.exe" vyre_ts_done
  MessageBox MB_OK|MB_ICONINFORMATION "Vyre reaches your server through Tailscale, and Tailscale is not on this PC yet.$\r$\n$\r$\nGet it at https://tailscale.com/download/windows, sign in, then open Vyre. This installer does not install it for you."
  vyre_ts_done:
!macroend

; Uninstall (not an update: the installer runs the old uninstaller with /UPDATE, and the app's updater and the install script pass /UPDATE
; to the installer): take down the startup task and the local files, and say what stays. An update keeps the task, the core and the pairing.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "Vyre" /F'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\run.vyre.app"
    RMDir /r "$APPDATA\run.vyre.app"
    ; The helper's own key (sealed), its server pin and its log live in the .vyre folder; the rest of that folder stays.
    ReadEnvStr $0 USERPROFILE
    Delete "$0\.vyre\companion.json"
    Delete "$0\.vyre\pipe-token"
    Delete "$0\.vyre\core.log"
    ${If} $PassiveMode <> 1
      IfSilent vyre_post_done
      MessageBox MB_OK|MB_ICONINFORMATION "Vyre is removed from this PC, with its startup task, its local helper and its keys.$\r$\n$\r$\nLeft on purpose: your Vyre server and the history already sent to it, and the rest of the .vyre folder in your user folder. This PC stays in Devices on your server until you remove it there."
    ${EndIf}
  ${EndIf}
  vyre_post_done:
!macroend
