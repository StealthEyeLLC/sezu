import json, os, pathlib, shutil, subprocess
ROOT=pathlib.Path('/tmp/sezu-phase4-workspace')

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r

shutil.rmtree(ROOT,ignore_errors=True)
(ROOT/'.sezu/skills/project-echo').mkdir(parents=True)
(ROOT/'.sezu/macros').mkdir(parents=True)
(ROOT/'.sezu/workspace.yaml').write_text('''name: phase4-workspace
default_target: u
terminals:
  - phase4-workspace-lane
browser_profile: phase4-browser
skills:
  - system-summary
  - project-echo
packs:
  - sezu-core
task_template: task-default
macros:
  - phase4-sequential
  - phase4-parallel
''')
(ROOT/'.sezu/skills/project-echo/skill.json').write_text(json.dumps({
  'name':'project-echo','version':'0.1.0','description':'Phase 4 project-local skill',
  'entrypoint':'entrypoint.sh','default_target':'host','required_packs':[],'assets':[],'environment':{}
},indent=2))
(ROOT/'.sezu/skills/project-echo/entrypoint.sh').write_text('#!/bin/bash\nset -euo pipefail\nprintf "project-skill:%s\\n" "$1"\n')
os.chmod(ROOT/'.sezu/skills/project-echo/entrypoint.sh',0o755)
(ROOT/'.sezu/macros/phase4-sequential.json').write_text(json.dumps({
 'name':'phase4-sequential','description':'sequential two-target macro','mode':'sequential','steps':[
   {'operation':'sezu.exec','target':'host','args':{'argv':['/bin/printf','macro-host']}},
   {'operation':'sezu.exec','target':'u','args':{'argv':['/bin/printf','macro-u']},'depends_on':[0]}
 ]},indent=2))
(ROOT/'.sezu/macros/phase4-parallel.json').write_text(json.dumps({
 'name':'phase4-parallel','description':'parallel two-target macro','mode':'parallel','steps':[
   {'operation':'sezu.exec','target':'host','args':{'argv':['/bin/printf','parallel-host']}},
   {'operation':'sezu.exec','target':'u','args':{'argv':['/bin/printf','parallel-u']}}
 ]},indent=2))
opened=call('sezu.workspace.open',{'path':str(ROOT),'create_terminals':True})
assert opened['result']['name']=='phase4-workspace'
resolved=call('sezu.exec',{'argv':['/bin/hostname']})
assert resolved['target']=='u' and resolved['stdout'].strip()=='u',resolved
skills=call('sezu.skill.list')['result']['skills']
assert {'system-summary','project-echo'} <= {x['name'] for x in skills}
builtin=call('sezu.skill.run',{'name':'system-summary','input':{'target':'u'}},'host')
assert builtin['ok'] and 'hostname=u' in builtin['stdout'],builtin
project=call('sezu.skill.run',{'name':'project-echo','input':{'message':'ok'}},'host')
assert 'project-skill:' in project['stdout'],project
macros=call('sezu.macro.list')['result']['macros']
assert {'phase4-sequential','phase4-parallel'} <= {x['name'] for x in macros}
seq=call('sezu.macro.run',{'name':'phase4-sequential'})
par=call('sezu.macro.run',{'name':'phase4-parallel'})
assert seq['ok'] and par['ok'],(seq,par)
call('sezu.terminal.delete',{'name':'phase4-workspace-lane'})
call('sezu.workspace.close',{})
call('sezu.workspace.delete',{'name':'phase4-workspace'})
shutil.rmtree(ROOT,ignore_errors=True)
print(json.dumps({'ok':True,'default_target':resolved['target'],'skills':['system-summary','project-echo'],'macros':['phase4-sequential','phase4-parallel']}))
