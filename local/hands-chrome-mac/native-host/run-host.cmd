@echo off
rem Chrome runs this file, not host.js: a native messaging manifest names one executable.
rem install.js records the node it was run with in node-path, beside this file.
set /p VYRE_NODE=<"%~dp0node-path"
"%VYRE_NODE%" "%~dp0host.js" %*
