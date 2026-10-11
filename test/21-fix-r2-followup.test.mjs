/** R2-06/07 external-behaviour regressions. All runners are in-process fakes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Redactor, REDACTION_PLACEHOLDER as MASK} from '../dist/src/redact.js';
import {JobManager} from '../dist/src/jobs.js';
import {loadConfig} from '../dist/src/config.js';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const TASK='neutral followup task\n',sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(name,{literals=[],fail=null,cleanup='ordinary cleanup'}={}) {
  const dir=fs.mkdtempSync(path.join(ROOT,'test/.tmp/r3-'+name+'-'));
  for(const part of ['state','tasks','impl','source','snapshot','reports'])fs.mkdirSync(path.join(dir,part));
  fs.writeFileSync(path.join(dir,'source/module.js'),'export const value=1;\n');
  const raw={server:{logLevel:'error'},stateDir:path.join(dir,'state'),taskFileRoots:[path.join(dir,'tasks')],workspaces:{impl:{dir:path.join(dir,'impl'),allowedModes:['implement']},source:{dir:path.join(dir,'source'),allowedModes:['fix']},audit:{dir:path.join(dir,'snapshot'),allowedModes:['audit'],audit:{sourceWorkspaceId:'source',reportDir:path.join(dir,'reports')}}},runner:{type:'fake',fake:{command:process.execPath,argsPrefix:[]},production:{command:process.execPath,argsPrefix:[],profile:'headless'}},redaction:{extraLiteralSecrets:literals},limits:{defaultTimeoutSeconds:5,minTimeoutSeconds:1,maxTimeoutSeconds:3600,perStreamCaptureCapBytes:4096,resultPageMaxBytes:4096},cleanup:{confirmTimeoutMs:100,killTimeoutMs:100}};
  const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify(raw));
  const cfg=loadConfig(configFile,{}),control={starts:0,alive:false,events:null};
  const runner={type:'fake',describe:()=>({type:'fake',available:true,diagnostic:null,commandTemplate:'neutral display',details:{}}),start(_spec,events){control.starts++;control.events=events;if(fail!==null)throw Error(fail);control.alive=true;return {child:null,command:['neutral display'],kill:async()=>{control.alive=false;events.onExit(null,'SIGTERM');return {method:'offline-fake',killed:true,exited:true,detail:cleanup};}};}};
  let manager=new JobManager(cfg,runner);manager.init();
  const taskFile=path.join(dir,'tasks/task.md');fs.writeFileSync(taskFile,TASK);
  const input={requestId:name+'-request',workspaceId:'impl',mode:'implement',taskFile,timeoutSeconds:5};
  return {dir,cfg,control,input,get manager(){return manager;},record(id){return JSON.parse(fs.readFileSync(path.join(dir,'state/jobs',id,'job.json')));},async exit(){if(control.alive){control.alive=false;control.events.onExit(0,null);}await tick();},async restart(){await manager.shutdown();manager=new JobManager(cfg,runner);manager.init();},async close(){if(control.alive){control.alive=false;control.events.onExit(0,null);}await manager.shutdown();}};
}
fs.mkdirSync(path.join(ROOT,'test/.tmp'),{recursive:true});

const headers=[
  ["Authorization: Token 'DUMMY_QUOTED_CREDENTIAL_1234567'\n",'DUMMY_QUOTED_CREDENTIAL_1234567'],
  ['Authorization: Token "DUMMY_DOUBLE_CREDENTIAL_1234567"\n','DUMMY_DOUBLE_CREDENTIAL_1234567'],
  [String.raw`Authorization: Token \"DUMMY_SERIALIZED_CREDENTIAL_1234567\"`+'\n','DUMMY_SERIALIZED_CREDENTIAL_1234567'],
  ['{"Authorization": "Token DUMMY_JSON_CREDENTIAL_1234567"}\n','DUMMY_JSON_CREDENTIAL_1234567'],
  [String.raw`{\"Authorization\": \"Token DUMMY_ESCAPED_CREDENTIAL_1234567\"}`+'\n','DUMMY_ESCAPED_CREDENTIAL_1234567'],
  ["authorization: tOkEn 'a'\n",'a'],
  ['Authorization: ApiKey abc\n','abc'],
  ['Authorization: Token "a b"\n','a b'],
  ["Authorization: Digest username='u', response='DUMMY_DIGEST_CREDENTIAL_1234567'\n",'DUMMY_DIGEST_CREDENTIAL_1234567'],
  ["Authorization: Token 'DUMMY_UNCLOSED_CREDENTIAL_1234567\n",'DUMMY_UNCLOSED_CREDENTIAL_1234567'],
];
test('R2-06 quoted, serialized and short header values are credentials, prose remains readable',()=>{
  const redactor=new Redactor({});
  for(const [line,credential] of headers){const out=redactor.redact(line);if(credential.length>3)assert.ok(!out.includes(credential),JSON.stringify(out));assert.ok(out.includes(MASK));assert.equal(out.split(MASK).length,2);}
  assert.equal(redactor.redact("authorization: tOkEn 'a'\n"),`authorization: tOkEn ${MASK}\n`);
  assert.equal(redactor.redact('Authorization: ApiKey abc\n'),`Authorization: ApiKey ${MASK}\n`);
  assert.equal(redactor.redact("failure (Authorization: Token 'abc') in stage launch\n"),`failure (Authorization: Token ${MASK}) in stage launch\n`);
  for(const text of ['Authorization:\n','Authorization: none\n','the Authorization header is absent\n','token budget abc\n'])assert.equal(redactor.redact(text),text);
});
test('R2-06 byte-split capture, stdout/stderr disk, result and restart all mask quoted credentials',async()=>{
  const fx=fixture('quoted-stream');try{const ack=await fx.manager.submit(fx.input);await tick();
    const input=headers.filter(([,value])=>value.length>3).map(([line])=>line).join('');
    for(const byte of Buffer.from(input)){fx.control.events.onStdout(Buffer.from([byte]));fx.control.events.onStderr(Buffer.from([byte]));}
    await fx.exit();
    for(const stream of ['stdout','stderr']){const result=fx.manager.result(ack.jobId,{stream,limit:10000});for(const [,value] of headers.filter(([,value])=>value.length>3))assert.ok(!result.page.output.includes(value));assert.equal(fs.readFileSync(result.output[stream+'Log'],'utf8'),result.page.output);}
    await fx.restart();assert.equal(fx.manager.status(ack.jobId).status,'completed');assert.ok(!fx.manager.result(ack.jobId).page.output.includes('DUMMY_'));
  }finally{await fx.close();}
});
test('R2-06 failed-launch diagnostics mask quoted credentials without configured literals',async()=>{
  const credential='DUMMY_LAUNCH_CREDENTIAL_1234567',fx=fixture('quoted-failure',{fail:`failure (Authorization: Token '${credential}') in stage launch`});
  try{const ack=await fx.manager.submit(fx.input);await tick();const view=fx.manager.status(ack.jobId),disk=fx.record(ack.jobId);assert.equal(view.error.code,'SPAWN_FAILED');assert.ok(view.error.message.includes('stage launch'));assert.ok(!view.error.message.includes(credential));assert.equal(disk.errorMessage,view.error.message);assert.ok(!JSON.stringify(fx.manager.result(ack.jobId)).includes(credential));}finally{await fx.close();}
});
test('reserved redaction marker is stable for repeated diagnostic gates and colliding short literals',()=>{
  for(const literal of ['*','R','REDACTED','j']){const r=new Redactor({},{extraLiteralSecrets:[literal]});const once=r.redact('diagnostic '+literal);assert.equal(r.redact(once),once);assert.equal(r.redact(MASK),MASK);}
});
for(const literal of ['completed','j','impl','fake','inline','2026',sha(TASK)])test('R2-07 machine fields survive configured literal collision: '+literal,async()=>{
  const fx=fixture('collision-'+literal.slice(0,10),{literals:[literal]});
  try{const ack=await fx.manager.submit(fx.input);await tick();await fx.exit();const disk=fx.record(ack.jobId),view=fx.manager.status(ack.jobId);
    assert.equal(disk.jobId,ack.jobId);assert.equal(disk.requestId,fx.input.requestId);assert.equal(disk.status,'completed');assert.equal(disk.mode,'implement');assert.equal(disk.workspaceId,'impl');assert.equal(disk.workspaceDir,path.join(fx.dir,'impl'));assert.equal(disk.runnerType,'fake');assert.equal(disk.promptKind,'inline');assert.equal(disk.taskFileOriginal,fx.input.taskFile);assert.equal(disk.taskFileSha256,sha(TASK));assert.equal(disk.taskArgSha256,sha(TASK));assert.match(disk.requestHash,/^[a-f0-9]{64}$/);assert.equal(view.task.sha256,sha(TASK));assert.equal(fs.readFileSync(disk.taskFileAccepted,'utf8'),TASK);
    assert.equal(disk.stdoutLog,path.join(fx.dir,'state/jobs',ack.jobId,'stdout.log'));assert.equal(Number.isFinite(Date.parse(disk.createdAt)),true);assert.equal(Number.isFinite(Date.parse(disk.endedAt)),true);
    await fx.restart();assert.deepEqual(fx.manager.health().integrity.unreadableJobs,[]);assert.equal(fx.manager.status(ack.jobId).status,'completed');const repeat=await fx.manager.submit(fx.input);assert.equal(repeat.jobId,ack.jobId);assert.equal(repeat.reusedExistingJob,true);assert.equal(fx.control.starts,1);assert.deepEqual(fx.record(ack.jobId),disk);
  }finally{await fx.close();}
});
test('R2-07 error code collision stays structural while diagnostic message is redacted',async()=>{
  const fx=fixture('error-code',{literals:['SPAWN_FAILED'],fail:'SPAWN_FAILED ordinary diagnostic'});try{const ack=await fx.manager.submit(fx.input);await tick();const view=fx.manager.status(ack.jobId),disk=fx.record(ack.jobId);assert.equal(view.status,'failed');assert.equal(view.error.code,'SPAWN_FAILED');assert.equal(disk.errorCode,'SPAWN_FAILED');assert.equal(view.error.message,`${MASK} ordinary diagnostic`);assert.equal(disk.errorMessage,view.error.message);await fx.restart();assert.equal(fx.manager.status(ack.jobId).error.code,'SPAWN_FAILED');}finally{await fx.close();}
});
test('R2-07 audit record and report preserve identity, policy, paths and manifest digests',async()=>{
  const fx=fixture('audit-machine',{literals:['j','completed','source','refresh','deny-list']});try{const ack=await fx.manager.submit({...fx.input,workspaceId:'audit',mode:'audit'});await tick();const before=fx.record(ack.jobId);await fx.exit();const disk=fx.record(ack.jobId),view=fx.manager.status(ack.jobId),report=JSON.parse(fs.readFileSync(disk.audit.reportPath));
    assert.equal(disk.status,'completed');assert.equal(report.jobId,ack.jobId);assert.equal(report.requestId,fx.input.requestId);assert.equal(report.status,'completed');assert.equal(report.workspaceId,'audit');assert.equal(report.sourceDir,path.join(fx.dir,'source'));assert.equal(report.snapshotDir,path.join(fx.dir,'snapshot'));assert.deepEqual(report.policy,fx.cfg.audit.include.length?disk.audit.policy:before.audit.policy);
    assert.equal(disk.audit.sourceWorkspaceId,'source');assert.equal(disk.audit.snapshotRefresh,'refresh');assert.equal(disk.audit.policy.mode,'deny-list');assert.deepEqual(disk.audit.sourceManifestBefore,before.audit.sourceManifestBefore);assert.deepEqual(report.sourceManifestBefore,disk.audit.sourceManifestBefore);assert.deepEqual(report.sourceManifestAfter,disk.audit.sourceManifestAfter);assert.match(report.sourceManifestAfter.digest,/^[a-f0-9]{64}$/);assert.equal(report.sourceManifestBefore.digest,report.sourceManifestAfter.digest);assert.equal(view.audit.sourceStable,true);assert.ok(disk.audit.findings[0].includes(MASK));assert.deepEqual(report.findings,disk.audit.findings);
    await fx.restart();assert.deepEqual(fx.manager.status(ack.jobId).audit.policy,disk.audit.policy);assert.deepEqual(fx.manager.health().integrity.unreadableJobs,[]);
  }finally{await fx.close();}
});
test('R2-07 cleanup codes remain exact while quoted diagnostic detail is redacted',async()=>{
  const secret='DUMMY_CLEANUP_CREDENTIAL_1234567',fx=fixture('cleanup-machine',{literals:['cancel','offline-fake','SIGTERM'],cleanup:`Authorization: Token '${secret}'`});try{const ack=await fx.manager.submit(fx.input);await tick();const view=await fx.manager.cancel(ack.jobId),disk=fx.record(ack.jobId);assert.equal(view.status,'cancelled');assert.equal(view.signal,'SIGTERM');assert.equal(view.cleanup.reason,'cancel');assert.equal(view.cleanup.method,'offline-fake');assert.equal(view.cleanup.confirmed,true);assert.ok(!view.cleanup.detail.includes(secret));assert.equal(disk.cleanup.detail,view.cleanup.detail);assert.equal(disk.cleanup.method,'offline-fake');await fx.restart();assert.equal(fx.manager.status(ack.jobId).cleanup.method,'offline-fake');}finally{await fx.close();}
});
test('R2-07 viewing older terminal diagnostics redacts them without rewriting the record',async()=>{
  const secret='DUMMY_LEGACY_CREDENTIAL_1234567',fx=fixture('legacy-view');try{const ack=await fx.manager.submit(fx.input);await tick();await fx.exit();await fx.manager.shutdown();const file=path.join(fx.dir,'state/jobs',ack.jobId,'job.json'),record=fx.record(ack.jobId);record.errorCode='SPAWN_FAILED';record.errorMessage=`Authorization: Token '${secret}'`;fs.writeFileSync(file,JSON.stringify(record));const bytes=fs.readFileSync(file);await fx.restart();assert.ok(!fx.manager.status(ack.jobId).error.message.includes(secret));assert.ok(!JSON.stringify(fx.manager.result(ack.jobId)).includes(secret));assert.deepEqual(fs.readFileSync(file),bytes);}finally{await fx.close();}
});
