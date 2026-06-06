@echo off
cd /d "%~dp0"
if not exist "api-key.txt" (
  echo Please create api-key.txt and put your DeepSeek API key in it.
  pause
  exit /b 1
)
findstr /C:"REPLACE_WITH_YOUR_DEEPSEEK_API_KEY" "api-key.txt" >nul
if not errorlevel 1 (
  echo Please replace the placeholder in api-key.txt with your DeepSeek API key.
  pause
  exit /b 1
)
"..\node\node.exe" "ai-server.js"
pause
