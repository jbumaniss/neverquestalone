-- On-question services: only currently visible/open bank, vendor or mailbox facts.
local _, ns = ...
local F = ns.ContextFacts

local function visible(frame)
	return type(frame) == "table" and type(frame.IsShown) == "function" and ns.Try(frame.IsShown, frame) == true
end

local function collect(lines, Try)
	local parts = {}
	if visible(BankFrame) then
		local slots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
		local count = F.Number(Try, slots, -1)
		parts[#parts + 1] = "bank open" .. (count and (" (" .. count .. " base slots)") or "")
		local itemInfo = (C_Container and C_Container.GetContainerItemInfo) or GetContainerItemInfo
		local idInfo = (C_Container and C_Container.GetContainerItemID) or GetContainerItemID
		if type(slots) == "function" and type(itemInfo) == "function" then
			local found = {}
			for _, bag in ipairs({ -1, 5, 6, 7, 8, 9, 10, 11 }) do
				local n = F.Number(Try, slots, bag)
				for slot = 1, math.min(n or 0, 40) do
					local info = Try(itemInfo, bag, slot)
					local id = type(info) == "table" and F.Number(Try, function() return info.itemID end) or F.Number(Try, idInfo, bag, slot)
					if id and id > 0 then
						local count = type(info) == "table" and F.Number(Try, function() return info.stackCount end) or select(2, Try(itemInfo, bag, slot))
						found[id] = (found[id] or 0) + (type(count) == "number" and count > 0 and count or 1)
					end
				end
			end
			local ids = {}
			for id in pairs(found) do ids[#ids + 1] = id end
			table.sort(ids)
			if #ids > 0 then parts[#parts + 1] = #ids .. " bank item types" end
			for i = 1, math.min(#ids, 5) do
				local id = ids[i]
				local name = F.Text(Try((C_Item and C_Item.GetItemNameByID) or GetItemInfo, id), 20)
				parts[#parts + 1] = (name or ("#" .. id)) .. " x" .. found[id]
			end
		end
	end
	if visible(MailFrame) then
		local count = F.Number(Try, GetInboxNumItems)
		parts[#parts + 1] = "mailbox open" .. (count and (" (" .. count .. " inbox entries)") or "")
		if count then
			for i = 1, math.min(count, 3) do
				local _, _, _, subject, _, _, _, attachments = Try(GetInboxHeaderInfo, i)
				subject = F.Text(subject, 28)
				if subject then parts[#parts + 1] = "mail " .. i .. " " .. subject .. (type(attachments) == "number" and (" (" .. attachments .. " attachments)") or "") end
			end
		end
	end
	if visible(MerchantFrame) then
		local count = F.Number(Try, GetMerchantNumItems)
		parts[#parts + 1] = "vendor open" .. (count and (" (" .. count .. " offers)") or "")
		if count then
			for i = 1, math.min(count, 5) do
				local name, _, copper = Try(GetMerchantItemInfo, i)
				name = F.Text(name, 25)
				if name and type(copper) == "number" and copper >= 0 then
					parts[#parts + 1] = name .. " " .. copper .. " copper"
				end
			end
		end
	end
	F.Add(lines, "Open services", parts)
end

ns.GameContext.Register("open-services", 44, collect, F.Relevant({ "bank", "mail", "inbox", "vendor", "merchant", "sell", "buy from" }))
