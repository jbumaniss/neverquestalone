import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newVM } = require('./helpers/nqa-vm.js');

const context = (vm, question) => {
  vm.run(`resultContext = NS.Chats.GameContext(${JSON.stringify(question)})`);
  return vm.evaluate('resultContext');
};

test('on-question collectors remain absent from ordinary context', () => {
  const vm = newVM();
  const text = context(vm, 'hello');
  assert.doesNotMatch(text, /Bags:|Spellbook:|Reputation:|Equipped:|Movement:|Collections:|Open services:/);
});

test('bags collect bounded counts, distinguishing no data from zero', () => {
  const vm = newVM();
  vm.run(`C_Container = {
    GetContainerNumSlots = function(bag) return bag == 0 and 3 or 0 end,
    GetContainerItemInfo = function(bag, slot)
      if bag ~= 0 then return nil end
      if slot == 1 then return { itemID = 42, stackCount = 3 } end
      if slot == 2 then return { itemID = 42, stackCount = 2 } end
      if slot == 3 then return { itemID = 8, stackCount = 1 } end
    end,
  }`);
  assert.match(context(vm, 'what is in my bags?'), /Bags: 2 types, 6 items/);
  vm.run('C_Container = nil; GetContainerNumSlots = nil; GetContainerItemInfo = nil');
  assert.doesNotMatch(context(vm, 'my inventory'), /Bags:/);
});

test('spellbook and spent talents collect supported values independently', () => {
  const vm = newVM();
  vm.run(`
    GetNumSpellTabs = function() return 1 end
    GetSpellTabInfo = function() return 'General', nil, 0, 2 end
    GetSpellBookItemInfo = function(i) return 'SPELL', 100 + i end
    GetSpellBookItemName = function(i) return i == 1 and 'Stealth' or 'Sinister Strike' end
    GetSpellCooldown = function() return nil end
    GetNumTalentTabs = function() return 1 end
    GetNumTalents = function() return 2 end
    GetTalentInfo = function(t, i) return i == 1 and 'Improved Eviscerate' or 'Deflection', nil, nil, nil, i == 1 and 2 or 0 end
  `);
  assert.match(context(vm, 'my spells and abilities'), /Spellbook: 2 learned spells/);
  assert.match(context(vm, 'my talent build'), /Spent talents: Improved Eviscerate 2/);
});

test('faction standings and live group/combat do not invent other-player names', () => {
  const vm = newVM();
  vm.run(`
    GetNumFactions = function() return 1 end
    GetFactionInfo = function() return 'Stormwind', nil, 5, 3000, 9000, 4200, nil, nil, false end
    GetNumGroupMembers = function() return 2 end
    IsInRaid = function() return false end
    UnitExists = function(u) return u == 'party1' end
    UnitClass = function() return 'Rogue', 'ROGUE' end
    UnitLevel = function() return 11 end
    UnitGroupRolesAssigned = function() return 'DAMAGER' end
    UnitAffectingCombat = function() return true end
    UnitBuff = function(u, i) return i == 1 and 'Sprint' or nil end
    UnitDebuff = function() return nil end
  `);
  assert.match(context(vm, 'reputation with Stormwind'), /Reputation: Stormwind standing 5 \(1200\/6000\)/);
  assert.match(context(vm, 'my party'), /Party: 2 members/);
  assert.match(context(vm, 'my combat buffs'), /Combat: in combat, buffs: Sprint/);
});

test('equipment, movement and open service facts require a relevant question', () => {
  const vm = newVM();
  vm.run(`
    GetInventoryItemID = function(_, slot) return slot == 16 and 123 or nil end
    GetInventoryItemLink = function(_, slot) return slot == 16 and '|Hitem:123|h[Fine Dagger]|h' or nil end
    GetDetailedItemLevelInfo = function() return 12 end
    GetUnitSpeed = function() return 7 end
    GetPlayerFacing = function() return math.pi end
    IsMounted = function() return true end
    BankFrame = { IsShown = function() return true end }
    GetContainerNumSlots = function(bag) return bag == -1 and 28 or 0 end
  `);
  assert.match(context(vm, 'my equipped gear'), /Equipped: mainhand Fine Dagger/);
  assert.match(context(vm, 'my movement speed'), /Movement: speed 7\.0 units\/s, mounted, facing 180 degrees/);
  assert.match(context(vm, 'my bank'), /Open services: bank open \(28 base slots\)/);
});

test('open bank and mailbox expose bounded item and message details only on request', () => {
  const vm = newVM();
  vm.run(`
    BankFrame = { IsShown = function() return true end }
    MailFrame = { IsShown = function() return true end }
    C_Container = {
      GetContainerNumSlots = function(bag) return bag == -1 and 1 or 0 end,
      GetContainerItemInfo = function(bag, slot) return bag == -1 and slot == 1 and { itemID = 123, stackCount = 8 } or nil end,
    }
    GetInboxNumItems = function() return 1 end
    GetInboxHeaderInfo = function() return nil, nil, 'Sender', 'Auction won', 0, 0, 12, 2 end
  `);
  assert.match(context(vm, 'what is in my bank?'), /1 bank item types, .* x8/);
  assert.match(context(vm, 'what mail is waiting?'), /mail 1 Auction won \(2 attachments\)/);
  assert.doesNotMatch(context(vm, 'hello'), /Open services:/);
});

test('optional collections and auction adapters omit unsupported facts', () => {
  const vm = newVM();
  vm.run(`
    GetNumCompanions = function(kind) return kind == 'MOUNT' and 2 or 4 end
    GetNumCompletedAchievements = function() return 7 end
  `);
  assert.match(context(vm, 'my mounts and achievements'), /Collections: 2 mounts in companion list, 4 companion pets, 7 completed achievements/);
  assert.doesNotMatch(context(vm, 'auction price of item 123'), /Auctionator:/);
});

test('multi-return WoW APIs keep faction header, mail attachment and mount-collected fields', () => {
  const vm = newVM();
  vm.run(`
    GetNumFactions = function() return 2 end
    GetFactionInfo = function(i)
      if i == 1 then return 'Alliance', nil, 5, 0, 3000, 0, nil, nil, true end
      return 'Stormwind', nil, 5, 0, 3000, 100, nil, nil, false
    end
    C_MountJournal = {
      GetMountIDs = function() return { 101, 102 } end,
      GetMountInfoByID = function(id)
        return id == 101 and 'Brown Horse' or 'Black Horse', nil, nil, nil, nil, nil, nil, nil, nil, nil, id == 101
      end,
    }
  `);
  assert.match(context(vm, 'my reputation'), /Reputation: Stormwind standing 5/);
  assert.doesNotMatch(context(vm, 'my reputation'), /Alliance standing/);
  assert.match(context(vm, 'my mount collection'), /1 collected mounts/);
});

test('a large optional inventory cannot displace the complete quest-id line', () => {
  const vm = newVM();
  vm.run(`
    C_Container = {
      GetContainerNumSlots = function() return 20 end,
      GetContainerItemInfo = function(bag, slot) return { itemID = bag * 20 + slot + 1, stackCount = 20 } end,
    }
  `);
  const text = context(vm, 'what is in my bags?');
  assert.match(text, /Bags:/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 900, 'optional game data fits the bounded context');
  assert.doesNotMatch(text, /undefined|nil/);
});
