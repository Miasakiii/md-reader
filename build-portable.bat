@echo off
echo 构建 MD Reader...

:: 检查依赖
where node >nul 2>nul || (echo 需要安装 Node.js & exit /b 1)
where cargo >nul 2>nul || (echo 需要安装 Rust & exit /b 1)

:: 安装前端依赖
echo 安装前端依赖...
call npm install

:: 构建
echo 构建应用...
call npm run tauri build

echo.
echo 构建完成！
echo.
echo 构建产物位置:
echo   安装版: src-tauri\target\release\bundle\nsis\
echo   便携版: src-tauri\target\release\md-reader.exe
echo.
pause
