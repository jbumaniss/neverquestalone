-- LinkContext.lua: pure link expansion coordination. Tooltip/game APIs stay in Chats.
-- Receives narrow callbacks so item, spell and achievement formatting keep one owner.
local _, ns = ...
local M = {}
ns.LinkContext = M

local LINK_BYTES_MAX = 900

local function priceBlock(payload)
	local itemId = tonumber(payload:match("^item:(%d+)"))
	if not itemId or not ns.Integrations then return nil end
	local price = ns.Integrations.AuctionPrice(itemId)
	if not price then return nil end
	local age = ns.Integrations.AuctionPriceAge(itemId)
	local result = "[Auctionator last scan] " .. ns.Int(price) .. " copper"
	if age then result = result .. " (" .. ns.Int(age) .. " day(s) old)" end
	return result
end

function M.Expand(text, level, describe, tooltipLines, equippedBlocks)
	local links, seen = {}, {}
	local function take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			links[#links + 1] = { payload = payload, name = name }
		end
		return "[" .. name .. "]"
	end
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", take)
	out = out:gsub("|cn[^:|]*:|H([^|]+)|h%[([^%]]*)%]|h|r", take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, link in ipairs(links) do
		local head = "[" .. link.name .. "] " .. describe(link.payload)
		local body = table.concat(tooltipLines(link.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > LINK_BYTES_MAX then block = ns.Utf8Cut(block, LINK_BYTES_MAX) .. "..." end
		blocks[#blocks + 1] = block
		local price = priceBlock(link.payload)
		if price then blocks[#blocks + 1] = price end
		local ok, equipped = pcall(equippedBlocks, link.payload, level)
		for _, eq in ipairs(ok and equipped or {}) do blocks[#blocks + 1] = eq end
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end
