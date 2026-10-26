// Production-build browser verification on the final lane, using the existing local Accounts stack.
// Starts only its own processes; every child is stopped on exit. Secrets are read into environment, never logged.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const root=fileURLToPath(new URL('../../',import.meta.url));
const stack=JSON.parse(readFileSync(`${root}/e2e/stack/test-stack.json`,'utf8'));
const data=`${root}/.dev/final`;
mkdirSync(`${data}/bin`,{recursive:true});
const children=[];
const args=process.argv.slice(2);
const withScreens=args.includes('--screens');
const withLiveService=args.includes('--service-live');
const env={...process.env,APP_ID:'present',APP_SECRET:stack.apps.present.app_secret,
 ACCOUNTS_URL:stack.accounts_public_url,ACCOUNTS_API_URL:stack.accounts_api_url,
 APP_API_URL:'http://127.0.0.1:4321',SESSION_SECRET:randomBytes(48).toString('base64'),
 PUBLIC_URL:'http://127.0.0.1:4320',EXTRA_IMG_ORIGINS:'http://127.0.0.1:9745',PORT:'4320'};
env.E2E_SESSION_SECRET=env.SESSION_SECRET;
const converterSecret=randomBytes(32).toString('hex');
function run(command,args,extra={},cwd=root,name=command){
 const out=createWriteStream(`${data}/${name}.log`,{flags:'w',mode:0o600});
 const child=spawn(command,args,{cwd,env:{...env,...extra},detached:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(out);child.stderr.pipe(out);children.push(child);return child;
}
async function free(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
async function ready(url){for(let n=0;n<180;n++){try{const r=await fetch(url);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error(`Not ready: ${url}`);}
function finish(){for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}}}
process.on('SIGTERM',()=>{finish();process.exit(143);});process.on('SIGINT',()=>{finish();process.exit(130);});
try {
 for(const port of [4320,4321,4322,4323])await free(port);
 const db=spawnSync('bash',['scripts/dev-db.sh','create','present_final_codex'],{cwd:root,encoding:'utf8'});if(db.status!==0)throw new Error('Could not create final test database');
 const build=spawnSync('cargo',['build','-q','-p','present-service'],{cwd:root,env:{...process.env,CARGO_TARGET_DIR:`${root}/target`,CARGO_BUILD_JOBS:'4',CARGO_INCREMENTAL:'0'},encoding:'utf8'});if(build.status!==0)throw new Error(build.stderr);
 copyFileSync(`${root}/target/debug/present-service`,`${data}/bin/present-service`);
 run('node',['tools/ting-standin/server.mjs'],{TING_PORT:'4323',TING_APP_ID:'ting',TING_APP_SECRET:stack.apps.ting.app_secret},root,'ting');
 run('node',['node_modules/tsx/dist/cli.mjs','src/server.ts'],{CONVERTER_PORT:'4322',CONVERTER_SECRET:converterSecret},`${root}/renderer`,'converter');
 await Promise.all([ready('http://127.0.0.1:4322/health'),ready('http://127.0.0.1:4323/health')]);
 run(`${data}/bin/present-service`,[],{PRESENT_DATABASE_URL:'postgres://present@127.0.0.1:5490/present_final_codex',PRESENT_BIND:'127.0.0.1:4321',PRESENT_PUBLIC_URL:'http://127.0.0.1:4321',PRESENT_WEB_URL:env.PUBLIC_URL,PRESENT_DATA_DIR:data,PRESENT_APP_SECRET:env.APP_SECRET,PRESENT_IRIS_URL:'http://127.0.0.1:9745',PRESENT_CONVERTER_URL:'http://127.0.0.1:4322',CONVERTER_SECRET:converterSecret,PRESENT_TING_URL:'http://127.0.0.1:4323'},root,'service');
 await ready('http://127.0.0.1:4321/health');
 if(withLiveService){
  await free(4363);
  const test=run('cargo',['test','-p','present-service','--test','live_stack','--test','live_converter','--','--nocapture'],{
   CARGO_TARGET_DIR:`${root}/target`,CARGO_BUILD_JOBS:'4',CARGO_INCREMENTAL:'0',
   PRESENT_LIVE_STACK:'1',PRESENT_LIVE_CONVERTER_URL:'http://127.0.0.1:4322',PRESENT_LIVE_CONVERTER_SECRET:converterSecret,
  },root,'service-live-tests');
  const code=await new Promise((resolve,reject)=>{test.once('error',reject);test.once('exit',resolve);});
  if(code!==0)throw new Error('Live service tests failed; see .dev/final/service-live-tests.log');
 }
 run('node',['node_modules/next/dist/bin/next','start','--port','4320'],{NODE_ENV:'production'},`${root}/web`,'web');
 await ready(`${env.PUBLIC_URL}/robots.txt`);
 console.log('Final lane ready: production web 4320, service 4321, converter 4322, Ting stand-in 4323.');
 const test=run('pnpm',['exec','playwright','test','--project=e2e',...(withScreens?['--project=screens']:[]),...args.filter(a=>!['--screens','--service-live'].includes(a))],{E2E_PORT:'4320',E2E_TING_URL:'http://127.0.0.1:4323'},`${root}/web`,'browser-tests');
 const code=await new Promise((resolve,reject)=>{test.once('error',reject);test.once('exit',resolve);});
 console.log(`Browser suite exited ${code}; results: .dev/final/browser-tests.log`);process.exitCode=code??1;
} catch(error){console.error(error.message);process.exitCode=1;} finally {finish();}
