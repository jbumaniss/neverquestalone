-- On-question faction standings; nil means no game data, never neutral by default.
local _, ns = ...
local F = ns.ContextFacts

local function collect(lines, Try)
	local count = F.Number(Try, GetNumFactions)
	if not count then return end
	local parts = {}
	for i = 1, math.min(count, 100) do
		local name, _, standing, lo, hi, value, _, _, isHeader = Try(GetFactionInfo, i)
		name = F.Text(name, 32)
		if name and isHeader ~= true and type(standing) == "number" and #parts < 10 then
			local line = name .. " standing " .. standing
			if type(lo) == "number" and type(hi) == "number" and hi > lo and type(value) == "number" then
				line = line .. " (" .. (value - lo) .. "/" .. (hi - lo) .. ")"
			end
			parts[#parts + 1] = line
		end
	end
	F.Add(lines, "Reputation", parts)
end

ns.GameContext.Register("reputation", 44, collect, F.Relevant({ "reputation", "faction standing", "rep grind", "honored", "revered", "exalted" }))
