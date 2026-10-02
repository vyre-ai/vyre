; Vyre reaches the person's server through Tailscale. The installer checks and says where to get it; it never
; installs it. A silent install (the app updating itself) says nothing.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent vyre_ts_done
  IfFileExists "$PROGRAMFILES64\Tailscale\tailscale.exe" vyre_ts_done
  IfFileExists "$PROGRAMFILES\Tailscale\tailscale.exe" vyre_ts_done
  MessageBox MB_OK|MB_ICONINFORMATION "Vyre reaches your server through Tailscale, and Tailscale is not on this PC yet.$\r$\n$\r$\nGet it at https://tailscale.com/download/windows, sign in, then open Vyre. This installer does not install it for you."
  vyre_ts_done:
!macroend
