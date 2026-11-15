-- GameContext.lua: read-only game facts for AI turns; independent of chat lifecycle.
local _, ns = ...
local G = {}
ns.GameContext = G

local function client(lines, Try)
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)
end

local function character(lines, Try)
	local name = ns.Readable(Try(UnitName, "player"))
	if name then
		local realm = Try(GetRealmName)
		local level = Try(UnitLevel, "player")
		local race = Try(UnitRace, "player")
		local class = Try(UnitClass, "player")
		local faction = Try(UnitFactionGroup, "player")
		local guild = Try(GetGuildInfo, "player")
		local who = "Character: " .. tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
		local desc = {}
		if level then table.insert(desc, "level " .. tostring(level)) end
		if race then table.insert(desc, tostring(race)) end
		if class then table.insert(desc, tostring(class)) end
		if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
		if faction then who = who .. " (" .. tostring(faction) .. ")" end
		if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
		table.insert(lines, who)
	end
end

local function location(lines, Try)
	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""))
	end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end
end

local function questie(lines, Try)
	-- Public Questie objective marker: advisory context only, no quest automation.
	local isPlayer = Try(UnitIsPlayer, "target")
	if ns.Integrations and not ns.IsSecret(isPlayer) and not isPlayer then
		local guid = ns.Readable(Try(UnitGUID, "target"))
		if ns.Integrations.QuestieTargetObjective(guid) then
			local targetName = ns.Readable(Try(UnitName, "target"))
			if targetName then table.insert(lines, "Questie: target " .. targetName .. " is marked as a quest objective") end
		end
	end
	if ns.DungeonContext then
		for _, line in ipairs(ns.DungeonContext.Lines()) do table.insert(lines, line) end
	end
end

local function progress(lines, Try, Money)
	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(progress, "XP: " .. xp .. "/" .. xpMax)
	end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end
end

local function talents(lines, Try)
	-- Classic-style talent tabs: name, icon, points spent.
	local tabs = Try(GetNumTalentTabs)
	if type(tabs) == "number" and tabs > 0 then
		local parts = {}
		for i = 1, tabs do
			local tname, _, points = Try(GetTalentTabInfo, i)
			if type(tname) == "string" and type(points) == "number" then
				table.insert(parts, tname .. " " .. points)
			end
		end
		if #parts > 0 then table.insert(lines, "Talents: " .. table.concat(parts, " / ")) end
	end
end

local function professions(lines, Professions)
	-- Skill lines under the Professions and Secondary Skills headers.
	local parts = {}
	for _, pr in ipairs(Professions()) do
		table.insert(parts, pr.name .. (pr.rank and (" " .. tostring(pr.rank) .. (pr.max and ("/" .. tostring(pr.max)) or "")) or ""))
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end
end

local function questLog()
	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply: every quest in the log
	-- (ns.QuestLog: under a collapsed header too; headers and hidden quests
	-- aren't quests), after its count against the game's cap, so Bones never
	-- takes the list for a cut one. The bridge writes the same line from the
	-- state (context.mjs withState).
	local quests = {}
	local list, meta = ns.QuestLog()
	for _, q in ipairs(list) do table.insert(quests, tostring(q.id) .. (q.complete and "*" or "")) end
	local questLine
	if #quests > 0 or meta.unread > 0 then
		questLine = "Quest log (id, * = ready to turn in): " .. ns.QuestCountPhrase(meta.count, meta.max, meta.unread)
			.. (#quests > 0 and (": " .. table.concat(quests, ",")) or "")
	end
	return questLine
end

local function fit(lines, questLine)
	-- At most CONTEXT_MAX bytes, but the quest line is never cut, nor the Game
	-- and Character lines (the bridge uses a context only with one of them): the
	-- lines between go, whole, from the last. Only a log past any client's cap
	-- (some 110 quests) takes the context over CONTEXT_MAX.
	local s = ns.CleanField(table.concat(lines, "\n"))
	if not questLine then return ns.Utf8Cut(s, ns.CONTEXT_MAX) end
	questLine = ns.CleanField(questLine)
	while #lines > 2 and #s + 1 + #questLine > ns.CONTEXT_MAX do
		table.remove(lines)
		s = ns.CleanField(table.concat(lines, "\n"))
	end
	if #lines <= 2 then s = ns.Utf8Cut(s, math.max(ns.CONTEXT_MAX - 1 - #questLine, math.min(#s, 240))) end
	return s ~= "" and (s .. "\n" .. questLine) or questLine
end

function G.Build(Try, Money, Professions)
	local lines = {}
	client(lines, Try)
	character(lines, Try)
	location(lines, Try)
	questie(lines, Try)
	progress(lines, Try, Money)
	talents(lines, Try)
	professions(lines, Professions)
	return fit(lines, questLog())
end
