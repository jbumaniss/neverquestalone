-- On-question group composition and readable combat effects, without other players' identities.
local _, ns = ...
local F = ns.ContextFacts

local function group(lines, Try)
	local count = F.Number(Try, GetNumGroupMembers)
	if not count or count == 0 then return end
	local parts = { count .. " members" }
	local role = F.Text(Try(UnitGroupRolesAssigned, "player"), 12)
	if role and role ~= "NONE" then parts[#parts + 1] = "my role " .. role end
	local inRaid = ns.Readable(Try(IsInRaid)) == true
	local prefix = inRaid and "raid" or "party"
	local seen = 0
	for i = 1, math.min(count, 40) do
		local unit = prefix .. i
		local exists = ns.Readable(Try(UnitExists, unit))
		if exists == true then
			seen = seen + 1
			if seen <= 10 then
				local _, class = Try(UnitClass, unit); class = ns.Readable(class)
				local level = F.Number(Try, UnitLevel, unit)
				local roleName = F.Text(Try(UnitGroupRolesAssigned, unit), 8)
				local desc = F.Text(class, 15) or "member"
				if level then desc = desc .. " " .. level end
				if roleName and roleName ~= "NONE" then desc = desc .. " " .. roleName end
				parts[#parts + 1] = desc
			end
		end
	end
	F.Add(lines, inRaid and "Raid" or "Party", parts)
end

local function auras(Try, unit, api, label, parts)
	if type(api) ~= "function" then return end
	local found = {}
	for i = 1, 16 do
		local name, _, count = Try(api, unit, i)
		name = F.Text(name, 28)
		if not name then break end
		found[#found + 1] = name .. (type(count) == "number" and count > 1 and (" x" .. count) or "")
		if #found >= 8 then break end
	end
	if #found > 0 then parts[#parts + 1] = label .. " " .. table.concat(found, "/") end
end

local function combat(lines, Try)
	local parts = {}
	local active = ns.Readable(Try(UnitAffectingCombat, "player"))
	if type(active) == "boolean" then parts[#parts + 1] = active and "in combat" or "out of combat" end
	auras(Try, "player", UnitBuff, "buffs:", parts)
	auras(Try, "player", UnitDebuff, "debuffs:", parts)
	F.Add(lines, "Combat", parts)
	if ns.Readable(Try(UnitExists, "target")) == true then
		local targetEffects = {}
		auras(Try, "target", UnitBuff, "buffs:", targetEffects)
		auras(Try, "target", UnitDebuff, "debuffs:", targetEffects)
		F.Add(lines, "Target effects", targetEffects)
	end
end

ns.GameContext.Register("group", 43, group, F.Relevant({ "party", "raid", "group", "dungeon team", "who is with me" }))
ns.GameContext.Register("combat-effects", 43, combat, F.Relevant({ "combat", "buff", "debuff", "poison", "effect", "status", "fight" }))
