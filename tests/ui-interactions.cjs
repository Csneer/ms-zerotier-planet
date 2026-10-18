'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const validation = require('../patch/networkValidation');
const uiLanguage = require('../patch/uiLanguage');
for (const cidr of ['10.0.0.0/31', '10.0.0.0/32', '10.0.0.0/24.5', '10.0.0.0/24/x', '256.0.0.0/24', '10.0.0.0/0']) {
  assert.equal(validation.cidr(cidr), null, cidr);
}
for (const [cidr, start, end] of [['10.0.0.0/30', '10.0.0.1', '10.0.0.2'], ['128.0.0.0/1', '128.0.0.1', '255.255.255.254']]) {
  assert.equal(validation.validate({networkCIDR: cidr, poolStart: start, poolEnd: end}), null);
}
for (const [start, end] of [['10.0.0.2','10.0.0.1'], ['10.0.0.0','10.0.0.2'], ['10.0.0.1','10.0.0.255'], ['bad','10.0.0.2'], ['10.0.1.1','10.0.1.2']]) {
  assert.equal(validation.validate({networkCIDR: '10.0.0.0/24', poolStart: start, poolEnd: end}), 'network.invalid_pool');
}
for (const path of ['/', '/controller/network/1234', '/controller/network/1234/easy']) {
  const req = {originalUrl: path + '?lang=zh-CN', path: path.replace('/controller',''), query: {}, cookies: {}};
  const res = {locals: {}};
  uiLanguage(req,res,()=>{});
  req.path = '/changed-by-router';
  assert.equal(res.locals.language_url('en'), path + '?lang=en');
}
// Execute the template's actual rename handlers, including blur when an input is hidden/disabled.
const template = fs.readFileSync(require.resolve('../patch/network_detail.pug'), 'utf8');
const script = template.split('  script.\n')[1].split('\nblock net_content')[0]
  .replace(/!\{JSON.stringify\(network.name[^\n]+/, '"Original";')
  .replace(/!\{JSON.stringify\(t\('common.save_failed'\)\)\}/g, '"Save failed"');
const fields = new Map(); let focused; const requests = [];
function $(arg) {
  if (typeof arg === 'function') { arg(); return; }
  if (!fields.has(arg)) {
    const field = {value:'', visible:true, handlers:{}, props:{},
      on(event, fn) {this.handlers[event] = fn; return this;},
      fire(event,key) {this.handlers[event]?.({key,preventDefault(){}});},
      toggle(show) {this.visible=show; if (!show && focused===this) {focused=null; this.fire('blur');} return this;},
      val(value) {if (value===undefined)return this.value;this.value=value;return this;},
      text(value) {this.label=value;return this;},
      prop(key,value) {this.props[key]=value;if(key==='disabled' && value && focused===this){focused=null;this.fire('blur');}return this;},
      focus() {focused=this;return this;},select(){return this;}};
    fields.set(arg,field);
  }
  return fields.get(arg);
}
$.post = (url,body) => {const callbacks={}; const request={url,body,done(fn){callbacks.done=fn;return this;},fail(fn){callbacks.fail=fn;return this;},always(fn){callbacks.always=fn;return this;},resolve(ok){callbacks[ok?'done':'fail']();callbacks.always();}};requests.push(request);return request;};
vm.runInNewContext(script, {$});
const input=$('#name-input'), link=$('#change-name');
link.fire('click');input.val('Cancelled');input.fire('keydown','Escape');
assert.equal(requests.length,0);assert.equal(input.value,'Original');assert.equal(input.visible,false);
link.fire('click');input.val('Saved');input.fire('keydown','Enter');input.fire('blur');input.fire('keydown','Enter');
assert.equal(requests.length,1);requests[0].resolve(true);assert.equal($('#name').label,'Saved');
link.fire('click');input.val('Retry value');input.fire('blur');requests[1].resolve(false);
assert.equal(input.value,'Retry value');assert.equal(input.visible,true);assert.equal(input.props.disabled,false);assert.equal($('#name-error').props.hidden,false);
input.fire('keydown','Enter');assert.equal(requests.length,3);requests[2].resolve(true);
console.log('PASS: CIDR and pool boundaries, mounted language URLs, rename cancel/deduplication/failure/retry');
// Member saves are serialized per field; a successful second member cannot hide the first failure.
const memberFields = new Map(); const memberRequests = [];
function member$(arg) {
  if (typeof arg === 'function') {arg();return;}
  if (!memberFields.has(arg)) {
    memberFields.set(arg, {handlers:{},attributes:{},
      on(event,fn){this.handlers[event]=fn;return this;},
      attr(key,value){if(value===undefined)return key.startsWith('data-')?key.slice(5):this.attributes[key];this.attributes[key]=value;return this;},
      text(value){this.label=value;return this;},toggleClass(){return this;},
      prop(key,value){arg[key]=value;return this;},hasClass(name){return arg.className===name;}});
  }
  return memberFields.get(arg);
}
member$.post = (url,body) => {const callbacks={}; const req={body,done(fn){callbacks.done=fn;return this;},fail(fn){callbacks.fail=fn;return this;},always(fn){callbacks.always=fn;return this;},resolve(ok){callbacks[ok?'done':'fail']();callbacks.always();}};memberRequests.push(req);return req;};
const memberScript=template.split('    script.\n')[1].split('\n    .table-responsive')[0];
vm.runInNewContext(memberScript, {$:member$});
const changeName=member$('.member-name-input').handlers.change;
const first={name:'first',value:'one',defaultValue:'old'},second={name:'second',value:'two',defaultValue:'old'};
changeName.call(first);changeName.call(first);changeName.call(second);
assert.equal(memberRequests.length,2,'same field cannot have overlapping requests');
memberRequests[0].resolve(false);memberRequests[1].resolve(true);
assert.equal(member$('#members-save-status').label,'failed');
assert.equal(member$(first).attributes['aria-invalid'],'true');
first.value='retry';changeName.call(first);memberRequests[2].resolve(true);
assert.equal(member$('#members-save-status').label,'saved');
assert.equal(first.disabled,false);
console.log('PASS: member request serialization and persistent aggregate failures');
