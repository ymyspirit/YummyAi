@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where pwsh.exe >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\scripts\start-local.ps1"
) else (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\scripts\start-local.ps1"
)

set "YUMMYAI_EXIT=%ERRORLEVEL%"
echo.
if not "%YUMMYAI_EXIT%"=="0" (
  echo YummyAI startup failed. Review the error above.
) else (
  echo YummyAI is running. Closing this window will not stop the services.
)
echo Press any key to close this launcher.
pause >nul
exit /b %YUMMYAI_EXIT%
