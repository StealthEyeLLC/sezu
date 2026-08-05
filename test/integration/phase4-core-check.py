import base64, hashlib, json, os, pathlib, subprocess, time

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r

def data(r): return r.get('result') or {}
# durable input/output/end state
r=call('sezu.job.start',{'argv':['/bin/bash','-lc','read x; echo "job:$x"; for i in 1 2 3; do echo tick$i; sleep .15; done']},'host')
jid=r['handle']
call('sezu.job.stdin',{'job_id':jid,'data':base64.b64encode(b'hello\n').decode(),'encoding':'base64'})
w=call('sezu.job.wait',{'job_id':jid,'timeout_ms':10000})
assert w['status']=='completed' and w['exit_code']==0,w
page=call('sezu.job.output',{'job_id':jid,'stream':'stdout','offset':0,'limit':65536,'encoding':'base64'})
out=base64.b64decode(data(page)['data'])
assert b'job:hello' in out and b'tick3' in out,out
# process operations + pause/resume/nice/affinity/cgroup/signal
r=call('sezu.job.start',{'argv':['/bin/sleep','60']},'host'); pid=data(r)['pid']; jid2=r['handle']
assert pid
call('sezu.process.list',{},'host'); call('sezu.process.stat',{'pid':pid},'host'); call('sezu.process.tree',{'pid':pid},'host')
call('sezu.process.pause',{'pid':pid},'host'); time.sleep(.1); call('sezu.process.resume',{'pid':pid},'host')
call('sezu.process.renice',{'pid':pid,'nice':5},'host')
cpu=min(os.sched_getaffinity(0)); call('sezu.process.affinity',{'pid':pid,'cpus':str(cpu)},'host')
call('sezu.process.cgroup',{'pid':pid,'cgroup':'sezu-phase4-process','properties':{}},'host')
call('sezu.job.cancel',{'job_id':jid2}); w2=call('sezu.job.wait',{'job_id':jid2,'timeout_ms':10000}); assert w2['status']=='cancelled',w2
# group modes
for mode,steps in [
 ('sequential',[{'operation':'sezu.exec','target':'host','args':{'argv':['/bin/true']}},{'operation':'sezu.exec','target':'u','args':{'argv':['/bin/true']}}]),
 ('parallel',[{'operation':'sezu.exec','target':'host','args':{'argv':['/bin/true']}},{'operation':'sezu.exec','target':'u','args':{'argv':['/bin/true']}}]),
 ('dependency',[{'operation':'sezu.exec','target':'host','args':{'argv':['/bin/true']}},{'depends_on':[0],'operation':'sezu.exec','target':'u','args':{'argv':['/bin/true']}}]),
 ('fanout',[{'operation':'sezu.exec','target':'host','args':{'argv':['/bin/true']}},{'operation':'sezu.exec','target':'u','args':{'argv':['/bin/true']}}])]:
    assert call('sezu.job.group',{'mode':mode,'steps':steps})['ok']
# terminal lifecycle
name='phase4-terminal'
call('sezu.terminal.delete',{'name':name},ok=False) if False else None
r=call('sezu.terminal.create',{'name':name,'cols':100,'rows':30},'host')
call('sezu.terminal.write',{'name':name,'data':base64.b64encode(b'printf TERM_OK\\n\n').decode(),'encoding':'base64'})
time.sleep(.5)
page=call('sezu.terminal.read',{'name':name,'offset':0,'limit':65536,'encoding':'base64'})
tout=base64.b64decode(data(page)['data'])
assert b'TERM_OK' in tout,tout
subprocess.run(['systemctl','restart','sezu-supervisor.service'],check=True)
for _ in range(100):
    if pathlib.Path('/run/sezu/supervisor.sock').exists(): break
    time.sleep(.05)
page_after_restart=call('sezu.terminal.read',{'name':name,'offset':0,'limit':65536,'encoding':'base64'})
assert b'TERM_OK' in base64.b64decode(data(page_after_restart)['data'])
call('sezu.terminal.write',{'name':name,'data':base64.b64encode(b'printf RECONNECTED_OK\n\n').decode(),'encoding':'base64'})
time.sleep(.3)
reconnected=call('sezu.terminal.read',{'name':name,'offset':0,'limit':65536,'encoding':'base64'})
assert b'RECONNECTED_OK' in base64.b64decode(data(reconnected)['data'])
call('sezu.terminal.resize',{'name':name,'cols':120,'rows':40}); call('sezu.terminal.interrupt',{'name':name}); call('sezu.terminal.close',{'name':name}); call('sezu.terminal.open',{'name':name}); call('sezu.terminal.delete',{'name':name})
# files and direct transfer
root='/tmp/sezu-phase4-tree'; subprocess.run(['rm','-rf',root],check=True); pathlib.Path(root+'/nested').mkdir(parents=True)
call('sezu.file.write',{'path':root+'/text.txt','data':'alpha\n','encoding':'utf8'},'host')
blob=bytes(range(256))*8; call('sezu.file.write',{'path':root+'/nested/binary.bin','data':base64.b64encode(blob).decode(),'encoding':'base64'},'host')
call('sezu.file.link',{'target':'text.txt','path':root+'/link','symbolic':True},'host')
assert data(call('sezu.file.stat',{'path':root+'/link'},'host'))['is_symlink']
assert data(call('sezu.file.list',{'path':root,'recursive':True},'host'))['count']>=3
call('sezu.file.copy',{'source':root+'/text.txt','destination':root+'/copy.txt'},'host'); call('sezu.file.move',{'source':root+'/copy.txt','destination':root+'/moved.txt'},'host'); call('sezu.file.chmod',{'path':root+'/moved.txt','mode':'0640'},'host')
call('sezu.transfer.start',{'source':{'target':'host','path':root},'destination':{'target':'u','path':'/tmp/sezu-phase4-tree-u'},'preserve':True})
r=call('sezu.file.read',{'path':'/tmp/sezu-phase4-tree-u/nested/binary.bin','offset':0,'limit':4096,'encoding':'base64'},'u'); assert base64.b64decode(data(r)['data'])==blob
# archives
call('sezu.archive.create',{'source':root,'destination':'/tmp/sezu-phase4.tar.gz','format':'tar.gz'},'host')
call('sezu.archive.extract',{'source':'/tmp/sezu-phase4.tar.gz','destination':'/tmp/sezu-phase4-extract','format':'tar.gz'},'host')
# artifact lifecycle, chunks/range/copy/delete
payload=(b'artifact-data-'*10000); digest=hashlib.sha256(payload).hexdigest()
r=call('sezu.artifact.begin',{'name':'phase4.bin','expected_size':len(payload),'expected_sha256':digest}); up=r['handle']
off=0
for chunk in (payload[:50000],payload[50000:]):
    call('sezu.artifact.upload',{'upload_id':up,'offset':off,'data':base64.b64encode(chunk).decode(),'encoding':'base64'}); off += len(chunk)
r=call('sezu.artifact.finalize',{'upload_id':up}); aid=r['handle']; assert aid=='sha256:'+digest
r=call('sezu.artifact.read',{'artifact_id':aid,'offset':123,'limit':4096,'encoding':'base64'}); assert base64.b64decode(data(r)['data'])==payload[123:123+4096]
call('sezu.artifact.copy',{'artifact_id':aid,'path':'/tmp/sezu-phase4-artifact-copy'},'host'); assert pathlib.Path('/tmp/sezu-phase4-artifact-copy').read_bytes()==payload
call('sezu.artifact.delete',{'artifact_id':aid})
# cleanup
call('sezu.file.remove',{'path':root,'recursive':True},'host'); call('sezu.file.remove',{'path':'/tmp/sezu-phase4-tree-u','recursive':True},'u'); call('sezu.file.remove',{'path':'/tmp/sezu-phase4.tar.gz'},'host'); call('sezu.file.remove',{'path':'/tmp/sezu-phase4-extract','recursive':True},'host'); pathlib.Path('/tmp/sezu-phase4-artifact-copy').unlink(missing_ok=True)
call('sezu.job.delete',{'job_id':jid}); call('sezu.job.delete',{'job_id':jid2})
subprocess.run(['rmdir','/sys/fs/cgroup/sezu-phase4-process'],check=False)
print(json.dumps({'ok':True,'job':jid,'job_output_bytes':len(out),'terminal_bytes':len(tout),'binary_bytes':len(blob),'artifact_bytes':len(payload)}))
