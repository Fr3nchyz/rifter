#!/usr/bin/env bash
# Restore an optional subscription login without logging it or replacing a refreshed login.
set +x
[[ -n ${CODEX_AUTH_JSON:-} ]] || exit 0
python3 - <<'PY'
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def restore():
    directory = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    target = directory / 'auth.json'
    if directory.is_symlink() or target.is_symlink():
        raise ValueError('symlink credential path')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    if target.exists():
        if not stat.S_ISREG(target.stat().st_mode):
            raise ValueError('non-file credential path')
        target.chmod(0o600)
        # CLI refreshes can rotate tokens. Never restore an older environment copy over them.
        return
    data = json.loads(os.environ['CODEX_AUTH_JSON'])
    if not isinstance(data, dict) or data.get('auth_mode') not in (None, 'chatgpt'):
        raise ValueError('not a subscription login')
    tokens = data.get('tokens')
    if (data.get('OPENAI_API_KEY') or not isinstance(tokens, dict)
            or not all(isinstance(tokens.get(k), str) and tokens[k] for k in ('access_token', 'refresh_token'))):
        raise ValueError('missing subscription tokens')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory,
                                         prefix='.auth-import-', delete=False) as file:
            temporary = Path(file.name)
            json.dump(data, file)
            file.flush()
            os.fsync(file.fileno())
        # Atomic create, not replace: a concurrent CLI refresh/import wins safely.
        try:
            os.link(temporary, target)
        except FileExistsError:
            pass
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

try:
    restore()
except Exception:
    # Errors may contain secret fragments. Never print exceptions or the supplied JSON.
    print('Worker credential restore failed; check secret format and credential path permissions.', file=sys.stderr)
    sys.exit(1)
PY
