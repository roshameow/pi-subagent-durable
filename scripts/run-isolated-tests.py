#!/usr/bin/env python3
"""Private source/state snapshots; never run npm check against live user state."""
import json, os, pathlib, shutil, subprocess, tempfile
REPO=pathlib.Path(__file__).resolve().parents[1]
OUT=REPO/'artifacts/diagnostics/durable_ghost_20261007/isolated_fix_test_results.json'
# Use an already-installed compiler. No dependency installation/modification.
compiler=next((p for p in [REPO/'node_modules/esbuild/bin/esbuild', REPO.parent/'pi-agent-notify/node_modules/esbuild/bin/esbuild'] if p.exists()),None)
if not compiler: raise SystemExit('local esbuild required')
rows=[]
with tempfile.TemporaryDirectory(prefix='durable-fix-isolated-') as td:
    root=pathlib.Path(td); dest=root/'source';dest.mkdir();bin=root/'bin';bin.mkdir()
    for name in ('rmux','pi','tmux','pkill','killall'):
        f=bin/name;f.write_text('#!/bin/sh\necho "LIVE CLI FORBIDDEN" >&2\nexit 90\n');f.chmod(0o700)
    f=bin/'npx';f.write_text('#!/bin/sh\n[ "$1" = --no-install ] && shift\n[ "$1" = esbuild ] || exit 90\nshift\nexec "'+str(compiler)+'" "$@"\n');f.chmod(0o700)
    for directory in ('extensions','tests','scripts'):shutil.copytree(REPO/directory,dest/directory)
    package=json.loads((REPO/'package.json').read_text())
    package['scripts']['check']=package['scripts']['check'].replace('/tmp/pi-subagent-durable-check',str(root/'bundle'))
    (dest/'package.json').write_text(json.dumps(package))
    (dest/'node_modules').symlink_to(REPO/'node_modules',target_is_directory=True)
    env=dict(os.environ)
    for key in list(env):
        if key.startswith('PI_SUBAGENT_'):env.pop(key)
    env.update(PATH=str(bin)+':'+env['PATH'], HOME=str(root/'home'), PI_CODING_AGENT_DIR=str(root/'agent'),
               PI_AGENT_NOTIFY_DIR=str(root/'notify'),PI_AGENT_NOTIFY_STATE_DIR=str(root/'notify-state'),
               npm_config_offline='true',npm_config_cache=str(root/'npm-cache'),PI_SUBAGENT_TEST_BUILD_DIR=str(root/'bundle'))
    commands=[('bundle',[str(compiler),'extensions/index.ts','extensions/context-inherit.ts','--bundle','--platform=node','--format=esm','--external:@earendil-works/*','--external:@rmux/*','--external:typebox','--outdir='+str(root/'bundle')])]
    commands += [(test.name,[shutil.which('node'),str(test)]) for test in sorted((dest/'tests').glob('*.test.mjs'))]
    commands.append(('full-check',[shutil.which('npm'),'run','check']))
    for name,command in commands:
        try:
            r=subprocess.run(command,cwd=dest,env=env,capture_output=True,text=True,timeout=180 if name=='full-check' else 60)
            headings=[l for l in r.stdout.splitlines() if l.startswith(('OK:','# tests ','# pass ','# fail ','ℹ tests ','ℹ pass ','ℹ fail '))]
            rows.append({'test':name,'exitCode':r.returncode,'summary':headings})
            print(('PASS' if r.returncode==0 else 'FAIL')+': '+name,flush=True)
            if r.returncode:print(r.stderr[-5000:],flush=True)
        except subprocess.TimeoutExpired:rows.append({'test':name,'exitCode':124,'summary':['bounded test timeout']});print('TIMEOUT: '+name,flush=True)
OUT.parent.mkdir(parents=True,exist_ok=True)
OUT.write_text(json.dumps({'tests':rows,'passed':sum(r['exitCode']==0 for r in rows),'total':len(rows),'isolation':'Temporary source, HOME, agent/notify state and blocked live CLIs; read-only dependency links; no installs.'},indent=2)+'\n')
raise SystemExit(0 if all(r['exitCode']==0 for r in rows) else 1)
