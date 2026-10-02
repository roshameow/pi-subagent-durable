#!/usr/bin/env bash
# Resume a prepared main session with a side-by-side Pi installation.
# Never stops a process, reloads a worker, or overwrites the global Pi package.
set -euo pipefail
usage() {
  cat <<'EOF'
Usage: pi-safe-upgrade.sh --version EXACT_VERSION --session SESSION_FILE [--dry-run]

First run /agent:prepare-upgrade in the main Pi session, then exit that main Pi.
Workers must be async RMUX tasks with verified notification receiver identities.
The prepare manifest is required; --session alone is NOT a safe task handoff.

PI_SAFE_UPGRADE_ROOT defaults to ~/.local/share/pi-versions.
PI_CODING_AGENT_DIR and PI_AGENT_NOTIFY_DIR must match the prepared session.
--dry-run checks the handoff and prints commands without installing or starting Pi.
EOF
}
version=''; session=''; dry_run=0
while (($#)); do
  case "$1" in
    --version|--session)
      option="$1"; shift
      (($#)) || { usage >&2; exit 2; }
      if [[ "$option" == --version ]]; then version="$1"; else session="$1"; fi
      shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
  echo 'Use an exact Pi version (not latest or a version range).' >&2; exit 2;
}
[[ -n "$session" ]] || { usage >&2; exit 2; }
command -v python3 >/dev/null || { echo 'python3 is required.' >&2; exit 1; }
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
# Validation is read-only. Fail closed if any old main receiver is still alive.
canonical=$(python3 - "$session" "$agent_dir" <<'PY'
import glob, json, os, pathlib, re, sys

def refuse(message):
    raise SystemExit('Unsafe upgrade: ' + message)
def alive(pid):
    try:
        pid = int(pid)
        if pid < 2: return False
        os.kill(pid, 0)
        return True
    except ProcessLookupError: return False
    except PermissionError: return True
    except (ValueError, TypeError): return False

session = pathlib.Path(sys.argv[1]).expanduser().resolve(strict=True)
agent = pathlib.Path(sys.argv[2]).expanduser().resolve()
with session.open() as handle:
    header = json.loads(handle.readline())
sid = header.get('id', '')
if header.get('type') != 'session' or not isinstance(sid, str) or not sid or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in sid):
    refuse('invalid canonical session header')
if 'subagent-task' in session.name:
    refuse('session mirror is not a main session')
manifest_path = agent / 'agent-upgrades' / (sid + '.json')
try:
    manifest = json.loads(manifest_path.read_text())
except (OSError, ValueError):
    refuse('no valid prepare manifest; run /agent:prepare-upgrade before exiting')
if manifest.get('version') != 1 or manifest.get('ready') is not True or manifest.get('parentSessionId') != sid:
    refuse('handoff is not ready; prepare again in the original main session')
if pathlib.Path(manifest.get('parentSessionPath', '')).resolve() != session:
    refuse('prepare manifest points to another session file')
if not isinstance(header.get('cwd'), str) or not pathlib.Path(header['cwd']).is_absolute() or not isinstance(manifest.get('cwd'), str) or not pathlib.Path(manifest['cwd']).is_absolute():
    refuse('missing absolute session/prepare working directory')
if pathlib.Path(header['cwd']).resolve() != pathlib.Path(manifest['cwd']).resolve():
    refuse('session/prepare working directory mismatch')
if not isinstance(manifest.get('taskIds'), list) or not all(isinstance(task, str) and re.fullmatch(r'task-[A-Za-z0-9]+-[A-Za-z0-9]+', task) for task in manifest['taskIds']) or not manifest.get('preparedAt'):
    refuse('incomplete prepare manifest')
if not isinstance(manifest.get('parentPid'), int) or isinstance(manifest['parentPid'], bool) or not 2 <= manifest['parentPid'] <= 2147483647:
    refuse('prepare manifest has no valid original main PID')
if alive(manifest.get('parentPid')):
    refuse('the prepared main Pi is still alive; exit only that main Pi first')
# A main may already have been resumed since preparation. Never open it twice.
for file in glob.glob(str(agent / 'runtime' / '*.jsonl')):
    try:
        with open(file) as handle: registration = json.loads(handle.readline())
        if pathlib.Path(registration.get('sessionPath', '')).resolve() == session and alive(registration.get('pid')):
            refuse('another live main process already opened this session')
    except (OSError, ValueError, TypeError): pass
inbox = pathlib.Path(os.environ.get('PI_AGENT_NOTIFY_DIR', '/tmp/pi-agent-notify'))
# A legacy bootstrap cannot freeze the old parent's tool dispatch. Detect any
# still-live late task, instead of silently trusting an outdated handoff count.
registry_file = inbox / '.active-workers.json'
try:
    workers = json.loads(registry_file.read_text()).get('workers', {})
except FileNotFoundError:
    workers = {}
except (OSError, ValueError):
    refuse('worker registry is unreadable; do not guess whether handoff is complete')
if not isinstance(workers, dict):
    refuse('invalid worker registry')
prepared_tasks = set(manifest['taskIds'])
for task, worker in workers.items():
    if not isinstance(worker, dict): refuse('invalid worker registration')
    belongs = worker.get('parentSessionId') == sid or worker.get('ownerPid', worker.get('pid')) == manifest['parentPid']
    if not belongs or task in prepared_tasks: continue
    if not isinstance(task, str) or not re.fullmatch(r'task-[A-Za-z0-9]+-[A-Za-z0-9]+', task):
        refuse('unsafe worker task ID')
    receiver = inbox / task / '.receiver-identity.json'
    try:
        identity = json.loads(receiver.read_text())
    except (OSError, ValueError):
        refuse('unprepared task has no verifiable receiver: ' + task)
    if identity.get('taskId') != task:
        refuse('unprepared receiver/task mismatch: ' + task)
    if alive(identity.get('pid')):
        refuse('a live task was dispatched after preparation: ' + task + '; handoff is incomplete')
for file in (inbox / '.main-sessions').glob('*.json'):
    try:
        registration = json.loads(file.read_text())
        if registration.get('sessionId') == sid and alive(registration.get('pid')):
            refuse('another live notification receiver owns this session')
    except (OSError, ValueError, TypeError): pass
print(session)
PY
)
install_root="${PI_SAFE_UPGRADE_ROOT:-$HOME/.local/share/pi-versions}"
install_dir="$install_root/$version"
package_dir="$install_dir/node_modules/@earendil-works/pi-coding-agent"
binary="$install_dir/node_modules/.bin/pi"
cwd=$(python3 - "$canonical" <<'PY'
import json, sys
with open(sys.argv[1]) as handle: print(json.loads(handle.readline())['cwd'])
PY
)
[[ -d "$cwd" ]] || { echo "Session working directory is missing: $cwd" >&2; exit 1; }
printf 'Prepared session: %s\nVersioned install: %s\n' "$canonical" "$install_dir"
if ((dry_run)); then
  printf 'Install: '; printf '%q ' npm install --prefix "$install_dir" --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$version"; printf '\n'
  printf 'Resume: cd %q && ' "$cwd"; printf '%q ' "$binary" --session "$canonical"; printf '\n'
  exit 0
fi
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
installed=''
if [[ -f "$package_dir/package.json" ]]; then
  installed=$(python3 - "$package_dir/package.json" <<'PY'
import json, sys
with open(sys.argv[1]) as handle: print(json.load(handle).get('version', ''))
PY
)
fi
if [[ "$installed" != "$version" || ! -x "$binary" ]]; then
  # Do not overwrite an incomplete existing version: a process might be using it.
  if [[ -e "$install_dir" ]]; then
    echo "Refusing to modify an existing incomplete/mismatched installation: $install_dir" >&2
    echo 'Inspect it or choose a different PI_SAFE_UPGRADE_ROOT.' >&2
    exit 1
  fi
  mkdir -p "$install_root"
  staging=$(mktemp -d "$install_root/.install-$version.XXXXXX")
  trap '[[ -z "${staging:-}" ]] || rm -rf -- "$staging"' EXIT
  npm install --prefix "$staging" --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$version"
  [[ -x "$staging/node_modules/.bin/pi" ]] || { echo 'Pi installation has no executable.' >&2; exit 1; }
  # Publishing must never merge into an installation created concurrently.
  python3 - "$staging" "$install_dir" <<'PY'
import os, sys
if os.path.lexists(sys.argv[2]): raise SystemExit('Version directory appeared concurrently; rerun after inspecting it')
os.rename(sys.argv[1], sys.argv[2])
PY
  staging=''
fi
printf 'Starting the new main Pi. Workers are not restarted.\n'
cd "$cwd"
exec "$binary" --session "$canonical"
