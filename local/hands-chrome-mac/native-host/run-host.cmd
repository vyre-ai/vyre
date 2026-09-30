@echo off
rem Chrome runs this file, not host.js: a native messaging manifest names one executable.
rem install.js records the node it was run with in node-path, beside this file. The standalone
rem package also records the pipe it listens on in sock-path.
set /p VYRE_NODE=<"%~dp0node-path"
if exist "%~dp0sock-path" set /p VYRE_CHROME_SOCK=<"%~dp0sock-path"
"%VYRE_NODE%" "%~dp0host.js" %*
