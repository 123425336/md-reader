@echo off
rem MoYue reader build entry. Reads build.ps1 as UTF-8 so Chinese text is never decoded with the system code page.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r='%~dp0'; $c=[IO.File]::ReadAllText((Join-Path $r 'build.ps1'),[Text.Encoding]::UTF8); & ([ScriptBlock]::Create($c)) -Root $r %*"
exit /b %ERRORLEVEL%
