@echo off
echo ========================================
echo  AC25 Level Editor - Build .exe
echo ========================================
echo.

REM Check if PyInstaller is installed
pip show pyinstaller >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Installing PyInstaller...
    pip install pyinstaller
)

echo Building .exe...
pyinstaller --onefile --windowed ^
    --name "AC25_Level_Editor" ^
    --add-data "acl_parser.py;." ^
    --hidden-import tkinter ^
    --hidden-import tkinter.ttk ^
    --hidden-import tkinter.filedialog ^
    --hidden-import tkinter.messagebox ^
    --hidden-import tkinter.simpledialog ^
    --clean ^
    main.py

echo.
echo ========================================
echo  Build complete!
echo  Output: dist\AC25_Level_Editor.exe
echo ========================================
pause
