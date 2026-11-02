"""Build a clean distribution; personal/local files are never copied."""
import hashlib,json,sys,zipfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
lock=json.loads((root/'package-lock.json').read_text(encoding='utf-8'))
dev_roots=[name+'/' for name,meta in lock['packages'].items() if name and meta.get('dev')]
target=Path(sys.argv[1]) if len(sys.argv)>1 else root.parent/f'video-sense-{version}-portable.zip'
files={}
for folder in ['src','vendor','tools','skills','node_modules']:
    for p in (root/folder).rglob('*'):
        if p.is_file() and not {'work','.git','__pycache__'}.intersection(p.parts) and p.suffix not in ['.pyc','.log']:
            name=p.relative_to(root).as_posix()
            if name=='node_modules/.package-lock.json' or any(name.startswith(prefix) for prefix in dev_roots):continue
            files[name]=p
for name in ['package.json','package-lock.json','LICENSE','THIRD_PARTY.md','UPSTREAM.json','MCP-GUIDE.md','AUDIO-TEXT.md','start.cmd','configure.ps1','install.ps1','config/asr.example.json','config/codex-hooks.example.json']:
    files[name]=root/name
for name in ['README.md','README.en.md','PORTABLE-README.md','CHANGELOG.md']:
    files[name]=root/name
for name,p in files.items():
    assert '.local.' not in name and not name.endswith(('runtime-location.json','client-config.json','mcp.json','mcp.toml')),name
    if p.suffix in ['.json','.mjs','.js','.md','.ps1','.cmd','.toml','.yaml','.txt']:
        text=p.read_text(encoding='utf-8-sig',errors='replace').replace('\\\\','/').replace('\\','/').lower()
        assert 'c:/users/justin' not in text,'Developer path in '+name
with zipfile.ZipFile(target,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for name,p in sorted(files.items()):z.write(p,'video-sense/'+name)
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None
    for name,p in files.items():assert z.read('video-sense/'+name)==p.read_bytes(),name
digest=hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix('.sha256').write_text(digest+'  '+target.name+'\n',encoding='ascii')
print(json.dumps({'file':str(target),'version':version,'files':len(files),'bytes':target.stat().st_size,'sha256':digest}))
