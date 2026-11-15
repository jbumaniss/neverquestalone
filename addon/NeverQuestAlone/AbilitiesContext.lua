-- On-question spellbook and invested talents; no spell casts or talent writes.
local _, ns = ...
local F = ns.ContextFacts

local function spells(lines, Try)
	local tabs = F.Number(Try, GetNumSpellTabs)
	if not tabs then return end
	local found, total = {}, 0
	local cooling = {}
	for tab = 1, math.min(tabs, 12) do
		local _, _, offset, count = Try(GetSpellTabInfo, tab)
		if type(offset) == "number" and type(count) == "number" then
			for i = offset + 1, math.min(offset + count, offset + 250) do
				local kind, id = Try(GetSpellBookItemInfo, i, BOOKTYPE_SPELL or "spell")
				if kind == "SPELL" and type(id) == "number" then
					total = total + 1
					if #found < 12 then
						local name = F.Text(Try(GetSpellBookItemName, i, BOOKTYPE_SPELL or "spell"), 28)
							or F.Text(Try(GetSpellInfo, id), 28)
						found[#found + 1] = (name or "spell") .. " (#" .. id .. ")"
					end
					local started, duration = Try(GetSpellCooldown, id)
					local now = F.Number(Try, GetTime)
					if type(started) == "number" and type(duration) == "number" and now
						and duration > 1.5 and started + duration > now and #cooling < 6 then
						cooling[#cooling + 1] = "#" .. id .. " " .. math.ceil(started + duration - now) .. "s"
					end
				end
			end
		end
	end
	if total > 0 then
		table.insert(found, 1, total .. " learned spells")
		if total > 12 then found[#found + 1] = (total - 12) .. " additional spells not listed" end
		F.Add(lines, "Spellbook", found)
		F.Add(lines, "Active cooldowns", cooling)
	end
end

local function talents(lines, Try)
	local tabs = F.Number(Try, GetNumTalentTabs)
	if not tabs then return end
	local parts = {}
	for tab = 1, math.min(tabs, 4) do
		local count = F.Number(Try, GetNumTalents, tab)
		for i = 1, math.min(count or 0, 40) do
			local name, _, _, _, rank = Try(GetTalentInfo, tab, i)
			name = F.Text(name, 28)
			if name and type(rank) == "number" and rank > 0 and #parts < 12 then
				parts[#parts + 1] = name .. " " .. rank
			end
		end
	end
	F.Add(lines, "Spent talents", parts)
end

ns.GameContext.Register("spellbook", 43, spells, F.Relevant({ "spell", "ability", "abilities", "skill rotation", "cooldown", "can i cast" }))
ns.GameContext.Register("talent-ranks", 43, talents, F.Relevant({ "talent", "build", "spec", "specialization" }))
