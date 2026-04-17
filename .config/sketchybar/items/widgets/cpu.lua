local icons = require("icons")
local colors = require("colors")
local settings = require("settings")

local mem = sbar.add("graph", "widgets.cpu", 42, {
  position = "right",
  graph = { color = colors.blue },
  background = {
    height = 22,
    color = { alpha = 0 },
    border_color = { alpha = 0 },
    drawing = true,
  },
  icon = { string = icons.cpu },
  label = {
    string = "mem ??%",
    font = {
      family = settings.font.numbers,
      style = settings.font.style_map["Bold"],
      size = 9.0,
    },
    align = "right",
    padding_right = 0,
    width = 0,
    y_offset = 4
  },
  padding_right = settings.paddings + 6
})

local function update_memory()
  sbar.exec("memory_pressure | grep 'free percentage' | awk '{print $NF}' | tr -d '%'", function(output)
    local free = tonumber(output)
    if not free then return end
    local load = 100 - free
    mem:push({ load / 100. })

    local color = colors.blue
    if load > 30 then
      if load < 60 then
        color = colors.yellow
      elseif load < 80 then
        color = colors.orange
      else
        color = colors.red
      end
    end

    mem:set({
      graph = { color = color },
      label = "mem " .. math.floor(load) .. "%",
    })
  end)
end

mem:set({ update_freq = 5 })
mem:subscribe("routine", update_memory)
mem:subscribe("system_woke", update_memory)

update_memory()

mem:subscribe("mouse.clicked", function(env)
  sbar.exec("open -a 'Activity Monitor'")
end)

-- Background around the mem item
sbar.add("bracket", "widgets.cpu.bracket", { mem.name }, {
  background = { color = colors.bg1 }
})

sbar.add("item", "widgets.cpu.padding", {
  position = "right",
  width = settings.group_paddings
})
