; ════════════════════════════════════════════════════════════════
; Nova Activity — instalador (Inno Setup 6).
; Compilar:  ISCC installer.iss   (o simplemente:  build.ps1)
; Instala por-usuario (sin admin), con página para pegar el token,
; arranque con Windows, acceso directo y desinstalador.
; ════════════════════════════════════════════════════════════════
#define AppName "Nova Activity"
#define AppVer  "1.0.0"
#define ExeName "nova-activity.exe"

[Setup]
AppId={{A7F3C2E1-9B4D-4E8A-B6C1-2F9D7E0A1B23}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Kiwoc
DefaultDirName={localappdata}\Programs\Nova Activity
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=NovaActivitySetup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
Source: "dist\nova-activity.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\probe.ps1";         DestDir: "{app}"; Flags: ignoreversion
Source: "dist\tray.ps1";          DestDir: "{app}"; Flags: ignoreversion
Source: "dist\icon.ico";          DestDir: "{app}"; Flags: ignoreversion
Source: "launch-hidden.vbs";      DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Nova Activity"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-hidden.vbs"""; IconFilename: "{app}\icon.ico"; Comment: "Iniciar Nova Activity (icono de bandeja)"

[Registry]
; Arranque con Windows (por-usuario), lanzado oculto vía wscript.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NovaActivity"; ValueData: "wscript.exe ""{app}\launch-hidden.vbs"""; Flags: uninsdeletevalue

[Run]
; Iniciar ahora al terminar la instalación.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-hidden.vbs"""; Description: "Iniciar Nova Activity ahora"; Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
; Detiene el agente (y sus procesos hijos: probe/tray) antes de borrar archivos.
Filename: "{sys}\taskkill.exe"; Parameters: "/f /t /im {#ExeName}"; Flags: runhidden; RunOnceId: "KillAgent"

[UninstallDelete]
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\.buffer.json"
Type: files; Name: "{app}\.status"
Type: files; Name: "{app}\.cmd"
Type: files; Name: "{app}\.lock"
Type: files; Name: "{app}\agent.log"
Type: dirifempty; Name: "{app}"

[Code]
var TokenPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  TokenPage := CreateInputQueryPage(wpSelectDir,
    'Token de Nova', 'Conecta el agente con tu cuenta de Nova',
    'Pega tu token de Nova (en Nova > Time Tracking > Fuentes de actividad > Conectar). Se guarda unicamente en tu equipo, en config.json.');
  TokenPage.Add('Token:', False);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = TokenPage.ID then begin
    if Trim(TokenPage.Values[0]) = '' then begin
      MsgBox('Pega tu token de Nova para continuar.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var cfg, token: string;
begin
  if CurStep = ssPostInstall then begin
    token := Trim(TokenPage.Values[0]);
    cfg :=
      '{' + #13#10 +
      '  "apiBase": "https://api.kiwoc.com/api",' + #13#10 +
      '  "webUrl": "https://enricher.kiwoc.com",' + #13#10 +
      '  "token": "' + token + '",' + #13#10 +
      '  "pollSeconds": 15,' + #13#10 +
      '  "idleThresholdSeconds": 60,' + #13#10 +
      '  "minSegmentSeconds": 15,' + #13#10 +
      '  "flushSeconds": 60' + #13#10 +
      '}';
    SaveStringToFile(ExpandConstant('{app}\config.json'), cfg, False);
  end;
end;
