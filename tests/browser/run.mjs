// Uses only its own disposable container; accepts an image, never a target URL.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {verifyHandlers} from './handlers.mjs';
const image = process.argv[2] || 'zerotier-planet:ci-test';
if (image.startsWith('-') || image.includes('://')) throw new Error('Expected a local Docker image tag');
const name = 'planet-browser-' + randomUUID();
const network = name + '-net';
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', timeout:60000, stdio:['ignore','pipe','pipe']}).trim();
let browser, createdNetwork = false, createdContainer = false;
const pass = text => console.log('PASS: ' + text);
try {
  docker('network','create',network); createdNetwork = true;
  docker('create','--pull','never','--cpus','2','--memory','2g','--memory-swap','2g','--pids-limit','256','--name',name,'--network',network,'-p','127.0.0.1::3443',
    '-e','IP_ADDR4=198.51.100.10','-e','HTTP_HOST=0.0.0.0',
    '-v','/var/lib/zerotier-one','-v','/app/config','-v','/app/dist','-v','/var/lib/ztncui',image);
  createdContainer = true; docker('start',name);
  await verifyHandlers(docker('exec',name,'cat','/opt/ztncui/src/controllers/networkController.js'));
  const binding = JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['3443/tcp'][0];
  assert.equal(binding.HostIp,'127.0.0.1');
  const base = 'http://127.0.0.1:' + binding.HostPort;
  let ready = false;
  for(let i=0;i<90;i++) {
    try {if ((await fetch(base+'/login',{signal:AbortSignal.timeout(1500)})).ok) {ready=true;break;}} catch {}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(ready,'disposable UI must start');
  browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  const context = await browser.newContext({viewport:{width:1365,height:900}});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/login?lang=en');
  await page.locator('#username').fill('admin'); await page.locator('#password').fill('password');
  await page.locator('button[type=submit]').click();
  if (/\/users\/admin\/password$/.test(page.url())) {
    await page.locator('#password1').fill('BrowserRegressionPassword123!');
    await page.locator('#password2').fill('BrowserRegressionPassword123!');
    await page.locator('button[type=submit]').click();
  }
  await page.goto(base+'/controller');
  await page.goto(base+'/controller/network/create'); await page.locator('#name').fill('Browser regression');
  await Promise.all([page.waitForURL(/\/network\/[a-f0-9]{16}$/),page.locator('button[type=submit]').click()]);
  const detail = page.url(); const nwid = detail.split('/').at(-1);
  await page.goto(detail+'/easy');
  await page.locator('#networkCIDR').fill('10.88.99.0/24'); await page.locator('#networkCIDR').press('Tab');
  await Promise.all([page.waitForNavigation(),page.locator('button[type=submit]').click()]);
  await page.reload(); assert.equal(await page.locator('#poolStart').inputValue(),'10.88.99.1');
  assert.equal(await page.locator('#poolEnd').inputValue(),'10.88.99.254');
  for(const [cidr,start,end] of [['10.0.0.0/31','10.0.0.1','10.0.0.2'],['10.0.0.0/24.5','10.0.0.1','10.0.0.2'],['10.0.0.0/24','10.0.0.5','10.0.0.2']]) {
    await page.locator('#networkCIDR').fill(cidr); await page.locator('#networkCIDR').press('Tab');
    await page.locator('#poolStart').fill(start); await page.locator('#poolEnd').fill(end);
    let posts=0;const listener=req=>{if(req.method()==='POST')posts++;};page.on('request',listener);
    await page.locator('button[type=submit]').click(); await page.waitForTimeout(150);page.off('request',listener);
    assert.equal(posts,0,'invalid form must not submit');
    const response=await context.request.post(detail+'/easy',{form:{networkCIDR:cidr,poolStart:start,poolEnd:end}});
    assert.equal(response.status(),400,'direct invalid request must be rejected');
  }
  pass('login, create network, easy setup persistence, browser and HTTP validation');
  await page.goto(detail);
  let renamePosts=0;page.on('request',req=>{if(req.method()==='POST'&&req.url()===detail+'/name')renamePosts++;});
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Cancelled');await page.locator('#name-input').press('Escape');
  await page.waitForTimeout(150);assert.equal(renamePosts,0);await page.reload();assert.equal(await page.locator('#name').textContent(),'Browser regression');
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Renamed');
  await Promise.all([page.waitForResponse(r=>r.url()===detail+'/name'),page.locator('#name-input').press('Enter')]);
  await page.locator('#name-input').waitFor({state:'hidden'});assert.equal(renamePosts,1);
  await page.route('**/network/'+nwid+'/name',route=>route.fulfill({status:503,body:'Injected failure'}));
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Retry preserved');await page.locator('#name-input').press('Enter');
  await page.locator('#name-error').waitFor({state:'visible'});assert.equal(await page.locator('#name-input').inputValue(),'Retry preserved');
  await page.unroute('**/network/'+nwid+'/name');await page.locator('#name-input').press('Enter');await page.locator('#name-input').waitFor({state:'hidden'});
  await page.reload();assert.equal(await page.locator('#name').textContent(),'Retry preserved');
  const invalidRename = await context.request.post(detail+'/name', {form:{name:''}});
  assert.equal(invalidRename.status(),400,'rename validation must reject empty names');
  pass('rename Escape sends nothing, Enter sends once, failed save retains text and retries; backend rejects invalid rename');
  await page.locator('.language-menu a').click();await page.waitForURL('**?lang=zh-CN');
  assert.equal(new URL(page.url()).pathname,new URL(detail).pathname);await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  assert.ok((await context.cookies()).some(cookie=>cookie.value==='zh-CN'));
  await page.locator('.language-menu a').click();await page.waitForURL('**?lang=en');await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  pass('language links, cookies and reload preserve network route');
  // Fixture is created only through the private API inside this test's own container.
  const member='aabbccddee';
  docker('exec',name,'node','-e',`const fs=require('fs');fetch('http://127.0.0.1:'+fs.readFileSync('/var/lib/zerotier-one/zerotier-one.port','utf8').trim()+'/controller/network/${nwid}/member/${member}',{method:'POST',headers:{'X-ZT1-AUTH':fs.readFileSync('/var/lib/zerotier-one/authtoken.secret','utf8').trim(),'Content-Type':'application/json'},body:JSON.stringify({authorized:false,name:'Fixture'})}).then(r=>{if(!r.ok)process.exit(1)})`);
  await page.goto(detail);
  const auth=page.locator('.authCheck[value="'+member+'"]');const memberName=page.locator('.member-name-input[name="'+member+'"]');
  const authResponse = page.waitForResponse(r=>r.url()===detail+'/members' && r.request().method()==='POST');
  await auth.check({force:true});assert.equal((await authResponse).status(),204);await page.waitForFunction(id=>!document.querySelector('.authCheck[value="'+id+'"]').disabled,member);
  await memberName.fill('Browser member');await memberName.press('Tab');await page.waitForFunction(id=>!document.querySelector('.member-name-input[name="'+id+'"]').disabled,member);
  await page.reload();assert.equal(await auth.isChecked(),true);assert.equal(await memberName.inputValue(),'Browser member');
  await memberName.fill('');await memberName.press('Tab');await page.waitForFunction(id=>!document.querySelector('.member-name-input[name="'+id+'"]').disabled,member);
  await page.reload();assert.equal(await memberName.inputValue(),'','cleared member name must persist');
  await page.route('**/network/'+nwid+'/members',route=>route.fulfill({status:503,body:'Injected failure'}));
  await auth.uncheck({force:true});await page.locator('#members-save-status.is-error').waitFor({state:'visible'});assert.equal(await auth.isChecked(),true);
  await page.unroute('**/network/'+nwid+'/members');
  pass('member authorization/name survive reload, failed authorization rolls back with visible feedback');
  await page.setViewportSize({width:390,height:844});await page.reload();
  await page.locator('.navbar-toggle').click();await page.locator('#appNavigation.in').waitFor({state:'visible'});
  await page.locator('#appNavigation a[href="/controller/networks"]').click();await page.waitForURL('**/controller/networks');
  for(const url of [base+'/controller/networks',detail,detail+'/easy']) {
    await page.goto(url);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no page overflow: '+url);
  }
  assert.deepEqual(errors,[],'browser scripts must not throw');pass('390px navigation and network pages have no horizontal page overflow');
  console.log('Resource sample: '+docker('stats','--no-stream','--format','CPU={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}',name));
} finally {
  try {
    if(browser) await browser.close();
  } finally {
    try {
      if(createdContainer) docker('rm','-f','-v',name);
    } finally {
      if(createdNetwork) docker('network','rm',network);
    }
  }
}
