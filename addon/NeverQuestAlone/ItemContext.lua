-- ItemContext.lua: read-only tooltip and equipment details for linked game items.
-- No addon writes or tooltip frames: only the client's tooltip data API.
local _, ns = ...
local I = {}
ns.ItemContext = I

local SLOT_NAMES = { "head", "neck", "shoulder", "shirt", "chest", "waist", "legs", "feet", "wrist", "hands",
	"finger 1", "finger 2", "trinket 1", "trinket 2", "back", "main hand", "off hand", "ranged", "tabard" }
local EQUIP_SLOTS = {
	INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_BODY = { 4 },
	INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 }, INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 },
	INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 }, INVTYPE_FINGER = { 11, 12 },
	INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPON = { 16, 17 },
	INVTYPE_2HWEAPON = { 16, 17 }, INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 },
	INVTYPE_SHIELD = { 17 }, INVTYPE_HOLDABLE = { 17 }, INVTYPE_RANGED = { 18 }, INVTYPE_RANGEDRIGHT = { 18 },
	INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 }, INVTYPE_TABARD = { 19 },
}
I.EQUIP_SLOTS = EQUIP_SLOTS

function I.TooltipLines(payload)
	local lines = {}
	local get = type(C_TooltipInfo) == "table" and C_TooltipInfo.GetHyperlink
	local ok, data = false, nil
	if type(get) == "function" then ok, data = pcall(get, payload) end
	if not ok or type(data) ~= "table" or type(data.lines) ~= "table" then return lines end
	for i = 1, math.min(#data.lines, 30) do
		local line = data.lines[i]
		if type(line) == "table" then
			if line.leftText == nil and line.args and TooltipUtil and TooltipUtil.SurfaceArgs then pcall(TooltipUtil.SurfaceArgs, line) end
			local l = ns.Trim(ns.Chats.StripEscapes(type(line.leftText) == "string" and line.leftText or ""))
			local r = ns.Trim(ns.Chats.StripEscapes(type(line.rightText) == "string" and line.rightText or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then lines[#lines + 1] = l end
		end
	end
	return lines
end

function I.Describe(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local result = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = ns.Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then result = result .. " (" .. desc .. ")" end
	end
	return result
end

function I.Equipped(payload, level)
	if not payload:match("^item:%d+") then return {} end
	local _, _, _, equipLoc = ns.Try(C_Item and C_Item.GetItemInfoInstant, payload)
	local slots = type(equipLoc) == "string" and EQUIP_SLOTS[equipLoc]
	if not slots then return {} end
	local out = {}
	for _, slot in ipairs(slots) do
		local link = ns.Try(GetInventoryItemLink, "player", slot)
		local id = ns.Try(GetInventoryItemID, "player", slot)
		if type(link) == "string" or type(id) == "number" then
			local name = type(link) == "string" and link:match("|h%[([^%]]*)%]|h") or nil
			id = id or (type(link) == "string" and tonumber(link:match("item:(%d+)")))
			local ilvl = ns.Companion and ns.Companion.Call("ItemLevel", slot, link)
			local parts = {}
			if level < 2 and name then parts[#parts + 1] = name end
			if id then parts[#parts + 1] = "item " .. ns.Int(id) end
			if ilvl then parts[#parts + 1] = "item level " .. ns.Int(ilvl) end
			local block = "[Equipped: " .. SLOT_NAMES[slot] .. "] " .. table.concat(parts, ", ")
			if level == 0 and type(link) == "string" then
				local lp = link:match("|H(item:[^|]+)|h")
				local tip = lp and table.concat(I.TooltipLines(lp), "\n  ") or ""
				if tip ~= "" then
					if #tip > 600 then tip = ns.Utf8Cut(tip, 600) .. "..." end
					block = block .. "\n  " .. tip
				end
			end
			out[#out + 1] = block
		end
	end
	return out
end
