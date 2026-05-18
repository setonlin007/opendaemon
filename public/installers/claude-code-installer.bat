@echo off
REM Claude Code 国内一键安装器 · Windows 版
REM 双击此文件，会自动在 cmd 打开运行

chcp 65001 > nul
setlocal enabledelayedexpansion
title Claude Code · 国内一键安装

cls
echo ==================================================
echo.
echo    Claude Code  国内一键安装
echo    for Windows  适配国内网络和国内 AI
echo.
echo ==================================================
echo.
echo // 这个脚本会做 5 件事：
echo //   1. 检查 Node.js
echo //   2. 用淘宝 npm 镜像装 Claude Code
echo //   3. 装 claude-code-router（让 CC 能接国内 AI）
echo //   4. 让你选一个国内 AI 后端 + 填 key
echo //   5. 写配置 · 提示用法
echo.
set /p _start="按回车开始 > "

REM ---- [1/5] 检查 / 自动装 Node.js ----
echo.
echo [1/5] 检查 Node.js

set NODE_VER=v22.11.0
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo !  没找到 Node.js · 即将自动下载安装
  echo.

  REM 检测架构
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    set NODE_MSI_FILE=node-!NODE_VER!-arm64.msi
  ) else (
    set NODE_MSI_FILE=node-!NODE_VER!-x64.msi
  )
  set NODE_MSI_URL=https://cdn.npmmirror.com/binaries/node/!NODE_VER!/!NODE_MSI_FILE!
  set NODE_MSI_PATH=%TEMP%\!NODE_MSI_FILE!

  echo //  从淘宝镜像下载（约 30MB）
  echo //  !NODE_MSI_URL!
  echo.

  REM 用 PowerShell 下载（progress 友好 + 不需要额外工具）
  powershell -NoProfile -Command "$ProgressPreference='Continue'; try { Invoke-WebRequest -Uri '!NODE_MSI_URL!' -OutFile '!NODE_MSI_PATH!' -UseBasicParsing; exit 0 } catch { Write-Host $_; exit 1 }"
  if !errorlevel! neq 0 (
    echo X 下载失败
    echo 请检查网络后重试，或手动去 https://nodejs.org/zh-cn/ 装 LTS
    pause
    exit /b 1
  )
  echo OK  下载完成

  echo.
  echo 安装 Node.js（系统会弹"用户账户控制"提示，点【是】即可）
  echo.

  REM 用 UAC 弹窗提权静默安装 msi
  powershell -NoProfile -Command "$p = Start-Process msiexec.exe -ArgumentList '/i','!NODE_MSI_PATH!','/quiet','/norestart','ADDLOCAL=ALL' -Verb RunAs -PassThru -Wait; exit $p.ExitCode"
  if !errorlevel! neq 0 (
    echo X 安装失败 ^(errorlevel=!errorlevel!^)
    echo 请手动双击 !NODE_MSI_PATH! 安装，或去 https://nodejs.org/zh-cn/ 装 LTS
    pause
    exit /b 1
  )
  echo OK  Node.js 安装成功

  REM 装完后当前 cmd 的 PATH 还是旧的，得手动加进来
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs"
)

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo X 装完仍找不到 node 命令
  echo.
  echo 请关闭本窗口，重新双击本脚本运行
  echo （Windows 装完 Node 后，新的 cmd 才能识别）
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
for /f "delims=" %%v in ('npm -v') do set NPM_VERSION=%%v

REM Node 版本检查 (>= 18)
for /f "tokens=1 delims=." %%a in ("!NODE_VERSION:v=!") do set NODE_MAJOR=%%a
if !NODE_MAJOR! lss 18 (
  echo !  Node.js !NODE_VERSION! 太老 ^(Claude Code 需要 ^>= 18^)
  set /p UPGRADE_NODE="要自动下载安装新版覆盖吗？(y/n) "
  if /i "!UPGRADE_NODE!"=="y" (
    if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
      set NODE_MSI_FILE=node-!NODE_VER!-arm64.msi
    ) else (
      set NODE_MSI_FILE=node-!NODE_VER!-x64.msi
    )
    set NODE_MSI_URL=https://cdn.npmmirror.com/binaries/node/!NODE_VER!/!NODE_MSI_FILE!
    set NODE_MSI_PATH=%TEMP%\!NODE_MSI_FILE!
    powershell -NoProfile -Command "$ProgressPreference='Continue'; Invoke-WebRequest -Uri '!NODE_MSI_URL!' -OutFile '!NODE_MSI_PATH!' -UseBasicParsing"
    powershell -NoProfile -Command "$p = Start-Process msiexec.exe -ArgumentList '/i','!NODE_MSI_PATH!','/quiet','/norestart','ADDLOCAL=ALL' -Verb RunAs -PassThru -Wait; exit $p.ExitCode"
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
    for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
    for /f "delims=" %%v in ('npm -v') do set NPM_VERSION=%%v
  ) else (
    echo 请手动升级 Node.js 到 18+ 后重试
    pause
    exit /b 1
  )
)
echo OK  Node.js !NODE_VERSION!  ·  npm !NPM_VERSION!

REM ---- [2/5] 配置 npm 国内镜像 ----
echo.
echo [2/5] 配置淘宝 npm 镜像
for /f "delims=" %%v in ('npm config get registry') do set CURRENT_REG=%%v
echo !CURRENT_REG! | findstr /C:"npmmirror" >nul
if !errorlevel! neq 0 (
  echo //  当前 registry: !CURRENT_REG!
  set /p SWITCH_REG="切到淘宝镜像吗？(y/n，默认 y) "
  if /i not "!SWITCH_REG!"=="n" (
    call npm config set registry https://registry.npmmirror.com
    echo OK  已切到 registry.npmmirror.com
  ) else (
    echo !  保留原 registry（如果装得慢就重跑本脚本切换）
  )
) else (
  echo OK  已经是国内镜像
)

REM ---- [3/5] 装 Claude Code ----
echo.
echo [3/5] 安装 Claude Code（1-2 分钟）
where claude >nul 2>nul
if %errorlevel% equ 0 (
  echo //  已检测到 Claude Code，跳过
) else (
  echo //  npm install -g @anthropic-ai/claude-code
  call npm install -g @anthropic-ai/claude-code
)
where claude >nul 2>nul
if %errorlevel% neq 0 (
  echo X Claude Code 安装失败，请检查网络后重试
  pause
  exit /b 1
)
echo OK  Claude Code 装好了

REM ---- [4/5] 装 claude-code-router ----
echo.
echo [4/5] 安装国内 AI 适配器 claude-code-router
where ccr >nul 2>nul
if %errorlevel% equ 0 (
  echo //  已检测到 ccr，跳过
) else (
  echo //  npm install -g @musistudio/claude-code-router
  call npm install -g @musistudio/claude-code-router
)
where ccr >nul 2>nul
if %errorlevel% neq 0 (
  echo X claude-code-router 安装失败
  pause
  exit /b 1
)
echo OK  claude-code-router 装好了

REM ---- [5/5] 选 AI 后端 + 配置 ----
echo.
echo [5/5] 选个国内 AI 后端
echo.
echo   1  DeepSeek       推理顶级 · 最便宜
echo   2  通义千问       阿里 · 速度最快
echo   3  GLM（智谱）    多模态 · 长文档
echo   4  MiniMax        语音 · 长上下文
echo.

:choose_ai
set /p AI_CHOICE="选 1-4: "
if "%AI_CHOICE%"=="1" goto ai_deepseek
if "%AI_CHOICE%"=="2" goto ai_qwen
if "%AI_CHOICE%"=="3" goto ai_glm
if "%AI_CHOICE%"=="4" goto ai_minimax
echo 请输入 1、2、3 或 4
goto choose_ai

:ai_deepseek
set PROVIDER_LABEL=DeepSeek
set PROVIDER_NAME=deepseek
set BASE_URL=https://api.deepseek.com/chat/completions
set MODELS_JSON=["deepseek-chat","deepseek-reasoner"]
set DEFAULT_MODEL=deepseek-chat
set TRANSFORMER_JSON={"use":["deepseek"],"deepseek-chat":{"use":["tooluse"]}}
set APIKEY_URL=https://platform.deepseek.com/api_keys
goto ai_set_done

:ai_qwen
set PROVIDER_LABEL=通义千问
set PROVIDER_NAME=qwen
set BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
set MODELS_JSON=["qwen3-coder-plus"]
set DEFAULT_MODEL=qwen3-coder-plus
set TRANSFORMER_JSON={"use":[["maxtoken",{"max_tokens":65536}],"enhancetool"]}
set APIKEY_URL=https://bailian.console.aliyun.com/?tab=model
goto ai_set_done

:ai_glm
set PROVIDER_LABEL=GLM 智谱
set PROVIDER_NAME=zhipu
set BASE_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
set MODELS_JSON=["glm-4.5","glm-4-plus"]
set DEFAULT_MODEL=glm-4.5
set TRANSFORMER_JSON={"use":["Anthropic"]}
set APIKEY_URL=https://open.bigmodel.cn/usercenter/apikeys
goto ai_set_done

:ai_minimax
set PROVIDER_LABEL=MiniMax
set PROVIDER_NAME=minimax
set BASE_URL=https://api.minimaxi.com/v1/text/chatcompletion_v2
set MODELS_JSON=["MiniMax-Text-01"]
set DEFAULT_MODEL=MiniMax-Text-01
set TRANSFORMER_JSON={"use":["Anthropic"]}
set APIKEY_URL=https://platform.minimaxi.com/user-center/basic-information/interface-key
goto ai_set_done

:ai_set_done
echo.
echo 你选了：!PROVIDER_LABEL!
echo.
echo // 没 API key？先打开下面链接申请（免费注册，新人多送额度）：
echo    !APIKEY_URL!
echo.

:input_key
set /p API_KEY="粘贴你的 API key: "
if "!API_KEY!"=="" (
  echo key 不能为空，再试一次
  goto input_key
)

REM ---- 写配置 ----
set CONFIG_DIR=%USERPROFILE%\.claude-code-router
set CONFIG_PATH=!CONFIG_DIR!\config.json
if not exist "!CONFIG_DIR!" mkdir "!CONFIG_DIR!"

set SKIP_WRITE=
if exist "!CONFIG_PATH!" (
  echo.
  echo !  已检测到旧的 config.json
  echo    !CONFIG_PATH!
  echo.
  echo   1  覆盖   用新选的 !PROVIDER_LABEL! 替换全部（旧的会备份）
  echo   2  追加   把 !PROVIDER_LABEL! 加到 Providers 数组里（保留其它）
  echo   3  跳过   不动 config，安装到此结束
  echo.

:choose_cfg
  set /p CFG_CHOICE="选 1-3: "
  if "!CFG_CHOICE!"=="1" goto cfg_ok
  if "!CFG_CHOICE!"=="2" goto cfg_ok
  if "!CFG_CHOICE!"=="3" goto cfg_ok
  echo 请输入 1、2 或 3
  goto choose_cfg

:cfg_ok
  REM 备份
  for /f "tokens=2 delims==" %%t in ('wmic os get localdatetime /value ^| find "="') do set BACKUP_TS=%%t
  copy "!CONFIG_PATH!" "!CONFIG_PATH!.backup.!BACKUP_TS:~0,14!" >nul
  echo //  已备份旧配置

  if "!CFG_CHOICE!"=="3" (
    echo //  跳过配置写入
    set SKIP_WRITE=1
  )
  if "!CFG_CHOICE!"=="2" (
    REM 追加模式：用 PowerShell 解析并合并 JSON
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$cfg = Get-Content -Raw -Path '!CONFIG_PATH!' | ConvertFrom-Json; if (-not $cfg.Providers) { $cfg | Add-Member -NotePropertyName 'Providers' -NotePropertyValue @() }; $cfg.Providers = @($cfg.Providers | Where-Object { $_.name -ne '!PROVIDER_NAME!' }); $newProvider = @{ name = '!PROVIDER_NAME!'; api_base_url = '!BASE_URL!'; api_key = '!API_KEY!'; models = (ConvertFrom-Json '!MODELS_JSON!'); transformer = (ConvertFrom-Json '!TRANSFORMER_JSON!') }; $cfg.Providers += [PSCustomObject]$newProvider; if (-not $cfg.Router) { $cfg | Add-Member -NotePropertyName 'Router' -NotePropertyValue ([PSCustomObject]@{}) }; $cfg.Router | Add-Member -NotePropertyName 'default' -NotePropertyValue '!PROVIDER_NAME!,!DEFAULT_MODEL!' -Force; ($cfg | ConvertTo-Json -Depth 10) | Out-File -FilePath '!CONFIG_PATH!' -Encoding UTF8"
    echo OK  已追加 !PROVIDER_NAME! 到 Providers (default 路由切换到它)
    set SKIP_WRITE=1
  )
)

if not defined SKIP_WRITE (
  (
    echo {
    echo   "LOG": false,
    echo   "Providers": [
    echo     {
    echo       "name": "!PROVIDER_NAME!",
    echo       "api_base_url": "!BASE_URL!",
    echo       "api_key": "!API_KEY!",
    echo       "models": !MODELS_JSON!,
    echo       "transformer": !TRANSFORMER_JSON!
    echo     }
    echo   ],
    echo   "Router": {
    echo     "default": "!PROVIDER_NAME!,!DEFAULT_MODEL!",
    echo     "background": "!PROVIDER_NAME!,!DEFAULT_MODEL!",
    echo     "think": "!PROVIDER_NAME!,!DEFAULT_MODEL!",
    echo     "longContext": "!PROVIDER_NAME!,!DEFAULT_MODEL!"
    echo   }
    echo }
  ) > "!CONFIG_PATH!"
  echo OK  配置已写入 !CONFIG_PATH!
)

REM ---- 完成 ----
echo.
echo ==================================================
echo.
echo    OK  全部完成！
echo.
echo ==================================================
echo.
echo 下次怎么用：
echo.
echo   1  打开 PowerShell （Win+R 输入 powershell 回车）
echo   2  cd 到你的项目文件夹
echo   3  敲 ccr code   // 启动 Claude Code（已接好国内 AI）
echo.
echo // 小技巧：第一次进项目先输 /init，让 AI 记住你的文件结构
echo.
echo // 想换 AI 后端？重新双击本脚本即可（会备份旧配置）
echo.
pause
endlocal
