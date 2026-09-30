@echo off
rem The matrix's Windows 11 guest (dockur runs this once, when the unattended install ends).
rem Chrome, the box at 127.0.0.1:7300 (the only Host the onboarding takes), and DevTools for the runner.
curl -sL -o C:\chrome.msi https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi
msiexec /i C:\chrome.msi /qn /norestart
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=7300 connectaddress=172.17.0.1 connectport=17300
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9223 connectaddress=127.0.0.1 connectport=9222
netsh advfirewall firewall add rule name=matrix-cdp dir=in action=allow protocol=TCP localport=9223
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\cdp --no-first-run --no-default-browser-check --start-maximized about:blank
