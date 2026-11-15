-- On-question collections. Classic clients often expose no journal; omit unavailable facts.
local _, ns = ...
local F = ns.ContextFacts

local function collect(lines, Try)
	local parts = {}
	local journal = C_MountJournal
	local mounts = journal and Try(journal.GetMountIDs)
	if type(mounts) == "table" then
		local known = 0
		for _, id in ipairs(mounts) do
			local _, _, _, _, _, _, _, _, _, _, collected = Try(journal.GetMountInfoByID, id)
			if collected == true then known = known + 1 end
		end
		parts[#parts + 1] = known .. " collected mounts"
	else
		local count = F.Number(Try, GetNumCompanions, "MOUNT")
		if count then parts[#parts + 1] = count .. " mounts in companion list" end
	end
	local pets = F.Number(Try, GetNumCompanions, "CRITTER")
	if pets then parts[#parts + 1] = pets .. " companion pets" end
	local achievements = F.Number(Try, GetNumCompletedAchievements)
	if achievements then parts[#parts + 1] = achievements .. " completed achievements" end
	F.Add(lines, "Collections", parts)
end

ns.GameContext.Register("collections", 44, collect, F.Relevant({ "mount", "pet", "collection", "achievement", "companion" }))
