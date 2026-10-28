#!/usr/bin/env python3
"""Build the normal bundled UI, rather than serving hundreds of dev modules."""
import hashlib
import json
import os
import subprocess
from setup import ROOT, UP, bun_command

def fingerprint():
    digest=hashlib.sha256()
    for path in sorted((ROOT/'integrations/openrift/web').glob('*.tsx')):
        digest.update(path.name.encode());digest.update(path.read_bytes())
    for name in ['bun.lock','apps/web/vite.config.ts']:
        digest.update((UP/name).read_bytes())
    for directory in [UP/'apps/web/src',UP/'apps/web/messages']:
        for path in sorted(directory.rglob('*')):
            if not path.is_file() or path.suffix not in ('.ts','.tsx','.js','.json','.css'):
                continue
            if 'paraglide' in path.relative_to(directory).parts or path.name=='routeTree.gen.ts' or '.test.' in path.name:
                continue
            digest.update(str(path.relative_to(UP)).encode());digest.update(path.read_bytes())
    digest.update(subprocess.check_output(['git','rev-parse','HEAD'],cwd=UP))
    return digest.hexdigest()

def ensure_build(force=False):
    stamp=ROOT/'.local/web-build.json'
    current=fingerprint()
    if not force and (UP/'apps/web/.output/server/index.mjs').exists() and stamp.exists():
        if json.loads(stamp.read_text()).get('fingerprint')==current:
            return
    bun=bun_command()
    env=dict(os.environ,NODE_USE_ENV_PROXY='1',API_INTERNAL_URL='http://localhost:3000')
    env['PATH']=str(os.path.dirname(bun))+os.pathsep+env.get('PATH','')
    print('Building the bundled OpenRift interface. This is needed only after frontend changes.',flush=True)
    subprocess.run([bun,'--env-file='+str(UP/'.env'),'run','--cwd','apps/web','build'],cwd=UP,env=env,check=True)
    stamp.parent.mkdir(exist_ok=True)
    stamp.write_text(json.dumps({'fingerprint':current}))

if __name__=='__main__':
    ensure_build(force=True)
