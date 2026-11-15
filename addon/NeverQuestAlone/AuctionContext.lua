-- Prices are local Auctionator index estimates, never live auction listings.
local _, ns = ...
local F = ns.ContextFacts

local function collect(lines, Try, _, _, question)
	local id = type(question) == "string" and tonumber(question:match("item:(%d+)") or question:match("item%s+#?(%d+)"))
	if not id or not ns.Integrations then return end
	local price = ns.Integrations.AuctionPrice(id)
	if type(price) ~= "number" or price < 0 then return end
	local age = ns.Integrations.AuctionPriceAge(id)
	local parts = { "item #" .. id .. " estimate " .. math.floor(price) .. " copper" }
	if type(age) == "number" and age >= 0 then parts[#parts + 1] = "index age " .. age end
	F.Add(lines, "Auctionator", parts)
end

ns.GameContext.Register("auction-price", 44, collect,
	F.Relevant({ "auction", "market price", "worth", "price of", "sell for" }))
