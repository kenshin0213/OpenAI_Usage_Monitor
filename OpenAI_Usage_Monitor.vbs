' ==============================================================================
' OpenAI 사용량 모니터 - 윈도우 탐색기 직접 실행기 (VBScript)
' 탐색기에서 더블클릭 시 검은 콘솔창(CMD) 없이 백그라운드 트레이로 즉시 무음 실행합니다.
' ==============================================================================

Option Explicit

Dim WshShell, fso, strPath, strBuiltExe, strLocalExe, runCommand

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 현재 스크립트가 위치한 프로젝트 루트 디렉터리 경로 획득
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath

' 1. 패키징된 독립 포터블 실행 파일 우선 탐색
strBuiltExe = strPath & "\dist\OpenAI_Usage_Monitor-win32-x64\OpenAI_Usage_Monitor.exe"
' 2. 개발 환경의 로컬 electron 바이너리 탐색
strLocalExe = strPath & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(strBuiltExe) Then
    runCommand = """" & strBuiltExe & """"
ElseIf fso.FileExists(strLocalExe) Then
    runCommand = """" & strLocalExe & """ ."
Else
    ' 3. 시스템 전역 PATH 상의 electron 폴백
    runCommand = "electron ."
End If

' WindowStyle: 0 = 숨김 창 (검은 콘솔창 없이 백그라운드 무음 실행)
' WaitOnReturn: False = 비동기 실행 (스크립트 프로세스는 즉시 종료되고 모니터 프로세스만 상주)
WshShell.Run runCommand, 0, False

Set WshShell = Nothing
Set fso = Nothing
