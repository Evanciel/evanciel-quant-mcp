# Windows 24/7 데몬 운영 (작업 스케줄러 + 워치독)

레짐정지 봇(일봉, testnet)을 **재부팅·크래시까지 살아남는 24/7**로 굴리기 위한 Windows 운영 메모.
메인넷 OFF 불변(`LIVE_TRADING_ENABLED` 미설정 → liveGate가 testnet/mock만 통과).

## 무엇이 도는가
- `npm run daemon`(= `src/daemon.ts`): 러너 `resumeAll()`(status=running 봇 재개) + 대시보드(`127.0.0.1:7788` + `/healthz`) + graceful shutdown. MCP 클라이언트 불필요(헤드리스).
- 봇: `BTCUSDT/ETHUSDT 레짐정지봇`(condition `regime∈[trend_up]`→보유 / else→관망, 일봉). 하락장이면 자동 관망 = 리스크 통제.
- 런처 `scripts/go-daemon.ts`(repo): `.env.local`에서 testnet 키 로드 + "레짐정지" 봇 running 복귀 + `daemon.ts` 기동. (키 값은 코드가 처리 — 노출 0.)

## 어떻게 24/7로 유지하나 (Docker 대신 작업 스케줄러)
개인 Windows·일봉(하루 1틱)·testnet엔 Docker Desktop 상주가 과해서 **작업 스케줄러**를 사용.

- 작업 이름: **`quant-mcp-daemon`**
- 트리거: **로그온 시** + **15분 주기(무기한)**
- 동작: **워치독 VBS**(`%USERPROFILE%\.quant-mcp\launch-daemon.vbs`, 머신 특화·UTF-16·repo 밖)
  - `http://127.0.0.1:7788/healthz` 확인 → **살아있으면 no-op**(중복 방지), **죽어있으면** 데몬을 **콘솔 창 없이(hidden)** 기동하고 stdout/stderr를 `%USERPROFILE%\.quant-mcp\daemon.log`로 리다이렉트.
- 효과: 재부팅 생존(로그온 트리거) + 크래시 자동복구(≤15분) + 무중복 + 콘솔창 없음 + 로그. Task Scheduler 소유라 Claude/터미널 세션과 무관하게 생존.

> 검증됨: ① 데몬 가동 중 워치독 재실행 → 인스턴스 1개 유지(중복 X) ② 데몬 강제 종료 → 워치독이 2초 내 부활(self-heal).

## 관리 명령 (PowerShell)
```powershell
# 상태
(Invoke-WebRequest http://127.0.0.1:7788/healthz -UseBasicParsing).Content   # {"ok":true,"runningBots":2}
Get-ScheduledTask quant-mcp-daemon ; Get-ScheduledTaskInfo quant-mcp-daemon
Get-Content "$env:USERPROFILE\.quant-mcp\daemon.log" -Tail 20 -Encoding UTF8

# 수동 기동(워치독 호출 — 죽어있을 때만 뜸)
Start-ScheduledTask quant-mcp-daemon

# 일시중지 / 재개
Disable-ScheduledTask quant-mcp-daemon       # 자동 기동 중단(이미 뜬 데몬은 안 죽음)
Enable-ScheduledTask quant-mcp-daemon

# 완전 정지: 작업 끄고 + 현재 데몬 종료
Disable-ScheduledTask quant-mcp-daemon
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*go-daemon*' } | % { Stop-Process -Id $_.ProcessId -Force }

# 작업 제거(완전 삭제)
Unregister-ScheduledTask quant-mcp-daemon -Confirm:$false
```

## 재현(작업 + 워치독 설치)
머신 특화 경로(`C:\Users\KHS\...`, node `C:\nodejs\node.exe`)는 환경에 맞게 조정. 8.3 short path가 꺼져 있어 VBS는 UTF-16로 작성(Korean 경로 보존).
```powershell
$dir = (Resolve-Path '..\quant-mcp').Path ; $node = 'C:\nodejs\node.exe'
$log = "$env:USERPROFILE\.quant-mcp\daemon.log" ; $vbsPath = "$env:USERPROFILE\.quant-mcp\launch-daemon.vbs"
$vbs = @"
Option Explicit
Dim sh, up : up = False
Set sh = CreateObject("WScript.Shell")
On Error Resume Next
Dim http : Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:7788/healthz", False
http.Send
If Err.Number = 0 Then
  If http.Status = 200 Then up = True
End If
On Error GoTo 0
If Not up Then sh.Run "cmd /c cd /d ""$dir"" && ""$node"" --import tsx scripts/go-daemon.ts >> ""$log"" 2>&1", 0, False
"@
$vbs | Out-File $vbsPath -Encoding Unicode
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`"" -WorkingDirectory $dir
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$rep = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'quant-mcp-daemon' -Action $action -Trigger @($logon,$rep) -Settings $settings -Principal $principal
```

## 한계(정직)
- **best-effort 24/7**: PC가 켜져 있고 로그인된 동안. 절전/최대절전은 깨어날 때 재개(일봉 1틱이라 영향 작음).
- **알림 미설정**: 데몬 사망 시 무음. 원하면 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_IDS` 또는 `ALERT_WEBHOOK_URL` 설정 시 치명오류·하트비트 경보(데몬 내장).
- **testnet 전용**: 키는 `.env.local`(gitignored). 메인넷은 별도 게이트(`LIVE_TRADING_ENABLED`) + 소액 파일럿 전까지 OFF.
- 더 강한 격리/재현성이 필요해지면(실거래·서버) `Dockerfile`(restart:always)로 전환.
