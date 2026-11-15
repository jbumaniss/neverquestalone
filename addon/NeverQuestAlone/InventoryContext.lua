-- On-question bags: bounded item counts, no protected inventory actions.
local _, ns = ...
local F = ns.ContextFacts

local function collect(lines, Try)
	local c = C_Container
	local slots = c and c.GetContainerNumSlots or GetContainerNumSlots
	local info = c and c.GetContainerItemInfo or GetContainerItemInfo
	if type(slots) ~= "function" or type(info) ~= "function" then return end
	local counts, order, total = {}, {}, 0
	for bag = 0, 4 do
		local count = F.Number(Try, slots, bag)
		if count then
			for slot = 1, math.min(count, 40) do
				local item = Try(info, bag, slot)
				local id, amount
				if type(item) == "table" then
					id = F.Number(Try, function() return item.itemID end)
					amount = F.Number(Try, function() return item.stackCount end)
				elseif item ~= nil then -- classic API returns a texture (not an item id) first
					id = F.Number(Try, (c and c.GetContainerItemID) or GetContainerItemID, bag, slot)
					amount = select(2, Try(info, bag, slot))
				end
				if id and id > 0 then
					if not counts[id] then counts[id] = 0; order[#order + 1] = id end
					counts[id] = counts[id] + (type(amount) == "number" and amount > 0 and amount or 1)
					total = total + (type(amount) == "number" and amount > 0 and amount or 1)
				end
			end
		end
	end
	local items = {}
	for i = 1, math.min(#order, 10) do
		local id = order[i]
		local name = F.Text(Try((C_Item and C_Item.GetItemNameByID) or GetItemInfo, id), 28)
		items[#items + 1] = (name or ("item " .. id)) .. " x" .. counts[id] .. " (#" .. id .. ")"
	end
	if #order > 0 then
		table.insert(items, 1, #order .. " types, " .. total .. " items")
		if #order > 10 then items[#items + 1] = (#order - 10) .. " more types not listed" end
		F.Add(lines, "Bags", items)
	end
end

ns.GameContext.Register("inventory", 42, collect, F.Relevant({ "bag", "inventory", "carrying", "have any", "how many item", "material", "reagent" }))
