@echo off
rem Vyre for Chrome: the launcher for Windows. Finds Node on PATH or in the usual places, then runs cli.mjs.
setlocal
set "HERE=%~dp0"
set "CLI=%HERE%standalone\cli.mjs"
if not exist "%CLI%" set "CLI=%HERE%cli.mjs"
set "NODE="
for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Volta\bin\node.exe" set "NODE=%LocalAppData%\Volta\bin\node.exe"
if not defined NODE (
  echo Vyre for Chrome needs Node 22 or newer, and could not find it. Install it from https://nodejs.org and run this again. 1>&2
  exit /b 127
)
"%NODE%" "%CLI%" %*
