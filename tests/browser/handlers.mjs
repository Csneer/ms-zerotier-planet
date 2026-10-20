// Execute the image's actual async handlers with failing controller/storage dependencies.
import assert from 'node:assert/strict';
import vm from 'node:vm';
export async function verifyHandlers(source) {
  const rename = source.slice(source.indexOf('exports.name ='), source.indexOf('// MTU GET/POST'));
  const members = source.slice(source.indexOf('exports.members ='), source.indexOf('// Member delete GET'));
  let rejectController = false, rejectStorage = false, saved;
  const controller = {network_object:async()=>{if(rejectController)throw new Error('test unavailable');},member_object:async()=>{if(rejectController)throw new Error('test unavailable');}};
  const scope = {exports:{},zt:controller,storage:{setItem:async(id,name)=>{if(rejectStorage)throw new Error('test unavailable');saved=name;}},console:{error(){}}};
  vm.runInNewContext(rename+'\n'+members,scope);
  function req(body, errors=null) {
    const chain={notEmpty(){return this;},isBoolean(){return this;},trim(){return this;},escape(){return this;}};
    return {method:'POST',params:{nwid:'aabbccddeeff0011'},body,checkBody(){return chain;},sanitize(){return chain;},validationErrors(){return errors;}};
  }
  function res(){return {code:200,ended:false,status(code){this.code=code;return this;},send(){this.ended=true;return this;},end(){this.ended=true;return this;},redirect(){this.code=302;this.ended=true;return this;}};}
  async function check(handler,request,code) {const response=res();await scope.exports[handler](request,response);assert.equal(response.code,code);assert.equal(response.ended,true);}
  await check('name',req({name:'renamed'}),302);
  await check('name',req({name:''},[{msg:'required'}]),400);
  rejectController=true;
  await check('name',req({name:'retry'}),502);
  await check('members',req({id:'aabbccddee',auth:'true'}),502);
  await check('members',req({id:'aabbccddee',activeBridge:'true'}),502);
  rejectController=false;
  await check('members',req({id:'aabbccddee',name:''}),204);assert.equal(saved,'');
  await check('members',req({id:'aabbccddee',auth:'bad'},[{msg:'boolean'}]),400);
  rejectStorage=true;await check('members',req({id:'aabbccddee',name:'retry'}),502);
  console.log('PASS: real image handlers return rename 302/400/502, member 204/400/502 and persist empty names');
}
