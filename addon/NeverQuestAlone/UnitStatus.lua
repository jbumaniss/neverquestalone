-- UnitStatus.lua: optional, read-only live player/target facts for AI context.
-- More capabilities register independently with ns.GameContext.Register.
local _, ns = ...

local function number(Try, api, unit)
	local v = ns.Readable(Try(api, unit))
	if type(v) == "number" and v >= 0 then return v end
end

local function status(lines, Try)
	local hp, maxHp = number(Try, UnitHealth, "player"), number(Try, UnitHealthMax, "player")
	local power, maxPower = number(Try, UnitPower, "player"), number(Try, UnitPowerMax, "player")
	local parts = {}
	if hp and maxHp and maxHp > 0 then parts[#parts + 1] = "health " .. hp .. "/" .. maxHp end
	if power and maxPower and maxPower > 0 then parts[#parts + 1] = "power " .. power .. "/" .. maxPower end
	if #parts > 0 then lines[#lines + 1] = "Status: " .. table.concat(parts, ", ") end

	local exists = ns.Readable(Try(UnitExists, "target"))
	if exists ~= true then return end
	local name = ns.Readable(Try(UnitName, "target"))
	if type(name) ~= "string" or name == "" then return end
	local level = number(Try, UnitLevel, "target")
	local target = "Target: " .. ns.CleanField(ns.Utf8Cut(name, 60))
	if level then target = target .. ", level " .. level end
	lines[#lines + 1] = target
end

ns.GameContext.Register("unit-status", 45, status)
