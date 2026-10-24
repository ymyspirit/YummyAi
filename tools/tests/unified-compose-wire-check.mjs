// Explicit local create-only Engine check. Requires an existing private capture;
// no application process, network, provider or persistent data is used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {docker,readRuntime,runtimeDirectory,writePrivate} from '../../tools/scripts/unified-compose.mjs';
import {escapeComposeDollars} from '../../tools/scripts/lib/unified-compose-model.mjs';
const owner=randomUUID(),project='yummyai-wire-'+owner,name=project,file=path.join(runtimeDirectory,'wire-fixture-'+owner+'.json');
let id;
try {
  const {baseline}=await readRuntime();
  const image=baseline.inspections.find(row=>row.Name==='/infra-otel-collector-1').Image;
  assert.equal(Object.keys(baseline.images.find(row=>row.Id===image).Config.Volumes||{}).length,0);
  const expected={image,container_name:name,network_mode:'none',labels:{'yummyai.test.owner':owner},
    environment:{SYNTHETIC_VALUE:'sentinel$plain$$pair${DO_NOT_EXPAND}'},
    command:['$SYNTHETIC_VALUE','literal$$pair','${DO_NOT_EXPAND}'],entrypoint:['/does-not-run','$literal'],
    healthcheck:{test:['CMD-SHELL','test "$SYNTHETIC_VALUE" = "$SYNTHETIC_VALUE"'],interval:'5s'}};
  const encoded=escapeComposeDollars(expected);
  await writePrivate(file,{name:project,services:{wire:encoded}});
  const args=['compose','-p',project,'-f',file];
  const resolved=JSON.parse((await docker([...args,'config','--format','json'])).stdout).services.wire;
  await docker([...args,'create','--no-build','--pull','never']);
  const [created]=JSON.parse((await docker(['inspect',name])).stdout);
  assert.equal(created.Config.Labels['yummyai.test.owner'],owner);
  assert.equal(created.Name,'/'+name);id=created.Id;
  assert.equal(created.State.Running,false); assert.equal(created.Mounts.length,0);
  assert.equal(created.Config.Env.find(row=>row.startsWith('SYNTHETIC_VALUE=')).slice('SYNTHETIC_VALUE='.length),expected.environment.SYNTHETIC_VALUE);
  assert.deepEqual(created.Config.Cmd,expected.command); assert.deepEqual(created.Config.Entrypoint,expected.entrypoint);
  assert.deepEqual(created.Config.Healthcheck.Test,expected.healthcheck.test);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  process.stdout.write(JSON.stringify({createdOnly:true,started:false,environmentExact:true,commandExact:true,entrypointExact:true,healthTestExact:true,
    serializedCommandEncoded:same(resolved.command,encoded.command),serializedCommandLiteral:same(resolved.command,expected.command),
    serializedEntrypointEncoded:same(resolved.entrypoint,encoded.entrypoint),serializedEntrypointLiteral:same(resolved.entrypoint,expected.entrypoint),
    serializedHealthEncoded:same(resolved.healthcheck.test,encoded.healthcheck.test),serializedHealthLiteral:same(resolved.healthcheck.test,expected.healthcheck.test)})+'\n');
} finally {
  if(!id){
    const ids=(await docker(['ps','-a','--filter',`label=yummyai.test.owner=${owner}`,'--format','{{.ID}}'])).stdout.trim().split(/\s+/).filter(Boolean);
    assert.ok(ids.length<=1);
    if(ids.length){
      const [candidate]=JSON.parse((await docker(['inspect',ids[0]])).stdout);
      assert.equal(candidate.Name,'/'+name);assert.equal(candidate.Config.Labels['yummyai.test.owner'],owner);
      assert.equal(candidate.State.Running,false);assert.equal(candidate.Mounts.length,0);id=candidate.Id;
    }
  }
  if(id){await docker(['rm',id]);}
  await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const remaining=(await docker(['ps','-a','--filter',`label=yummyai.test.owner=${owner}`,'--format','{{.ID}}'])).stdout.trim();
  assert.equal(remaining,''); process.stdout.write(JSON.stringify({cleanupVerified:true,fixtureContainers:0,fixtureMounts:0})+'\n');
}
