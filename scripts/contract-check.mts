// Both writers execute the same independently expected cases, then each decodes the other's bytes.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as Y from '../packages/deck/node_modules/yjs/dist/yjs.mjs';
import { jsonToDoc, docToJson, applyOps, DeckError } from '../packages/deck/src/index.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const cases=['normalize','ops'].flatMap(kind=>{
 const dir=resolve(root,'fixtures/contract',kind);
 const names=readdirSync(dir).filter(n=>n.endsWith('.json')).sort();
 assert.ok(names.length,`${kind} cases missing`);
 return names.map(name=>{const value=JSON.parse(readFileSync(resolve(dir,name),'utf8'));assert.equal(value.name,name.slice(0,-5));return value;});
});
function rust(requests:unknown[]) {
 const run=spawnSync('cargo',['run','--quiet','-p','present-deck','--example','contract_bridge'],{
  cwd:root,input:JSON.stringify(requests),encoding:'utf8',maxBuffer:32*1024*1024,
  env:{...process.env,CARGO_TARGET_DIR:resolve(root,'target'),CARGO_BUILD_JOBS:'4',CARGO_INCREMENTAL:'0'},
 });
 assert.equal(run.status,0,run.stderr);
 return JSON.parse(run.stdout) as {json?:unknown;update?:string;error?:string}[];
}
const rs=rust(cases);const tsUpdates:{decode:string}[]=[];const successes:unknown[]=[];
for(const [i,c] of cases.entries()) {
 let doc:Y.Doc|undefined;
 try {
  doc=jsonToDoc(c.input??c.start);
  if(c.ops){const before=Y.encodeStateAsUpdate(doc);try{applyOps(doc,c.ops);}catch(e){assert.deepEqual(Y.encodeStateAsUpdate(doc),before,`${c.name}: atomicity`);throw e;}}
  assert.equal(c.expectError,undefined,`${c.name}: TS accepted invalid input`);
  assert.deepEqual(docToJson(doc),c.expect,`${c.name}: TS output`);
  assert.deepEqual(rs[i]!.json,c.expect,`${c.name}: Rust output ${rs[i]!.error??''}`);
  const other=new Y.Doc();Y.applyUpdate(other,Buffer.from(rs[i]!.update!,'base64'));
  assert.deepEqual(docToJson(other),c.expect,`${c.name}: TS decodes Rust`);other.destroy();
  tsUpdates.push({decode:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});successes.push(c);
 } catch(e) {
  if(!(e instanceof DeckError))throw e;
  assert.equal(e.code,c.expectError?.code,`${c.name}: TS error`);
  assert.ok(e.message&&e.hint,`${c.name}: actionable error`);
  assert.equal(rs[i]!.error,c.expectError.code,`${c.name}: Rust error`);
 } finally {doc?.destroy();}
}
const decoded=rust(tsUpdates);
for(const [i,c] of (successes as {name:string;expect:unknown}[]).entries())assert.deepEqual(decoded[i]!.json,c.expect,`${c.name}: Rust decodes TS`);
console.log(`Contract gate passed: ${cases.length} shared cases; ${successes.length} successful documents exchanged in both directions.`);
