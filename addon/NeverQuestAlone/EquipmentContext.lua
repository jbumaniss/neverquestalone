-- On-question equipped-item names/stats, complementing linked-item tooltip expansion.
local _, ns = ...
local F = ns.ContextFacts
local SLOT = { "head", "neck", "shoulder", "shirt", "chest", "waist", "legs", "feet", "wrist", "hands",
  "ring1", "ring2", "trinket1", "trinket2", "back", "mainhand", "offhand", "ranged", "tabard" }

local function collect(lines, Try)
	local parts, total = {}, 0
	for slot = 1, 19 do
		local id = F.Number(Try, GetInventoryItemID, "player", slot)
		if id and id > 0 then
			total = total + 1
			if #parts < 10 then
				local link = Try(GetInventoryItemLink, "player", slot)
				local name = type(link) == "string" and F.Text(link:match("|h%[([^%]]+)%]|h"), 28)
				local item = SLOT[slot] .. " " .. (name or ("item " .. id)) .. " (#" .. id .. ")"
				local level = F.Number(Try, GetDetailedItemLevelInfo, link or id)
				if level then item = item .. " ilvl " .. level end
					local stats = Try(GetItemStats, link or id)
					if type(stats) == "table" then
						local values = {}
						for key, value in pairs(stats) do
							if type(key) == "string" and type(value) == "number" and value > 0 then
								values[#values + 1] = F.Text(key, 20) .. " +" .. value
							end
						end
						table.sort(values)
						if #values > 0 then item = item .. " [" .. table.concat(values, "/", 1, math.min(3, #values)) .. "]" end
					end
				parts[#parts + 1] = item
			end
		end
	end
	if total > 10 then parts[#parts + 1] = (total - 10) .. " more slots not listed" end
	F.Add(lines, "Equipped", parts)
end

ns.GameContext.Register("equipped-details", 43, collect, F.Relevant({ "equipment", "equipped", "gear", "armor", "weapon", "stats", "item level", "upgrade" }))
