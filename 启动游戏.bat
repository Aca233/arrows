@echo off
chcp 65001 >nul
title 箭有虚发 - 游戏服务器
echo ================================
echo   箭有虚发 (Arrows Never Miss)
echo ================================
echo.
echo 正在启动服务器...
echo 启动后请在浏览器打开: http://localhost:3000
echo 按 Ctrl+C 停止服务器
echo.
cd /d "%~dp0"
start http://localhost:3000
node server.js
pause
