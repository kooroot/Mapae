#!/usr/bin/env python3
"""Read-only mini inventory. Never emit process arguments, plist environment or secrets."""
import json, os, pathlib, plistlib, shutil, subprocess

def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()

services = []
for directory, domain in [(pathlib.Path('/Library/LaunchDaemons'), 'system'), (pathlib.Path.home()/'Library/LaunchAgents', f'gui/{os.getuid()}')]:
    for file in sorted(directory.glob('*.plist')):
        try:
            with file.open('rb') as stream:
                data = plistlib.load(stream)
            label = data.get('Label', '')
            if not (label.startswith('io.mapae.') or 'cloudflared' in label):
                continue
            # Only the status words below, never launchctl's Environment or arguments.
            status = command(['/bin/launchctl', 'print', f'{domain}/{label}'])
            fields = {}
            for line in status.splitlines():
                stripped = line.strip()
                for field in ['state', 'pid', 'last exit code']:
                    if stripped.startswith(field + ' = '):
                        fields[field] = stripped.split(' = ', 1)[1]
            services.append({'service': f'{domain}/{label}', 'status': fields or 'not visible in this domain',
                **{k: data.get(k) for k in ['WorkingDirectory', 'StandardOutPath', 'StandardErrorPath', 'RunAtLoad', 'KeepAlive'] if k in data}})
        except (OSError, ValueError, subprocess.TimeoutExpired):
            services.append({'plist': str(file), 'error': 'unreadable'})
ports = []
for port in [3001, 8081, 8082, 8083]:
    pid = command(['/usr/sbin/lsof', '-nP', '-t', f'-iTCP:{port}', '-sTCP:LISTEN']).splitlines()
    ports.append({'port': port, 'pids': [int(p) for p in pid if p.isdigit()]})
disk = shutil.disk_usage(pathlib.Path.home())
print(json.dumps({'services': services, 'listeners': ports, 'freeDiskBytes': disk.free,
                  'freeDiskPercent': round(disk.free / disk.total * 100, 1)}, ensure_ascii=False, indent=2))
