import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newVM } = require('./helpers/nqa-vm.js');

test('optional addon adapters return no data when addons are missing', () => {
  const vm = newVM();
  assert.equal(vm.bool('NS.Integrations.QuestieReady()'), false);
  assert.equal(vm.evaluate('NS.Integrations.AuctionPrice(1234)'), null);
  assert.equal(vm.evaluate('NS.Integrations.AuctionPriceAge(1234)'), null);
});

test('Questie is available only after its public API signals readiness', () => {
  const vm = newVM();
  vm.run(`C_AddOns = { IsAddOnLoaded = function(name) return name == "Questie" end }
    Questie = { API = { isReady = false } }`);
  assert.equal(vm.bool('NS.Integrations.QuestieReady()'), false);
  vm.run('Questie.API.isReady = true');
  assert.equal(vm.bool('NS.Integrations.QuestieReady()'), true);
});

test('Auctionator uses only its public price API, and does not expose bad values', () => {
  const vm = newVM();
  vm.run(`C_AddOns = { IsAddOnLoaded = function(name) return name == "Auctionator" end }
    Auctionator = { API = { v1 = {
      GetAuctionPriceByItemID = function(caller, id)
        assert(caller == "NeverQuestAlone")
        if id == 42 then return 12500 end
        if id == 43 then error("not indexed") end
        return nil
      end,
      GetAuctionAgeByItemID = function(caller, id) return id == 42 and 2 or nil end,
    } } }`);
  assert.equal(vm.num('NS.Integrations.AuctionPrice(42)'), 12500);
  assert.equal(vm.num('NS.Integrations.AuctionPriceAge(42)'), 2);
  assert.equal(vm.evaluate('NS.Integrations.AuctionPrice(43)'), null);
  assert.equal(vm.evaluate('NS.Integrations.AuctionPrice("42")'), null);
});
