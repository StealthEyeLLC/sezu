import json, subprocess, time

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r

name='phase4-incus'; profile='phase4-profile'; volume='phase4-volume'; restored='phase4-volume-restored'; network='phase4-net'; zone='phase4.test'
# Defensive cleanup from interrupted runs.
subprocess.run(['incus','delete','-f',name,'--project','sezu'],capture_output=True)
for v in [volume,restored]: subprocess.run(['incus','storage','volume','delete','sezu-btrfs',v,'--project','sezu'],capture_output=True)
subprocess.run(['incus','profile','delete',profile,'--project','sezu'],capture_output=True)
subprocess.run(['incus','network','delete',network,'--project','sezu'],capture_output=True)
subprocess.run(['incus','network','zone','delete',zone,'--project','sezu'],capture_output=True)
artifacts=[]
try:
    projects=call('sezu.project.list')['result']['items']; assert any((x.get('name') if isinstance(x,dict) else str(x).endswith('/sezu'))=='sezu' for x in projects)
    pools=call('sezu.storage.pool.list')['result']['items']; assert any((x.get('name') if isinstance(x,dict) else str(x).endswith('/sezu-btrfs'))=='sezu-btrfs' for x in pools)
    assert isinstance(call('sezu.remote.list')['result'], (list,dict))
    assert isinstance(call('sezu.certificate.list')['result']['certificates'], list)
    images=call('sezu.image.list')['result']['images']; assert images
    raw=call('sezu.incus.request',{'method':'GET','path':'/1.0','query':{}}); assert raw['result']['metadata']['environment']['server_version']=='6.0.6'
    call('sezu.profile.create',{'name':profile,'description':'Phase 4 temporary profile','config':{'security.nesting':'true'},'devices':{}})
    call('sezu.profile.update',{'name':profile,'values':{'description':'Phase 4 updated profile','config':{'security.nesting':'true'},'devices':{}}})
    call('sezu.cell.create',{'name':name,'type':'container','source':{'type':'image','alias':'sezu-u-golden-0.1.0'},'profiles':['sezu-u-power'],'start':True,'timeout_ms':180000})
    for _ in range(120):
        s=call('sezu.cell.status',{'name':name})['result']
        if s.get('status')=='Running': break
        time.sleep(.25)
    else: raise RuntimeError(f'cell did not run: {s}')
    call('sezu.profile.apply',{'instance':name,'profile':profile})
    inst=call('sezu.incus.request',{'method':'GET','path':f'/1.0/instances/{name}','project':'sezu'})['result']['metadata']; assert profile in inst['profiles']
    call('sezu.volume.create',{'pool':'sezu-btrfs','name':volume,'description':'Phase 4 temporary volume','config':{'size':'64MiB'}})
    call('sezu.volume.attach',{'pool':'sezu-btrfs','volume':volume,'instance':name,'device':'phase4disk','path':'/mnt/phase4'})
    devices=call('sezu.device.list',{'instance':name})['result']['devices']; assert devices['phase4disk']['source']==volume
    call('sezu.device.update',{'instance':name,'device':'phase4disk','config':{'readonly':'false'}})
    call('sezu.exec',{'argv':['/bin/bash','-lc','mkdir -p /mnt/phase4; printf volume-state > /mnt/phase4/value; sync']},'cell:'+name)
    call('sezu.volume.detach',{'instance':name,'device':'phase4disk'})
    exported=call('sezu.volume.backup.export',{'pool':'sezu-btrfs','name':volume,'backup_name':'phase4-backup','timeout_ms':180000})
    artifact=exported['result']['artifact']['artifact_id']; artifacts.append(artifact)
    call('sezu.volume.delete',{'pool':'sezu-btrfs','name':volume,'timeout_ms':180000})
    call('sezu.volume.backup.import',{'pool':'sezu-btrfs','name':restored,'artifact_id':artifact,'timeout_ms':180000})
    vols=call('sezu.volume.list',{'pool':'sezu-btrfs'})['result']['volumes']; assert any((x.get('name') if isinstance(x,dict) else str(x).endswith('/'+restored))==restored for x in vols)
    call('sezu.volume.attach',{'pool':'sezu-btrfs','volume':restored,'instance':name,'device':'phase4restore','path':'/mnt/restore'})
    restored_value=call('sezu.exec',{'argv':['cat','/mnt/restore/value']},'cell:'+name); assert restored_value['stdout']=='volume-state'
    call('sezu.volume.detach',{'instance':name,'device':'phase4restore'})
    call('sezu.volume.delete',{'pool':'sezu-btrfs','name':restored,'timeout_ms':180000})
    call('sezu.network.create',{'name':network,'type':'bridge','description':'Phase 4 temporary network','config':{'ipv4.address':'10.250.44.1/24','ipv4.nat':'true','ipv6.address':'none'}})
    call('sezu.network.update',{'name':network,'values':{'description':'Phase 4 updated network','config':{'ipv4.address':'10.250.44.1/24','ipv4.nat':'true','ipv6.address':'none'}}})
    nets=call('sezu.network.list')['result']['items']; assert any((x.get('name') if isinstance(x,dict) else str(x).endswith('/'+network))==network for x in nets)
    call('sezu.network.delete',{'name':network})
    call('sezu.network.zone.create',{'name':zone,'description':'Phase 4 temporary zone','config':{}})
    call('sezu.network.zone.record.set',{'zone':zone,'name':'www','entries':[{'type':'A','value':'192.0.2.44'}]})
    zones=call('sezu.network.zone.list')['result']['items']; assert any((x.get('name') if isinstance(x,dict) else str(x).endswith('/'+zone))==zone for x in zones)
    call('sezu.network.zone.record.delete',{'zone':zone,'name':'www'})
    call('sezu.network.zone.delete',{'name':zone})
    snap=call('sezu.snapshot.create',{'name':name,'snapshot':'phase4-async','wait':False})
    assert snap['status']=='running' and snap['handle']
    waited=call('sezu.incus.operation.wait',{'operation':snap['handle'],'timeout_ms':180000}); assert waited['ok']
    call('sezu.snapshot.delete',{'name':name,'snapshot':'phase4-async'})
    longop=call('sezu.incus.request',{'method':'POST','path':f'/1.0/instances/{name}/exec','project':'sezu','body':{'command':['/bin/sleep','1'],'wait-for-websocket':False,'record-output':True,'interactive':False}})
    assert longop['handle']
    cancel_result=call('sezu.incus.operation.cancel',{'operation':longop['handle']},ok=False)
    assert not cancel_result['ok'] and cancel_result['error']['code']=='incus_error' and "can't be cancelled" in cancel_result['error']['message']
    call('sezu.incus.operation.wait',{'operation':longop['handle'],'timeout_ms':10000})
    call('sezu.profile.apply',{'instance':name,'profile':profile,'remove':True})
    call('sezu.cell.stop',{'name':name,'force':True,'timeout_ms':180000})
    call('sezu.cell.delete',{'name':name,'timeout_ms':180000})
    call('sezu.profile.delete',{'name':profile})
    for artifact in artifacts: call('sezu.artifact.delete',{'artifact_id':artifact})
    artifacts.clear()
    print(json.dumps({'ok':True,'project_list':True,'profile':True,'volume_backup_restore':True,'network':True,'dns_zone':True,'images':len(images),'raw_incus':True,'async_wait':True,'cancel_semantics':'daemon-reports-non-cancellable'}))
finally:
    subprocess.run(['incus','delete','-f',name,'--project','sezu'],capture_output=True)
    for v in [volume,restored]: subprocess.run(['incus','storage','volume','delete','sezu-btrfs',v,'--project','sezu'],capture_output=True)
    subprocess.run(['incus','profile','delete',profile,'--project','sezu'],capture_output=True)
    subprocess.run(['incus','network','delete',network,'--project','sezu'],capture_output=True)
    subprocess.run(['incus','network','zone','delete',zone,'--project','sezu'],capture_output=True)
    for artifact in artifacts: call('sezu.artifact.delete',{'artifact_id':artifact},ok=False)
