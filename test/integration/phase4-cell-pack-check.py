import base64, json, pathlib, subprocess, time

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r

name='phase4-cell'; target='cell:'+name
created=call('sezu.cell.create',{'name':name,'type':'container','source':{'type':'image','alias':'sezu-u-golden-0.1.0'},'profiles':['sezu-u-power'],'start':True,'timeout_ms':180000})
for _ in range(120):
    status=call('sezu.cell.status',{'name':name})['result']
    if status.get('status')=='Running': break
    time.sleep(.25)
else: raise RuntimeError(f'cell did not start: {status}')
exec1=call('sezu.exec',{'argv':['/bin/printf','cell-ok']},target); assert exec1['stdout']=='cell-ok'
cell_exec=call('sezu.cell.exec',{'name':name,'argv':['/bin/sh','-c','printf native-cell-exec']})
assert cell_exec['ok']
payload=b'cell-file-bytes\x00\xff'
call('sezu.cell.file.push',{'name':name,'path':'/tmp/phase4-pushed.bin','data':base64.b64encode(payload).decode(),'encoding':'base64'})
pulled=call('sezu.cell.file.pull',{'name':name,'path':'/tmp/phase4-pushed.bin','encoding':'base64'})
assert base64.b64decode(pulled['result']['data'])==payload
call('sezu.exec',{'argv':['/bin/bash','-lc','rm -rf /tmp/phase4-source; mkdir -p /tmp/phase4-source/nested; printf transfer-data > /tmp/phase4-source/nested/value']},'u')
call('sezu.transfer.start',{'source':{'target':'u','path':'/tmp/phase4-source'},'destination':{'target':target,'path':'/tmp/phase4-tree'},'preserve':True})
call('sezu.transfer.start',{'source':{'target':target,'path':'/tmp/phase4-tree'},'destination':{'target':'host','path':'/tmp/sezu-phase4-cell-return'},'preserve':True})
assert pathlib.Path('/tmp/sezu-phase4-cell-return/nested/value').read_text()=='transfer-data'
call('sezu.exec',{'argv':['/bin/sh','-c','printf promoted-output > /tmp/phase4-promote.txt']},target)
promoted=call('sezu.transfer.start',{'source':{'target':target,'path':'/tmp/phase4-promote.txt'},'destination':{'artifact':True}})
aid=promoted['result']['result']['artifact']['artifact_id']
assert call('sezu.artifact.read',{'artifact_id':aid,'offset':0,'limit':100,'encoding':'utf8'})['result']['data']=='promoted-output'
pre=call('sezu.pack.status',{'pack_id':'language-r'},target); assert pre['result']['status']=='not-installed',pre
installed=call('sezu.pack.install',{'pack_id':'language-r','timeout_ms':600000},target)
assert installed['result']['state']=='installed'
versions=call('sezu.exec',{'argv':['/bin/bash','-lc',"dpkg-query -W -f='${Package}=${Version}\\n' r-base r-base-dev; Rscript -e 'cat(6*7)'"]},target)
assert 'r-base=4.3.3-2build2' in versions['stdout'] and 'r-base-dev=4.3.3-2build2' in versions['stdout'] and versions['stdout'].rstrip().endswith('42'),versions
post=call('sezu.pack.status',{'pack_id':'language-r'},target); assert post['result']['status']=='installed'
call('sezu.snapshot.create',{'name':name,'snapshot':'phase4-snapshot'})
snaps=call('sezu.snapshot.list',{'name':name})['result']['snapshots']; assert any('phase4-snapshot' in str(x) for x in snaps)
call('sezu.snapshot.delete',{'name':name,'snapshot':'phase4-snapshot'})
removed=call('sezu.pack.remove',{'pack_id':'language-r','timeout_ms':300000},target); assert removed['result']['state']=='removed'
call('sezu.artifact.delete',{'artifact_id':aid})
call('sezu.file.remove',{'path':'/tmp/phase4-source','recursive':True},'u')
call('sezu.cell.stop',{'name':name,'force':True,'timeout_ms':180000}); call('sezu.cell.delete',{'name':name,'timeout_ms':180000})
pathlib.Path('/tmp/sezu-phase4-cell-return').exists() and subprocess.run(['rm','-rf','/tmp/sezu-phase4-cell-return'],check=True)
print(json.dumps({'ok':True,'cell_exec':'cell-ok','cross_target_transfer':True,'artifact_promotion':True,'pack':'language-r','R':'42','snapshot':True,'cell_deleted':True}))
