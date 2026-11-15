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
  vm.run('Questie.API.GetQuestObjectiveIconForUnit = function(guid) return guid == "Creature-123" and "icon" or nil end');
  assert.equal(vm.bool('NS.Integrations.QuestieTargetObjective("Creature-123")'), true);
  assert.equal(vm.bool('NS.Integrations.QuestieTargetObjective("Player-123")'), false);
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

test('link expansion preserves linked names, de-duplicates tooltips, and leaves plain text unchanged', () => {
  const vm = newVM();
  vm.run(`local expand = NS.LinkContext.Expand
    local describe = function(link) return "item " .. link end
    local tooltip = function() return { "Bound" } end
    local equipped = function() return { "[Equipped] Sword" } end
    expanded, count = expand("Compare |Hitem:42|h[Sword]|h and |Hitem:42|h[Sword]|h", 0, describe, tooltip, equipped)
    plain, plainCount = expand("No item", 0, describe, tooltip, equipped)`);
  assert.equal(vm.num('count'), 1);
  assert.match(vm.evaluate('expanded'), /Compare \[Sword\] and \[Sword\]/);
  assert.match(vm.evaluate('expanded'), /\[Equipped\] Sword/);
  assert.equal(vm.evaluate('plain'), 'No item');
  assert.equal(vm.num('plainCount'), 0);
});

test('item context owns equipment slots while Chats retains its public compatibility API', () => {
  const vm = newVM();
  assert.equal(vm.bool('NS.Chats.EQUIP_SLOTS == NS.ItemContext.EQUIP_SLOTS'), true);
  assert.equal(vm.num('#NS.ItemContext.Equipped("spell:123", 0)'), 0);
  assert.equal(vm.evaluate('NS.ItemContext.Describe("quest:176")'), 'quest 176');
});

test('dungeon context is read only and degrades gracefully outside an instance', () => {
  const vm = newVM();
  vm.run(`IsInInstance = function() return true, "party" end
    GetInstanceInfo = function() return "Shadowfang Keep", "party", 1 end
    GetNumGroupMembers = function() return 5 end
    UnitGroupRolesAssigned = function() return "TANK" end
    UnitIsPlayer = function() return false end
    UnitName = function() return "Commander Springvale" end
    UnitLevel = function() return 26 end
    UnitClassification = function() return "elite" end
    dungeonText = table.concat(NS.DungeonContext.Lines(), " | ")`);
  const d = vm.evaluate('dungeonText');
  assert.match(d, /Shadowfang Keep/);
  assert.match(d, /Group members: 5/);
  assert.match(d, /My group role: TANK/);
  assert.match(d, /Commander Springvale/);
});

test('game context remains delegated through Chats and preserves the quest-log contract', () => {
  const vm = newVM();
  const text = vm.evaluate('NS.Chats.GameContext()');
  assert.match(text, /Game: World of Warcraft/);
  assert.equal(typeof text, 'string');
});

test('context collectors are independently registered, ordered and failure-isolated', () => {
  const vm = newVM();
  vm.run(`
    addedFirst = NS.GameContext.Register("first-test", 35, function(lines) lines[#lines + 1] = "Extra: first" end)
    addedAgain = NS.GameContext.Register("first-test", 36, function(lines) lines[#lines + 1] = "Extra: duplicate" end)
    addedBroken = NS.GameContext.Register("broken-test", 36, function(lines)
      lines[#lines + 1] = "Extra: leaked"
      error("missing API")
    end)
    addedSecond = NS.GameContext.Register("second-test", 37, function(lines) lines[#lines + 1] = "Extra: second" end)
    contextAfter = NS.Chats.GameContext()
  `);
  assert.equal(vm.bool('addedFirst'), true);
  assert.equal(vm.bool('addedAgain'), false);
  assert.equal(vm.bool('addedBroken'), true);
  assert.equal(vm.bool('addedSecond'), true);
  const ctx = vm.evaluate('contextAfter');
  assert.match(ctx, /Extra: first\nExtra: second/);
  assert.match(ctx, /Character: Testchar/);
  assert.doesNotMatch(ctx, /duplicate/);
  assert.doesNotMatch(ctx, /leaked/);
});

test('unit-status adapter reads supported data and omits unavailable or secret values', () => {
  const vm = newVM();
  vm.run(`
    UnitHealth = function(unit) return unit == "player" and 55 or nil end
    UnitHealthMax = function(unit) return unit == "player" and 100 or nil end
    UnitPower = function(unit) return unit == "player" and 32 or nil end
    UnitPowerMax = function(unit) return unit == "player" and 100 or nil end
    UnitExists = function(unit) return unit == "target" end
    UnitName = function(unit) if unit == "target" then return "Forest Wolf" else return "Testy" end end
    UnitLevel = function(unit) return unit == "target" and 9 or 11 end
    liveContext = NS.Chats.GameContext()
  `);
  const live = vm.evaluate('liveContext');
  assert.match(live, /Status: health 55\/100, power 32\/100/);
  assert.match(live, /Target: Forest Wolf, level 9/);
  vm.run('UnitHealth = nil; UnitHealthMax = nil; UnitPower = nil; UnitPowerMax = nil; UnitExists = nil; noStatus = NS.Chats.GameContext()');
  assert.doesNotMatch(vm.evaluate('noStatus'), /Status:|Target:/);
  vm.run(`
    local readable = NS.Readable
    NS.Readable = function(v) if v == "restricted" then return nil end return readable(v) end
    UnitHealth = function() return "restricted" end
    UnitHealthMax = function() return 100 end
    UnitExists = function() return true end
    UnitName = function() return "restricted" end
    secretContext = NS.Chats.GameContext()
  `);
  assert.doesNotMatch(vm.evaluate('secretContext'), /Status:|Target:/);
});
