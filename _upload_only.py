"""Sube UN archivo del backend por SFTP SIN reiniciar PM2.

Para cambios que pueden esperar al siguiente reinicio (así no se cierra la sesión
de la usuaria). El proceso sigue corriendo el código viejo hasta que se reinicie.
"""
import paramiko, sys, os

SERVER, USER, PASSWORD = '45.32.160.165', 'root', '@4EcwuZrv*YN8((#'
REMOTE = '/root/enricher/backend'
LOCAL = r'C:\enricher\backend'

files = sys.argv[1:]
if not files:
    sys.exit('uso: python _upload_only.py services/foo.js [otro.js ...]')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(SERVER, username=USER, password=PASSWORD, timeout=15)
sftp = c.open_sftp()
for f in files:
    lp = os.path.join(LOCAL, f.replace('/', os.sep))
    sftp.put(lp, f'{REMOTE}/{f}')
    print(f'  subido {f} ({os.path.getsize(lp)} bytes)')
sftp.close()

# Confirmar que el archivo remoto es el nuevo (sin reiniciar nada).
for f in files:
    _, out, _ = c.exec_command(f"grep -c 'REGLA PRINCIPAL' {REMOTE}/{f} 2>/dev/null || echo 0")
    print(f'  {f}: marcador nuevo presente -> {out.read().decode().strip()}')
_, out, _ = c.exec_command("pm2 jlist | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).find(x=>x.name==='enricher-backend');console.log('pm2:',p.pm2_env.status,'uptime_min:',Math.round((Date.now()-p.pm2_env.pm_uptime)/60000))})\"")
print(' ', out.read().decode().strip())
c.close()
print('Subido. NO se reinició PM2 — el código nuevo entra en el próximo restart.')
