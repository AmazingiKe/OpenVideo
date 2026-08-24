@echo off
setlocal

pushd "%~dp0"
call pnpm dev
set "OPENVIDEO_EXIT_CODE=%ERRORLEVEL%"
popd

exit /b %OPENVIDEO_EXIT_CODE%
