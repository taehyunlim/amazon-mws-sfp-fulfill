@echo off
echo Type in Today's Date in MM.DD.YY format (ex. 01.31.18):
set /p input=""
node ./main.js %input%
echo Press any key to exit.
pause >nul