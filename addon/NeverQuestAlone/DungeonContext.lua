-- DungeonContext.lua: read-only encounter context for advisory replies.
-- Never targets, casts, queues, moves, rolls or uses any protected gameplay action.
local _, ns = ...
local D = {}
ns.DungeonContext = D

local function call(f, ...)
	if type(f) ~= "function" then return nil end
	local ok, a, b, c = pcall(f, ...)
	if ok then return a, b, c end
end

function D.Lines()
	local lines = {}
	local inside, kind = call(IsInInstance)
	if inside == true then
		local name, instanceType, difficulty = call(GetInstanceInfo)
		local label = ns.Readable(name) or "unknown"
		local typeName = (type(instanceType) == "string" and instanceType ~= "") and instanceType or kind or "instance"
		lines[#lines + 1] = "Instance: " .. label .. " (" .. tostring(typeName) .. ")"
		if type(difficulty) == "number" and difficulty > 0 then lines[#lines + 1] = "Instance difficulty id: " .. ns.Int(difficulty) end
	end
	local members = call(GetNumGroupMembers)
	if type(members) ~= "number" or members == 0 then
		local party = call(GetNumPartyMembers)
		if type(party) == "number" and party > 0 then members = party + 1 end
	end
	if type(members) == "number" and members > 0 then
		lines[#lines + 1] = "Group members: " .. ns.Int(members)
		local role = call(UnitGroupRolesAssigned, "player")
		if role == "TANK" or role == "HEALER" or role == "DAMAGER" then
			lines[#lines + 1] = "My group role: " .. role
		end
	end
	local isPlayer = call(UnitIsPlayer, "target")
	if not ns.IsSecret(isPlayer) and not isPlayer then
		local target = ns.Readable(call(UnitName, "target"))
		local level = call(UnitLevel, "target")
		local classification = call(UnitClassification, "target")
		if target and (inside or classification == "elite" or classification == "worldboss" or classification == "rareelite") then
			local extra = {}
			if type(level) == "number" and level >= 0 then extra[#extra + 1] = "level " .. ns.Int(level) end
			if classification == "elite" or classification == "worldboss" or classification == "rareelite" then extra[#extra + 1] = classification end
			lines[#lines + 1] = "Encounter target: " .. target .. (#extra > 0 and (" (" .. table.concat(extra, ", ") .. ")") or "")
		end
	end
	return lines
end
