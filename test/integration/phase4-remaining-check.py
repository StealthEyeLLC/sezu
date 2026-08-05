import json, pathlib, shutil, subprocess, time

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r
# Templates
catalog=call('sezu.template.list')['result']['templates']
assert len(catalog)==19 and len([x for x in catalog if x['kind']=='service'])==17 and len([x for x in catalog if x['kind']=='task'])==1 and len([x for x in catalog if x['kind']=='vm'])==1
assert all('@sha256:' in x['immutable_reference'] for x in catalog if x['kind']=='service')
for x in catalog: call('sezu.template.inspect',{'template_id':x['template_id']})
name='phase4-template-cell'; subprocess.run(['incus','delete','-f',name,'--project','sezu'],capture_output=True)
call('sezu.template.launch',{'template_id':'task-default','name':name,'start':True,'timeout_ms':180000})
for _ in range(100):
    if call('sezu.cell.status',{'name':name})['result'].get('status')=='Running': break
    time.sleep(.2)
assert call('sezu.exec',{'argv':['/bin/printf','template-ok']},'cell:'+name)['stdout']=='template-ok'
deleted=call('sezu.template.delete-instance',{'name':name,'timeout_ms':180000})
assert deleted['result']['deleted_instance']==name
# Timer
pathlib.Path('/tmp/sezu-phase4-timer-output').unlink(missing_ok=True)
call('sezu.timer.delete',{'name':'phase4-timer'},ok=False)
call('sezu.timer.create',{'name':'phase4-timer','on_active_sec':'1h','enable':False,'operation':'sezu.exec','target':'host','args':{'argv':['/bin/sh','-c','printf timer-ok > /tmp/sezu-phase4-timer-output']}})
assert any(x['name']=='phase4-timer' for x in call('sezu.timer.list')['result']['timers'])
call('sezu.timer.run',{'name':'phase4-timer'})
assert pathlib.Path('/tmp/sezu-phase4-timer-output').read_text()=='timer-ok'
call('sezu.timer.delete',{'name':'phase4-timer'}); pathlib.Path('/tmp/sezu-phase4-timer-output').unlink(missing_ok=True)
# Backup/restore
source=pathlib.Path('/tmp/sezu-phase4-backup-source'); restore=pathlib.Path('/tmp/sezu-phase4-backup-restore')
shutil.rmtree(source,ignore_errors=True); shutil.rmtree(restore,ignore_errors=True); source.mkdir(); (source/'value').write_text('backup-ok')
b=call('sezu.backup.run',{'name':'phase4-backup.tar.gz','resources':[str(source)],'artifact':True})
aid=b['result']['artifact']['artifact_id']; shutil.rmtree(source)
call('sezu.backup.restore',{'artifact_id':aid,'destination':str(restore)})
assert (restore/'tmp/sezu-phase4-backup-source/value').read_text()=='backup-ok'
call('sezu.artifact.delete',{'artifact_id':aid}); shutil.rmtree(restore)
print(json.dumps({'ok':True,'templates':len(catalog),'services':17,'task_launch_delete':True,'timer':True,'backup_restore':True}))
