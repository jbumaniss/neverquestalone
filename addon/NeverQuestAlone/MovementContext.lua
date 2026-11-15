-- Read-only movement hints; coordinates remain in GameContext's location collector.
local _, ns = ...
local F = ns.ContextFacts

local function collect(lines, Try)
	local parts = {}
	local speed = F.Number(Try, GetUnitSpeed, "player")
	if speed then parts[#parts + 1] = string.format("speed %.1f units/s", speed) end
	local mounted = ns.Readable(Try(IsMounted))
	if mounted == true then parts[#parts + 1] = "mounted" end
	local flying = ns.Readable(Try(IsFlying))
	if flying == true then parts[#parts + 1] = "flying" end
	local swimming = ns.Readable(Try(IsSwimming))
	if swimming == true then parts[#parts + 1] = "swimming" end
	local facing = F.Number(Try, GetPlayerFacing)
	if facing then parts[#parts + 1] = string.format("facing %.0f degrees", facing * 180 / math.pi) end
	F.Add(lines, "Movement", parts)
end

ns.GameContext.Register("movement", 43, collect, F.Relevant({ "moving", "movement", "speed", "facing", "direction", "travel mode", "mounted", "swimming" }))
