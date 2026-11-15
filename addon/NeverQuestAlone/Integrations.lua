-- Optional addon boundaries. NeverQuestAlone works with neither addon installed.
-- Only documented public APIs may be used; their failures must not interrupt chat.
local _, ns = ...
local I = {}
ns.Integrations = I

local function Loaded(name)
	local f = C_AddOns and C_AddOns.IsAddOnLoaded or IsAddOnLoaded
	if type(f) ~= "function" then return false end
	local ok, loaded = pcall(f, name)
	return ok and loaded == true
end

local function Public(name)
	if not Loaded(name) then return nil end
	local addon = _G[name]
	return type(addon) == "table" and addon or nil
end

function I.QuestieReady()
	local addon = Public("Questie")
	return addon ~= nil and type(addon.API) == "table" and addon.API.isReady == true
end

-- Last recorded auction scan, not a live price. Returns nil for missing data.
-- The supported Auctionator API returns copper, or nil for an unknown item.
function I.AuctionPrice(itemId)
	if type(itemId) ~= "number" or itemId ~= math.floor(itemId) or itemId <= 0 then return nil end
	local addon = Public("Auctionator")
	local api = addon and addon.API and addon.API.v1
	if type(api) ~= "table" or type(api.GetAuctionPriceByItemID) ~= "function" then return nil end
	local ok, price = pcall(api.GetAuctionPriceByItemID, "NeverQuestAlone", itemId)
	if not ok or type(price) ~= "number" or price < 0 or price ~= price then return nil end
	return math.floor(price)
end

function I.AuctionPriceAge(itemId)
	local addon = Public("Auctionator")
	local api = addon and addon.API and addon.API.v1
	if type(api) ~= "table" or type(api.GetAuctionAgeByItemID) ~= "function" then return nil end
	local ok, age = pcall(api.GetAuctionAgeByItemID, "NeverQuestAlone", itemId)
	if not ok or type(age) ~= "number" or age < 0 or age ~= age then return nil end
	return math.floor(age)
end
