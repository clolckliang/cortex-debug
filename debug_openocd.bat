@echo off
echo ========================================
echo OpenOCD 调试诊断脚本
echo ========================================
echo.

echo 1. 检查OpenOCD版本...
"D:\Dev_env\OpenOCD\bin\openocd.exe" --version
echo.

echo 2. 测试基本连接...
"D:\Dev_env\OpenOCD\bin\openocd.exe" -c "interface cmsis-dap" -c "target stm32f4x" -c "init" -c "shutdown"
echo.

echo 3. 检查CMSIS-DAP设备...
echo 确保调试器已正确连接到电脑和目标板
echo.

echo 4. 常见解决方案:
echo - 确保USB线缆连接稳固
echo - 尝试不同的USB端口
echo - 检查目标板供电
echo - 确认目标板没有被其他调试器占用
echo.

pause