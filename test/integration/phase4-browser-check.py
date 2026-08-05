import json, pathlib, subprocess, time

def call(op,args=None,target=None,ok=True):
    cmd=['sezu',op,'--json','--args-json',json.dumps(args or {})]
    if target: cmd += ['--target',target]
    p=subprocess.run(cmd,text=True,capture_output=True)
    try:r=json.loads(p.stdout)
    except Exception: raise RuntimeError(f'{op} invalid JSON rc={p.returncode} out={p.stdout!r} err={p.stderr!r}')
    if ok and not r.get('ok'): raise RuntimeError(f'{op} failed: {json.dumps(r)}')
    return r

profile='phase4-browser'; imported='phase4-browser-imported'
for name in [profile,imported]: call('sezu.browser.profile.delete',{'name':name},ok=False)
call('sezu.exec',{'argv':['/bin/bash','-lc','rm -rf /tmp/sezu-browser-page; mkdir -p /tmp/sezu-browser-page; cat > /tmp/sezu-browser-page/index.html <<\'EOF\'\n<!doctype html><html><body><h1 id="title">SEZU Browser</h1><input id="field"><button id="button" onclick="localStorage.setItem(\'clicked\',\'yes\')">Click</button></body></html>\nEOF']},'u')
server=call('sezu.job.start',{'argv':['python3','-m','http.server','18080','--bind','127.0.0.1','--directory','/tmp/sezu-browser-page']},'u')
job=server['handle']
for _ in range(50):
    probe=call('sezu.exec',{'argv':['curl','-fsS','http://127.0.0.1:18080/']},'u',ok=False)
    if probe.get('ok'): break
    time.sleep(.1)
else: raise RuntimeError('HTTP server did not start')
call('sezu.browser.profile.create',{'name':profile,'viewport':{'width':1024,'height':768}})
session=call('sezu.browser.open',{'profile':profile,'target':'u'})['handle']
first=call('sezu.browser.run',{'session_id':session,'actions':[
  {'type':'goto','url':'http://127.0.0.1:18080/'},
  {'type':'fill','selector':'#field','value':'persistent-value'},
  {'type':'set_storage','values':{'localStorage':{'phase4':'persisted'}}},
  {'type':'add_cookies','cookies':[{'name':'phase4cookie','value':'present','url':'http://127.0.0.1:18080/'}]},
  {'type':'click','selector':'#button'},
  {'type':'screenshot','name':'phase4-browser.png'}
]},'u')
assert first['ok'] and first['artifacts'],first
call('sezu.browser.close',{'session_id':session})
session2=call('sezu.browser.open',{'profile':profile,'target':'u'})['handle']
second=call('sezu.browser.run',{'session_id':session2,'actions':[
  {'type':'goto','url':'http://127.0.0.1:18080/'},
  {'type':'storage'},
  {'type':'cookies','urls':['http://127.0.0.1:18080/']}
]},'u')
results=second['result']['results']
storage=results[1]['result']; cookies=results[2]['result']
assert storage['localStorage']['phase4']=='persisted' and storage['localStorage']['clicked']=='yes',storage
assert any(c['name']=='phase4cookie' and c['value']=='present' for c in cookies),cookies
call('sezu.browser.close',{'session_id':session2})
exported=call('sezu.browser.profile.export',{'name':profile})
aid=exported['result']['artifact']['artifact_id']
call('sezu.browser.profile.import',{'name':imported,'artifact_id':aid})
assert call('sezu.browser.profile.get',{'name':imported})['result']['name']==imported
for a in first['artifacts']+second['artifacts']:
    call('sezu.artifact.delete',{'artifact_id':a['artifact_id']})
call('sezu.artifact.delete',{'artifact_id':aid})
call('sezu.browser.profile.delete',{'name':profile}); call('sezu.browser.profile.delete',{'name':imported})
call('sezu.job.cancel',{'job_id':job}); call('sezu.job.wait',{'job_id':job,'timeout_ms':10000}); call('sezu.job.delete',{'job_id':job})
call('sezu.file.remove',{'path':'/tmp/sezu-browser-page','recursive':True},'u')
print(json.dumps({'ok':True,'storage':storage['localStorage'],'cookie':'present','export_import':True,'screenshot_artifacts':len(first['artifacts'])}))
