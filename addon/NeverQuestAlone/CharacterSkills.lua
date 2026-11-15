-- CharacterSkills.lua: a single read-only owner for primary and secondary skills.
local _, ns = ...
local S = {}
ns.CharacterSkills = S

local PROFESSION_SKILL_IDS = {
	[164] = true, [165] = true, [171] = true, [182] = true, [186] = true, [197] = true, [202] = true,
	[333] = true, [393] = true, [129] = true, [185] = true, [356] = true,
}

function S.Lines()
	local out = {}
	if type(C_SkillInfo) == "table" and C_SkillInfo.GetNumSkillLines then
		local n = ns.Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = ns.Try(C_SkillInfo.GetSkillLineInfo, i)
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = ns.Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local name, isHeader, _, rank, _, _, maxRank = ns.Try(GetSkillLineInfo, i)
		if type(name) == "string" then
			out[#out + 1] = { name = name, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank }
		end
	end
	return out
end

function S.Professions()
	local header, out = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(S.Lines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			out[#out + 1] = { name = sk.name, rank = sk.rank, max = sk.maxRank }
		end
	end
	return out
end
